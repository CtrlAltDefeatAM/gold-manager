// =======================================================
// UNIVERSAL GOLD MANAGER (v1.0.6)
// System: dnd5e (system.currency.*)
// Coin math stays in whole copper so balances cannot drift.
// =======================================================

const MODULE_ID = "gold-manager";
const GENERIC_ICON = "icons/svg/coins.svg";
const LEDGER_NAME = "Gold Manager Ledger";
const DENOMINATIONS = ["cp", "sp", "ep", "gp", "pp"];
const RATES = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
const DEFAULT_SETTINGS = {
    gmOnly: false,
    playerSeeAll: false,
    soundSrc: "sounds/lock.wav",
    publicExchange: true
};
const PLAYER_COLORS = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b"
];
const LANG = {
    TITLE: "GOLD MANAGER D&D 5e ┇ CtrlAltDefeat",
    SETTINGS: "Settings",
    LEDGER: "View Ledger",
    TGT_ALL: "All",
    TGT_SEL: "Selected",
    TGT_SGL: "Single",
    BTN_ADD: "Add",
    BTN_REM: "Remove",
    BTN_SET: "Set",
    BTN_XFER: "Transfer",
    BTN_EXCH: "Exchange",
    BTN_CONVERT: "CONVERT",
    BTN_UNDO: "Undo",
    PH_AMT: "Amount...",
    PH_NOTE: "Reason (Loot, Service...)",
    LBL_SPLIT: "Split Amount"
};

const selfUpdates = new Set();
const priorCurrency = new WeakMap();
let ledgerChain = Promise.resolve();
let ledgerPromise = null;
let hooksReady = false;
let hotkeyReady = false;
let stylesReady = false;
let updateQueue = [];
let debounceTimer = null;

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    }[ch]));
}

function coinValue(value) {
    if (value && typeof value === "object" && "value" in value) value = value.value;
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.round(number));
}

function readWallet(actor) {
    const wallet = {};
    for (const key of DENOMINATIONS) {
        wallet[key] = coinValue(foundry.utils.getProperty(actor, `system.currency.${key}`));
    }
    return wallet;
}

function walletToCopper(wallet) {
    return DENOMINATIONS.reduce((total, key) => total + (coinValue(wallet[key]) * RATES[key]), 0);
}

function copperToWallet(copper) {
    let remaining = coinValue(copper);
    const wallet = {};
    for (const key of ["pp", "gp", "ep", "sp", "cp"]) {
        wallet[key] = Math.floor(remaining / RATES[key]);
        remaining %= RATES[key];
    }
    return wallet;
}

function getSetting(key) {
    try {
        return game.settings.get(MODULE_ID, key);
    } catch (err) {
        return DEFAULT_SETTINGS[key];
    }
}

async function saveSetting(key, value) {
    await game.settings.set(MODULE_ID, key, value);
}

function playSound() {
    try {
        const src = getSetting("soundSrc");
        if (!src) return;
        const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
        helper?.play({ src, volume: 0.8, autoplay: true, loop: false }, true);
    } catch (err) {
        console.warn("Gold Manager sound failed:", err);
    }
}

function getValidActors() {
    const seeAll = game.user.isGM || getSetting("playerSeeAll");
    const characters = game.actors.contents.filter((actor) => actor.type === "character");
    const party = characters.filter((actor) => (seeAll ? actor.hasPlayerOwner : actor.isOwner));
    const list = party.length ? party : characters.filter((actor) => actor.isOwner);
    return list.sort((a, b) => a.name.localeCompare(b.name));
}

function canEditActor(actor) {
    return !!actor && (game.user.isGM || actor.isOwner);
}

function flagFromUpdate(data, key) {
    const nested = foundry.utils.getProperty(data, `flags.${MODULE_ID}.${key}`);
    if (nested && typeof nested === "object") return nested;
    const block = data?.flags?.[MODULE_ID];
    if (block?.[key] && typeof block[key] === "object") return block[key];
    return null;
}

function isResponsibleGM() {
    if (!game.user.isGM) return false;
    const active = game.users.activeGM ?? game.users.find((user) => user.isGM && user.active);
    return !active || active.id === game.user.id;
}

function activeGMOnline() {
    return game.users.activeGM ?? game.users.find((user) => user.isGM && user.active) ?? null;
}

let gmQueue = Promise.resolve();
function queueGM(task) {
    const job = gmQueue.then(task);
    gmQueue = job.catch((err) => console.error("Gold Manager GM handoff failed:", err));
    return job;
}

async function rememberRelayUndo(userId, nonce, entries) {
    const current = foundry.utils.duplicate(game.settings.get(MODULE_ID, "relayUndo") || {});
    current[nonce] = { userId, entries, at: Date.now() };
    const keys = Object.keys(current).sort((a, b) => (current[a]?.at || 0) - (current[b]?.at || 0));
    while (keys.length > 30) delete current[keys.shift()];
    await game.settings.set(MODULE_ID, "relayUndo", current);
}

async function appendUserUndo(user, entry) {
    const stored = foundry.utils.duplicate(user.getFlag("world", "goldUndoHistory") || []);
    const history = Array.isArray(stored) ? stored : [];
    history.push(entry);
    await user.setFlag("world", "goldUndoHistory", history.slice(-10));
}

function postTransferReceipt(source, dest, amount, type, note, whisperTo) {
    const listHtml = `<table style="width:100%; font-size:11px; border-collapse:collapse; color:#000000 !important; background:#ffffff !important;"><tr><td style="padding:3px; color:#000000 !important; background:#ffffff !important;">${escapeHtml(source.name)}</td><td style="text-align:right; font-weight:bold; color:#000000 !important; background:#ffffff !important;">-${amount} ${type.toUpperCase()}</td></tr><tr><td style="padding:3px; color:#000000 !important; background:#ffffff !important;">${escapeHtml(dest.name)}</td><td style="text-align:right; font-weight:bold; color:#000000 !important; background:#ffffff !important;">+${amount} ${type.toUpperCase()}</td></tr></table>`;
    const message = {
        content: makeCard("Transfer", `<div style="text-align:center; margin-bottom:5px; color:#000000 !important; background:#ffffff !important;">${escapeHtml(note || "Transfer")}</div>${listHtml}`, true),
        speaker: { alias: "Gold Manager" }
    };
    if (whisperTo) message.whisper = [whisperTo];
    ChatMessage.create(message);
}

async function fulfillCredit(source, oldWallet, credit, userId) {
    if (!isResponsibleGM()) return;
    if (!oldWallet) {
        console.warn("Gold Manager could not verify a transfer from", source?.name);
        return;
    }
    const amount = coinValue(credit?.amount);
    const type = credit?.type;
    const dest = game.actors.get(credit?.destId);
    const sender = game.users.get(userId);
    const newWallet = readWallet(source);
    const paid = (oldWallet[type] ?? 0) - (newWallet[type] ?? 0);
    const tampered = DENOMINATIONS.some((key) => key !== type && newWallet[key] !== oldWallet[key]);
    const ownsSource = !!sender && source.testUserPermission(sender, "OWNER");
    const alreadyDelivered = dest?.getFlag(MODULE_ID, "applied") === credit?.nonce;
    const acceptable = !!dest && !!sender && !!RATES[type] && amount > 0 && paid === amount && !tampered && ownsSource && !sender.isGM && !getSetting("gmOnly") && !alreadyDelivered;

    try {
        if (acceptable) {
            const destBefore = readWallet(dest);
            await setCurrency(dest, destBefore[type] + amount, type);
            await dest.setFlag(MODULE_ID, "applied", credit.nonce);
            await rememberRelayUndo(userId, credit.nonce, [
                { id: source.id, type: "all", val: oldWallet },
                { id: dest.id, type: "all", val: destBefore }
            ]);
            await appendUserUndo(sender, { relayNonce: credit.nonce, sourceId: source.id });
            postTransferReceipt(source, dest, amount, type, credit.note);
            logTransaction(source.name, "Transfer Out", `${amount} ${type.toUpperCase()}`, `To ${dest.name}`);
            logTransaction(dest.name, "Transfer In", `${amount} ${type.toUpperCase()}`, `From ${source.name}`);
        } else if (paid !== 0 || tampered) {
            await writeCurrency(source, oldWallet);
            ChatMessage.create({
                content: makeCard("Transfer Cancelled", "The coins were returned because the transfer could not be delivered.", false),
                speaker: { alias: "Gold Manager" },
                whisper: [userId]
            });
        }
    } finally {
        if (source.getFlag(MODULE_ID, "credit")) await source.unsetFlag(MODULE_ID, "credit");
    }
}

async function fulfillUndo(actor, request, userId) {
    if (!isResponsibleGM()) return;
    const nonce = request?.nonce;
    try {
        const book = foundry.utils.duplicate(game.settings.get(MODULE_ID, "relayUndo") || {});
        const record = book[nonce];
        if (!record || record.userId !== userId || !Array.isArray(record.entries)) return;
        for (const entry of record.entries) {
            const target = game.actors.get(entry.id);
            if (target && entry.val && typeof entry.val === "object") await writeCurrency(target, entry.val);
        }
        delete book[nonce];
        await game.settings.set(MODULE_ID, "relayUndo", book);
        const sender = game.users.get(userId);
        if (sender) {
            const stored = foundry.utils.duplicate(sender.getFlag("world", "goldUndoHistory") || []);
            const history = Array.isArray(stored) ? stored.filter((entry) => entry?.relayNonce !== nonce) : [];
            await sender.setFlag("world", "goldUndoHistory", history);
        }
        ChatMessage.create({
            content: makeCard("Undo Successful", "Transaction reverted.", false),
            speaker: { alias: "Gold Manager" },
            whisper: [userId]
        });
        logTransaction("System", "UNDO", "-", "Reverted last action");
    } finally {
        if (actor.getFlag(MODULE_ID, "undo")) await actor.unsetFlag(MODULE_ID, "undo");
    }
}

function walletSnapshot(actor) {
    return { id: actor.id, type: "all", val: readWallet(actor) };
}

async function pushUndo(entries) {
    const stored = foundry.utils.duplicate(game.user.getFlag("world", "goldUndoHistory") || []);
    const history = Array.isArray(stored) ? stored : [];
    history.push(entries);
    await game.user.setFlag("world", "goldUndoHistory", history.slice(-10));
}

async function writeCurrency(actor, wallet) {
    const clean = {};
    for (const key of DENOMINATIONS) clean[key] = coinValue(wallet[key]);
    selfUpdates.add(actor.id);
    try {
        return await actor.update({ "system.currency": clean }, { fromUniversalGold: true });
    } finally {
        selfUpdates.delete(actor.id);
    }
}

async function setCurrency(actor, value, type) {
    const wallet = readWallet(actor);
    wallet[type] = coinValue(value);
    return writeCurrency(actor, wallet);
}

function getOrCreateLedger() {
    if (ledgerPromise) return ledgerPromise;
    ledgerPromise = ensureLedger().finally(() => { ledgerPromise = null; });
    return ledgerPromise;
}

async function ensureLedger() {
    let journal = game.journal.getName(LEDGER_NAME);
    if (!journal) {
        if (!game.user.isGM) return null;
        journal = await JournalEntry.create({
            name: LEDGER_NAME,
            ownership: { default: 0 }
        });
        await journal.createEmbeddedDocuments("JournalEntryPage", [{
            name: "Log",
            type: "text",
            text: {
                format: 1,
                content: `<h1>Gold Transaction Ledger</h1><table border="1" style="width:100%; border-collapse: collapse; font-family: monospace;"><thead><tr style="background:#222; color:#fff;"><th>Time</th><th>User</th><th>Character</th><th>Action</th><th>Amount</th><th>Reason</th></tr></thead><tbody></tbody></table>`
            }
        }]);
        return journal;
    }
    const ownership = journal.ownership ?? {};
    const playersCanSee = (ownership.default ?? 0) > 0 || Object.entries(ownership).some(([key, level]) => {
        if (key === "default" || Number(level) <= 0) return false;
        return !game.users.get(key)?.isGM;
    });
    if (game.user.isGM && playersCanSee) {
        try {
            await journal.update({ ownership: { default: 0 } });
        } catch (err) {
            console.warn("Gold Manager could not restrict the ledger to the GM:", err);
        }
    }
    return journal;
}

function clipLedgerText(value, max) {
    return String(value ?? "").slice(0, max);
}

function logTransaction(actorName, action, amountString, reason, userName = game.user.name) {
    const entry = {
        actorName: clipLedgerText(actorName, 120),
        action: clipLedgerText(action, 80),
        amountString: clipLedgerText(amountString, 80),
        reason: clipLedgerText(reason, 200),
        userName: clipLedgerText(userName, 80),
        nonce: foundry.utils.randomID()
    };
    const write = game.user.isGM ? () => appendLedgerRow(entry) : () => enqueuePlayerLedger(entry);
    const job = ledgerChain.then(write);
    ledgerChain = job.catch((err) => console.error("Gold Manager Ledger Error:", err));
    return job;
}

async function enqueuePlayerLedger(entry) {
    const current = foundry.utils.duplicate(game.user.getFlag(MODULE_ID, "ledgerQueue") || []);
    const list = Array.isArray(current) ? current : [];
    list.push(entry);
    await game.user.setFlag(MODULE_ID, "ledgerQueue", list.slice(-30));
}

async function drainPlayerLedger(user, queue) {
    if (!isResponsibleGM()) return;
    const entries = Array.isArray(queue) ? queue : [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const job = ledgerChain.then(() => appendLedgerRow(entry));
        ledgerChain = job.catch((err) => console.error("Gold Manager Ledger Error:", err));
        await job;
    }
    const processed = new Set(entries.map((entry) => entry?.nonce).filter(Boolean));
    const latest = foundry.utils.duplicate(user.getFlag(MODULE_ID, "ledgerQueue") || []);
    const remain = (Array.isArray(latest) ? latest : []).filter((entry) => !processed.has(entry?.nonce));
    if (remain.length) await user.setFlag(MODULE_ID, "ledgerQueue", remain);
    else if (user.getFlag(MODULE_ID, "ledgerQueue")) await user.unsetFlag(MODULE_ID, "ledgerQueue");
}

async function appendLedgerRow(entry) {
    if (!game.user.isGM) return;
    let journal = game.journal.getName(LEDGER_NAME);
    if (!journal) journal = await getOrCreateLedger();
    if (!journal || !journal.testUserPermission(game.user, "OWNER")) return;
    const page = journal.pages?.contents?.[0];
    if (!page) return;
    const actorName = entry?.actorName;
    const action = entry?.action;
    const amountString = entry?.amountString;
    const reason = entry?.reason;

    const rowHtml = `<tr style="border-bottom:1px solid #444;">
        <td style="padding:4px;">${escapeHtml(new Date().toLocaleString())}</td>
        <td style="padding:4px;">${escapeHtml(entry?.userName || game.user.name)}</td>
        <td style="padding:4px; font-weight:bold; color:${getActorColor(actorName)};">${escapeHtml(actorName)}</td>
        <td style="padding:4px;">${escapeHtml(action)}</td>
        <td style="padding:4px; font-weight:bold;">${escapeHtml(amountString)}</td>
        <td style="padding:4px; font-style:italic;">${escapeHtml(reason)}</td>
    </tr>`;

    let content = page.text?.content || "";
    content = content.includes("</tbody>")
        ? content.replace("</tbody>", `${rowHtml}</tbody>`)
        : `${content}${rowHtml}`;
    await page.update({ "text.content": content });
}

function getActorColor(name) {
    if (!name) return "#ccc";
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

async function showLedger() {
    if (!game.user.isGM) {
        ui.notifications.warn("Only the GM can view the ledger.");
        return;
    }
    const journal = await getOrCreateLedger();
    if (journal) journal.sheet.render(true);
    else ui.notifications.warn("Ledger missing. The GM must open Gold Manager once.");
}

function makeCard(title, messageHtml, highlight = false) {
    const borderColor = highlight ? "#047857" : "#1d4ed8";
    return `
    <div class="gm-chat-card" style="all: initial; display: block; box-sizing: border-box; width: 100%; background: #ffffff !important; background-color: #ffffff !important; border: 1px solid ${borderColor}; border-radius: 8px; color: #000000 !important; font-family: 'Signika', sans-serif; font-size: 12px; overflow: hidden; text-shadow: none !important;">
      <div style="background: #ffffff !important; background-color: #ffffff !important; border-bottom: 1px solid #d1d5db; padding: 6px; font-weight: bold; text-align: center; text-transform: uppercase; letter-spacing: 1px; color: #000000 !important;">${escapeHtml(title)}</div>
      <div style="background: #ffffff !important; background-color: #ffffff !important; padding: 8px; color: #000000 !important;">${messageHtml}</div>
    </div>`;
}

function injectStyles() {
    if (stylesReady || document.getElementById("gm-gold-styles")) {
        stylesReady = true;
        return;
    }
    stylesReady = true;
    const style = document.createElement("style");
    style.id = "gm-gold-styles";
    style.textContent = `
        .gold-manager-window .window-content { padding: 0 !important; background: transparent !important; overflow: hidden !important; }
        .gold-manager-window .dialog-buttons { display: none !important; }
        .gm-win { width: 350px; background: #0f172a; border: 2px solid #fbbf24; border-radius: 12px; padding: 12px; box-shadow: 0 0 10px rgba(0,0,0,0.5); color: #e2e8f0; font-family: 'Signika', sans-serif; font-size: 12px; position: relative; overflow: hidden; transform: translateZ(0); backface-visibility: hidden; }
        .gm-head { font-family: 'Cinzel', serif; font-size: 16px; font-weight: 900; text-align: center; color: #fbbf24; text-shadow: 0 0 5px rgba(251, 191, 36, 0.5); border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 10; }
        .gm-coin-fx { position: absolute; top: -20px; width: 10px; height: 10px; background: #fbbf24; border-radius: 50%; border: 1px solid #b45309; z-index: 5; will-change: transform, opacity; transform: translateZ(0); animation: gm-fall linear forwards; pointer-events: none; }
        @keyframes gm-fall { 0% { transform: translateY(0) rotate(0deg); opacity: 1; } 100% { transform: translateY(400px) rotate(360deg); opacity: 0; } }
        .gm-floating-text { position: fixed; transform: translate(-50%, -50%); font-size: 24px; font-weight: 900; font-family: 'Signika'; pointer-events: none; z-index: 9999; -webkit-text-stroke: 1px #000; will-change: transform, opacity; animation: gm-float-anim 1.5s ease-out forwards; }
        @keyframes gm-float-anim { 0% { opacity: 0; margin-top: 0; transform: translate(-50%, -50%) scale(0.5); } 15% { opacity: 1; margin-top: -20px; transform: translate(-50%, -50%) scale(1.2); } 100% { opacity: 0; margin-top: -100px; transform: translate(-50%, -50%) scale(1); } }
        .gm-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; position: relative; z-index: 10; }
        .gm-label { flex: 0 0 50px; font-weight: bold; color: #fbbf24; text-transform: uppercase; font-size: 10px; letter-spacing: 1px; }
        .gm-input, .gm-select { background: #000 !important; color: #fff !important; border: 1px solid #475569; border-radius: 4px; height: 28px; padding: 0 5px; width: 100%; outline: none; }
        .gm-select option { background: #000; color: #fff; }
        .gm-input:focus { border-color: #fbbf24; box-shadow: 0 0 5px #fbbf24; }
        .gm-btn-group { display: flex; gap: 4px; margin-bottom: 8px; position: relative; z-index: 10; }
        .gm-qbtn { flex: 1; background: #1e293b; border: 1px solid #475569; color: #94a3b8; border-radius: 4px; cursor: pointer; font-size: 10px; padding: 4px; text-align: center; transition: all 0.2s; }
        .gm-qbtn:hover { background: #fbbf24; color: #000; border-color: #fff; font-weight: bold; }
        .gm-action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 15px; position: relative; z-index: 10; }
        .gm-act-btn { padding: 8px; border-radius: 6px; font-weight: bold; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); color: #fff; display: flex; justify-content: center; gap: 5px; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; transition: filter 0.2s; align-items: center; }
        .gm-act-btn:hover { filter: brightness(1.2); }
        .gm-act-btn.disabled { filter: grayscale(1); pointer-events: none; opacity: 0.7; cursor: not-allowed; }
        .btn-add { background: linear-gradient(180deg, #065f46, #064e3b); border-color: #10b981; }
        .btn-rem { background: linear-gradient(180deg, #7f1d1d, #7f1d1d); border-color: #ef4444; }
        .btn-set { background: linear-gradient(180deg, #1e3a8a, #172554); border-color: #3b82f6; }
        .btn-xfer { background: linear-gradient(180deg, #7c3aed, #5b21b6); border-color: #8b5cf6; }
        .btn-exch { background: linear-gradient(180deg, #0891b2, #164e63); border-color: #22d3ee; grid-column: span 2; }
        #gm-exchange-panel { display: none; margin-top: 15px; padding: 10px; background: rgba(0,0,0,0.2); border: 1px dashed #22d3ee; border-radius: 6px; position: relative; z-index: 10; }
        .btn-convert { width: 100%; background: linear-gradient(180deg, #0891b2, #164e63); border-color: #22d3ee; margin-top: 8px; }
        .btn-back { width: 100%; margin-top: 5px; background: #334155; border: 1px solid #64748b; color: #cbd5e1; font-size: 10px; padding: 4px; border-radius: 4px; cursor: pointer; text-align: center; }
        .btn-back:hover { background: #475569; color: white; }
        .btn-undo { width: 100%; margin-top: 8px; background: #334155; border: 1px solid #64748b; color: #cbd5e1; position: relative; z-index: 10; }
        .btn-undo:hover { background: #475569; color: white; }
        .ledger-btn, .settings-btn { font-size: 14px; cursor: pointer; color: #64748b; transition: color 0.2s; }
        .settings-btn:hover, .ledger-btn:hover { color: #fbbf24; }
        .gm-calc-win { padding: 8px; background: #0f172a; border-radius: 6px; border: 1px solid #fbbf24; }
        #calc-display { background: #000; color: #fbbf24; font-family: monospace; font-size: 18px; font-weight: bold; text-align: right; padding: 8px; border: 1px solid #475569; border-radius: 4px; margin-bottom: 8px; height: 38px; white-space: nowrap; overflow: hidden; display: flex; align-items: center; justify-content: flex-end; }
        .calc-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
        .calc-btn { background: #334155; color: #e2e8f0; border: 1px solid #475569; padding: 10px 0; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 14px; text-align: center; transition: all 0.1s; user-select: none; display: flex; align-items: center; justify-content: center; }
        .calc-btn:hover { background: #475569; color: #fff; border-color: #fbbf24; }
        .calc-btn:active { background: #fbbf24; color: #000; }
        .calc-btn.op { background: #1e293b; color: #fbbf24; border-color: #fbbf24; }
        .calc-btn.action { background: #7f1d1d; color: #fff; border-color: #ef4444; }
        .calc-btn.eq { background: #065f46; color: #fff; border-color: #10b981; grid-row: span 2; }
        .calc-btn.zero { grid-column: span 2; }
        .gm-footer { text-align: center; font-size: 10px; margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); opacity: 0.95; display: flex; justify-content: center; gap: 15px; position: relative; z-index: 10; }
        .gm-footer a { text-decoration: none; display: flex; align-items: center; gap: 4px; font-weight: bold; position: relative; padding: 2px 6px; border-radius: 8px; transition: filter 0.2s, text-shadow 0.2s, box-shadow 0.2s, transform 0.2s; }
        .gm-footer a::after { content: ""; position: absolute; left: 10%; right: 10%; bottom: -3px; height: 2px; border-radius: 999px; background: currentColor; opacity: 0.35; filter: blur(0.6px); box-shadow: 0 0 10px currentColor; }
        .gm-footer a:hover { filter: brightness(1.35); transform: translateY(-1px); text-shadow: 0 0 8px currentColor, 0 0 14px rgba(255,255,255,0.15); box-shadow: 0 0 10px rgba(255,255,255,0.12), 0 0 18px currentColor; }
        .link-patreon { color: #f97316; }
        .link-discord { color: #5865F2; }
        .gm-settings-form { padding: 10px; color: #000 !important; font-family: 'Signika'; font-size: 13px; }
        .gm-settings-form .form-group { margin-bottom: 8px; display: flex; align-items: center; }
        .gm-settings-form label { flex: 1; font-weight: bold; color: #000 !important; }
        .gm-settings-form .notes { font-size: 11px; color: #444 !important; margin: -4px 0 10px 0; font-style: italic; display: block; }
        .gm-settings-form input[type="text"] { width: 100%; background: #fff; color: #000; border: 1px solid #999; padding: 4px; border-radius: 4px; }
        #chat-log .message-content .gm-chat-card,
        #chat-log .message-content .gm-chat-card * {
            color: #000000 !important;
            background-color: #ffffff !important;
            text-shadow: none !important;
        }
    `;
    document.head.appendChild(style);
}

function triggerCoinShower(html) {
    const container = html.find(".gm-win")[0];
    if (!container) return;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 15; i++) {
        const coin = document.createElement("div");
        coin.classList.add("gm-coin-fx");
        const duration = 0.5 + Math.random() * 0.7;
        const delay = Math.random() * 0.3;
        coin.style.left = `${Math.random() * 95}%`;
        coin.style.animationDuration = `${duration}s`;
        coin.style.animationDelay = `${delay}s`;
        fragment.appendChild(coin);
        setTimeout(() => { if (coin.parentNode) coin.remove(); }, (duration + delay) * 1000);
    }
    container.appendChild(fragment);
}

function triggerFloatingText(html, text, color) {
    const win = html.closest(".window-app");
    if (!win.length) return;
    const rect = win[0].getBoundingClientRect();
    const el = document.createElement("div");
    el.innerText = text;
    el.classList.add("gm-floating-text");
    el.style.color = color;
    el.style.textShadow = `0 0 3px #000, 0 0 10px ${color}`;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top = `${rect.top + rect.height / 2}px`;
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 1500);
}

function registerOverseer() {
    if (hooksReady) return;
    hooksReady = true;

    Hooks.on("preUpdateActor", (actor, data, options) => {
        if (actor?.type !== "character") return;
        const currencyChange = foundry.utils.hasProperty(data, "system.currency");
        const creditChange = !!flagFromUpdate(data, "credit");
        const undoChange = !!flagFromUpdate(data, "undo");
        if (!currencyChange && !creditChange && !undoChange) return;
        if ((options?.fromUniversalGold || selfUpdates.has(actor.id)) && !creditChange && !undoChange) return;
        priorCurrency.set(actor, readWallet(actor));
    });

    Hooks.on("updateActor", (actor, data, options, userId) => {
        const oldC = priorCurrency.get(actor);
        const currencyChange = foundry.utils.hasProperty(data, "system.currency");
        const credit = flagFromUpdate(data, "credit");
        const undoRequest = flagFromUpdate(data, "undo");
        if (oldC && (currencyChange || credit || undoRequest)) priorCurrency.delete(actor);
        if (credit) queueGM(() => fulfillCredit(actor, oldC, credit, userId));
        if (undoRequest) queueGM(() => fulfillUndo(actor, undoRequest, userId));
        if (!oldC || !currencyChange || actor?.type !== "character") return;
        if (options?.fromUniversalGold || selfUpdates.has(actor.id) || credit || undoRequest) return;
        if (!isResponsibleGM()) return;

        const newC = readWallet(actor);
        const changes = [];
        for (const key of DENOMINATIONS) {
            const diff = newC[key] - oldC[key];
            if (!diff) continue;
            const sign = diff > 0 ? "+" : "";
            changes.push(`${sign}${diff} ${key.toUpperCase()}`);
        }
        if (!changes.length) return;

        updateQueue.push({
            name: actor.name,
            change: changes.join(", "),
            userName: game.users.get(userId)?.name || "Unknown"
        });
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const batch = updateQueue.splice(0);
            let msgHtml = `<div style="text-align:center; font-size:11px; color:#000000 !important; background:#ffffff !important;">`;
            for (const entry of batch) {
                msgHtml += `<div><b>${escapeHtml(entry.name)}:</b> ${escapeHtml(entry.change)}</div>`;
                logTransaction(entry.name, "Manual Edit", entry.change, "Sheet Edit", entry.userName);
            }
            msgHtml += `</div>`;
            ChatMessage.create({
                content: makeCard("Manual Adjustment", msgHtml, false),
                speaker: { alias: "Gold Manager" }
            });
        }, 200);
    });

    Hooks.on("updateUser", (user, data) => {
        const queue = flagFromUpdate(data, "ledgerQueue");
        if (queue) queueGM(() => drainPlayerLedger(user, queue));
    });
}

function registerHotkey() {
    if (hotkeyReady) return;
    hotkeyReady = true;
    document.addEventListener("keydown", (event) => {
        if (event.repeat || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key !== "G" && event.key !== "g") return;
        const tag = event.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return;
        event.preventDefault();
        event.stopPropagation();
        openGoldManager();
    });
}

async function migrateLegacySettings() {
    if (!game.user.isGM || game.settings.get(MODULE_ID, "legacyMigrated")) return;
    const legacy = game.user.getFlag("world", "goldManagerSettings");
    if (legacy && typeof legacy === "object") {
        if (typeof legacy.gmOnly === "boolean") await saveSetting("gmOnly", legacy.gmOnly);
        if (typeof legacy.playerSeeAll === "boolean") await saveSetting("playerSeeAll", legacy.playerSeeAll);
        if (typeof legacy.soundSrc === "string") await saveSetting("soundSrc", legacy.soundSrc);
        if (typeof legacy.publicExchange === "boolean") await saveSetting("publicExchange", legacy.publicExchange);
    }
    await saveSetting("legacyMigrated", true);
}

async function normalizeMacroIcons() {
    if (!game.user.isGM) return;
    const macros = game.macros.filter((macro) => {
        const command = macro.command || "";
        return command.includes("gold-manager") && command.includes(".api");
    });
    for (const macro of macros) {
        const img = macro.img || "";
        const custom = img.includes("splash") || img.includes("gold-manager/assets") || img === "icons/commodities/currency/coins-plain-gold.webp";
        if (custom && img !== GENERIC_ICON) await macro.update({ img: GENERIC_ICON });
    }
}

function bindApi() {
    window.GoldManager = window.GoldManager || {};
    window.GoldManager.toggle = openGoldManager;
    window.GoldManager.render = openGoldManager;
}

export function initGoldManager() {
    const setting = (key, type, def) => {
        const fullKey = `${MODULE_ID}.${key}`;
        if (game.settings.settings.has(fullKey)) return;
        game.settings.register(MODULE_ID, key, {
            scope: "world",
            config: false,
            type,
            default: def
        });
    };
    setting("gmOnly", Boolean, false);
    setting("playerSeeAll", Boolean, false);
    setting("soundSrc", String, DEFAULT_SETTINGS.soundSrc);
    setting("publicExchange", Boolean, true);
    setting("legacyMigrated", Boolean, false);
    setting("relayUndo", Object, {});
}

export async function readyGoldManager() {
    injectStyles();
    bindApi();
    registerHotkey();
    registerOverseer();
    await migrateLegacySettings();
    await normalizeMacroIcons();
    if (isResponsibleGM()) await getOrCreateLedger();
}

function showCalculator(targetInput) {
    let expr = "";
    const updateDisplay = (displayEl) => { displayEl.text(expr || "0"); };
    const safeEval = (str) => {
        try {
            const sanitized = String(str).replace(/[^0-9+\-*/().]/g, "");
            if (!sanitized) return "Err";
            const result = new Function(`"use strict"; return (${sanitized})`)();
            if (!Number.isFinite(result)) return "Err";
            return Math.round(result * 1000) / 1000;
        } catch (err) {
            return "Err";
        }
    };

    new Dialog({
        title: "Calc",
        content: `
        <div class="gm-calc-win">
            <div id="calc-display">0</div>
            <div class="calc-grid">
                <div class="calc-btn action" data-key="C" title="Clear All">C</div>
                <div class="calc-btn action" data-key="DEL" title="Delete Last">⌫</div>
                <div class="calc-btn op" data-key="/">/</div>
                <div class="calc-btn op" data-key="*">*</div>
                <div class="calc-btn" data-key="7">7</div>
                <div class="calc-btn" data-key="8">8</div>
                <div class="calc-btn" data-key="9">9</div>
                <div class="calc-btn op" data-key="-">-</div>
                <div class="calc-btn" data-key="4">4</div>
                <div class="calc-btn" data-key="5">5</div>
                <div class="calc-btn" data-key="6">6</div>
                <div class="calc-btn op" data-key="+">+</div>
                <div class="calc-btn" data-key="1">1</div>
                <div class="calc-btn" data-key="2">2</div>
                <div class="calc-btn" data-key="3">3</div>
                <div class="calc-btn eq" data-key="=" title="Calculate">=</div>
                <div class="calc-btn zero" data-key="0">0</div>
                <div class="calc-btn" data-key=".">.</div>
            </div>
        </div>`,
        buttons: {},
        render: (html) => {
            html = $(html);
            const display = html.find("#calc-display");
            const processInput = (key) => {
                if (key === "C") { expr = ""; targetInput.val(""); }
                else if (key === "DEL" || key === "Backspace") expr = expr.toString().slice(0, -1);
                else if (key === "=" || key === "Enter") {
                    const result = safeEval(expr);
                    if (result !== "Err") { expr = String(result); targetInput.val(expr); }
                    else expr = "Err";
                } else {
                    if (expr === "Err") expr = "";
                    expr += key;
                }
                updateDisplay(display);
            };
            html.find(".calc-btn").on("click", (event) => { processInput($(event.currentTarget).data("key")); });
            html.on("keydown", (event) => {
                const key = event.key;
                const valid = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "*", "/", "(", ")", "=", "Enter", "Backspace", "c", "C"];
                if (!valid.includes(key)) return;
                event.preventDefault();
                event.stopPropagation();
                let mapped = key;
                if (key.toLowerCase() === "c") mapped = "C";
                if (key === "Backspace") mapped = "DEL";
                processInput(mapped);
            });
        }
    }, { width: 220, height: "auto" }).render(true);
}

function showSettings() {
    const current = {
        gmOnly: !!getSetting("gmOnly"),
        playerSeeAll: !!getSetting("playerSeeAll"),
        soundSrc: getSetting("soundSrc") || "",
        publicExchange: getSetting("publicExchange") !== false
    };
    new Dialog({
        title: "Gold Manager Settings",
        content: `
        <div class="gm-settings-form">
            <div class="form-group"><label>GM Only Mode</label><input type="checkbox" id="set-gmOnly" ${current.gmOnly ? "checked" : ""}></div>
            <span class="notes">If checked, players cannot run this macro.</span>
            <div class="form-group"><label>Treasurer Mode</label><input type="checkbox" id="set-seeAll" ${current.playerSeeAll ? "checked" : ""}></div>
            <span class="notes">Players can see every player character. They can edit characters they own. A transfer to someone they do not own is delivered by the active GM after their own coins are removed.</span>
            <div class="form-group"><label>Public Exchange Log</label><input type="checkbox" id="set-publicExchange" ${current.publicExchange ? "checked" : ""}></div>
            <span class="notes">Visible receipts for currency exchange.</span>
            <div class="form-group" style="display:block;"><label style="display:block; margin-bottom:4px;">Sound File</label><input type="text" id="set-sound" value="${escapeHtml(current.soundSrc)}"></div>
            <span class="notes">Path to audio file (e.g. sounds/lock.wav).</span>
        </div>`,
        buttons: {
            save: {
                label: "Save",
                callback: async (html) => {
                    html = $(html);
                    await saveSetting("gmOnly", html.find("#set-gmOnly").is(":checked"));
                    await saveSetting("playerSeeAll", html.find("#set-seeAll").is(":checked"));
                    await saveSetting("publicExchange", html.find("#set-publicExchange").is(":checked"));
                    await saveSetting("soundSrc", html.find("#set-sound").val());
                    ui.notifications.info("Settings Saved.");
                }
            }
        }
    }).render(true);
}

export async function openGoldManager() {
    bindApi();
    injectStyles();

    if (!game.user.isGM && getSetting("gmOnly")) {
        if (window.GoldManager.app?.rendered) window.GoldManager.app.close();
        ui.notifications.warn("Gold Manager: Access Restricted.");
        return;
    }
    if (window.GoldManager.app?.rendered) {
        window.GoldManager.app.close();
        return;
    }

    const validActors = getValidActors();
    if (!validActors.length) return ui.notifications.warn("No controllable characters found.");
    if (game.user.isGM) getOrCreateLedger();

    const defaultActorId = game.user.character?.id || validActors[0]?.id;
    const optionsHtml = validActors.map((actor) => `<option value="${escapeHtml(actor.id)}" ${actor.id === defaultActorId ? "selected" : ""}>${escapeHtml(actor.name)}</option>`).join("");
    const isGM = game.user.isGM;
    const canSelectMode = isGM || getSetting("playerSeeAll");
    const displayTargetBlock = canSelectMode ? "flex" : "none";
    const defaultTargetDisplay = canSelectMode ? "none" : "block";
    const patreonName = ["P", "a", "t", "r", "e", "o", "n"].join("");
    const discordName = ["D", "i", "s", "c", "o", "r", "d"].join("");
    const patreonUrl = `https://www.${patreonName.toLowerCase()}.com/Ctrl_Alt_Defeat`;
    const discordUrl = `https://${discordName.toLowerCase()}.gg/fBf7xw2bmB`;

    const dialogContent = `
    <div class="gm-win">
      <div class="gm-head">
          <span style="flex:1;"></span>
          <span>${LANG.TITLE}</span>
          <span style="flex:1; display:flex; justify-content:flex-end; gap:10px; align-items:center;">
            ${isGM ? `<i class="fas fa-book ledger-btn" id="btn-ledger" title="${LANG.LEDGER}"></i>` : ""}
            ${isGM ? `<i class="fas fa-cog settings-btn" id="btn-settings" title="${LANG.SETTINGS}"></i>` : ""}
          </span>
      </div>
      <div class="gm-row" style="display:${displayTargetBlock};">
        <div class="gm-label">TARGET</div>
        <div style="flex:1; display:flex; justify-content:space-between; font-size:11px;">
          <label><input type="radio" name="gm-gold-mode" value="all" checked> ${LANG.TGT_ALL}</label>
          <label><input type="radio" name="gm-gold-mode" value="selected"> ${LANG.TGT_SEL}</label>
          <label><input type="radio" name="gm-gold-mode" value="single"> ${LANG.TGT_SGL}</label>
        </div>
      </div>
      <div class="gm-row" id="row-target-select" style="display:${defaultTargetDisplay};">
        <select id="gm-gold-target" class="gm-select">${optionsHtml}</select>
      </div>
      <div class="gm-row">
        <div class="gm-label">AMOUNT</div>
        <input type="text" id="gm-gold-amount" class="gm-input" placeholder="${LANG.PH_AMT}" autofocus>
        <select id="gm-gold-type" class="gm-select" style="width:60px; text-align:center; font-weight:bold;">
            <option value="pp">PP</option><option value="gp" selected>GP</option><option value="ep">EP</option><option value="sp">SP</option><option value="cp">CP</option>
        </select>
        <i class="fas fa-calculator" id="gm-calc-open" title="Open Calculator" style="margin-left:5px; cursor:pointer; color:#fbbf24;"></i>
      </div>
      <div class="gm-btn-group">
        <div class="gm-qbtn" data-val="50">50</div><div class="gm-qbtn" data-val="100">100</div><div class="gm-qbtn" data-val="500">500</div><div class="gm-qbtn" data-val="5000">5k</div><div class="gm-qbtn" data-val="50000">50k</div>
      </div>
      <div class="gm-row">
        <div id="row-split" style="flex:1; visibility:${canSelectMode ? "visible" : "hidden"}; font-size:11px;">
          <label><input type="checkbox" id="gm-gold-split"> ${LANG.LBL_SPLIT}</label>
        </div>
        <input type="text" id="gm-gold-note" class="gm-input" placeholder="${LANG.PH_NOTE}" style="flex:1.5;">
      </div>
      <div id="gm-main-actions" class="gm-action-grid">
        <div class="gm-act-btn btn-add" id="btn-add" title="Add currency to target(s)"><i class="fas fa-plus"></i> ${LANG.BTN_ADD}</div>
        <div class="gm-act-btn btn-rem" id="btn-rem" title="Deduct currency from target(s)"><i class="fas fa-minus"></i> ${LANG.BTN_REM}</div>
        <div class="gm-act-btn btn-set" id="btn-set" title="Force balance to exact amount"><i class="fas fa-equals"></i> ${LANG.BTN_SET}</div>
        <div class="gm-act-btn btn-xfer" id="btn-xfer" title="Send currency to another character"><i class="fas fa-exchange-alt"></i> ${LANG.BTN_XFER}</div>
        <div class="gm-act-btn btn-exch" id="btn-exch-open" title="Convert currency types (e.g. GP to SP)"><i class="fas fa-coins"></i> ${LANG.BTN_EXCH}</div>
      </div>
      <div id="gm-exchange-panel">
          <div class="gm-row">
              <div class="gm-label">TO</div>
              <select id="gm-exch-to" class="gm-select">
                <option value="pp">PP</option><option value="gp">GP</option><option value="ep">EP</option><option value="sp">SP</option><option value="cp">CP</option>
              </select>
          </div>
          <div class="gm-act-btn btn-exch" id="btn-exch-exec" title="Perform Conversion">${LANG.BTN_CONVERT}</div>
          <div class="btn-back" id="btn-exch-back" title="Return to Main Menu">Back</div>
      </div>
      <div class="gm-act-btn btn-undo" id="btn-undo" title="Revert the last transaction"><i class="fas fa-undo"></i> ${LANG.BTN_UNDO}</div>
      <div class="gm-footer">
        <a href="${patreonUrl}" target="_blank" class="link-patreon"><i class="fab fa-patreon"></i> ${patreonName}</a>
        <span style="color:#555;">|</span>
        <a href="${discordUrl}" target="_blank" class="link-discord"><i class="fab fa-discord"></i> ${discordName}</a>
      </div>
    </div>`;

    const dialog = new Dialog({
        title: "",
        content: dialogContent,
        buttons: {},
        close: () => {
            if (window.GoldManager.app === dialog) window.GoldManager.app = null;
        },
        render: (html) => {
            html = $(html);
            const inputs = html.find('input[name="gm-gold-mode"]');
            const targetRow = html.find("#row-target-select");
            const splitRow = html.find("#row-split");
            const amtInput = html.find("#gm-gold-amount");
            const noteInput = html.find("#gm-gold-note");
            const mainActions = html.find("#gm-main-actions");
            const exchPanel = html.find("#gm-exchange-panel");
            let isTransactionLocked = false;

            if (!canSelectMode) inputs.filter('[value="single"]').prop("checked", true);

            const refresh = () => {
                const mode = inputs.filter(":checked").val();
                if (mode === "single") {
                    targetRow.slideDown(100);
                    splitRow.css("visibility", "hidden");
                } else {
                    targetRow.slideUp(100);
                    splitRow.css("visibility", "visible");
                }
            };
            inputs.on("change", refresh);
            html.find(".gm-qbtn").on("click", (event) => {
                const value = Number($(event.currentTarget).data("val"));
                amtInput.val((Number(amtInput.val()) || 0) + value);
            });
            html.find("#btn-settings").on("click", () => showSettings());
            html.find("#btn-ledger").on("click", () => showLedger());
            html.find("#gm-calc-open").on("click", () => showCalculator(amtInput));
            html.find("#btn-exch-open").on("click", () => {
                mainActions.slideUp(100);
                exchPanel.slideDown(100);
                html.find("#btn-undo").slideUp(100);
            });
            html.find("#btn-exch-back").on("click", () => {
                exchPanel.slideUp(100);
                mainActions.slideDown(100);
                html.find("#btn-undo").slideDown(100);
            });

            const execute = async (operation) => {
                let preserveInputs = false;
                const fail = (message) => {
                    ui.notifications.warn(message);
                    preserveInputs = true;
                };

                try {
                    const mode = inputs.filter(":checked").val();
                    const amount = Math.round(Number(amtInput.val()));
                    const type = html.find("#gm-gold-type").val();
                    const split = html.find("#gm-gold-split").is(":checked");
                    const note = noteInput.val().trim() || (operation === "set" ? "Set Balance" : (operation === "transfer" ? "Transfer" : "Adjustment"));

                    if (operation !== "undo") {
                        const invalid = !Number.isFinite(amount) || amount < 0 || (amount === 0 && operation !== "set") || !RATES[type];
                        if (invalid) return fail("Invalid Amount");
                    }

                    if (operation === "undo") {
                        const stored = foundry.utils.duplicate(game.user.getFlag("world", "goldUndoHistory") || []);
                        const history = Array.isArray(stored) ? stored : [];
                        if (!history.length) return fail("No recent transactions.");
                        const undoData = history[history.length - 1];
                        if (undoData?.relayNonce) {
                            const source = game.actors.get(undoData.sourceId);
                            if (!source || !canEditActor(source)) return fail("You can only undo a transfer from a character you own.");
                            if (!activeGMOnline() && !game.user.isGM) return fail("A GM must be online to undo that transfer.");
                            await source.setFlag(MODULE_ID, "undo", { nonce: undoData.relayNonce });
                            ui.notifications.info("Undo requested.");
                            return;
                        }
                        if (!Array.isArray(undoData)) return fail("No recent transactions.");
                        const locked = undoData.filter((entry) => {
                            const actor = game.actors.get(entry.id);
                            return actor && !canEditActor(actor);
                        });
                        if (locked.length) return fail("A GM has to undo that transaction.");
                        for (const entry of undoData) {
                            const actor = game.actors.get(entry.id);
                            if (!actor) continue;
                            if (entry.type === "all" && entry.val && typeof entry.val === "object") await writeCurrency(actor, entry.val);
                            else if (RATES[entry.type]) await setCurrency(actor, entry.val, entry.type);
                        }
                        await game.user.setFlag("world", "goldUndoHistory", history.slice(0, -1));
                        logTransaction("System", "UNDO", "-", "Reverted last action");
                        ChatMessage.create({
                            content: makeCard("Undo Successful", "Transaction reverted.", false),
                            speaker: { alias: "Gold Manager" }
                        });
                        playSound();
                        return;
                    }

                    let targets = [];
                    if (mode === "all" && canSelectMode) targets = validActors.slice();
                    else if (mode === "selected" && canSelectMode) {
                        const controlled = canvas?.tokens?.controlled ?? [];
                        targets = controlled
                            .map((token) => token.actor)
                            .filter((actor) => actor && actor.type === "character" && (game.user.isGM || actor.isOwner));
                        if (!targets.length) return fail("Select tokens on the canvas.");
                    } else {
                        const actor = game.actors.get(html.find("#gm-gold-target").val());
                        if (actor) targets = [actor];
                    }
                    if (!targets.length) return fail("Choose a character.");

                    if ((operation === "transfer" || operation === "exchange") && targets.length !== 1) {
                        return fail("Choose a single character for this action.");
                    }

                    const blocked = targets.filter((actor) => !canEditActor(actor));
                    if (blocked.length) {
                        ui.notifications.warn(`No edit permission for ${blocked.map((actor) => actor.name).join(", ")}. The GM must grant ownership.`);
                        targets = targets.filter((actor) => canEditActor(actor));
                        if (!targets.length) return fail("No editable characters in that selection.");
                    }

                    if (operation === "exchange") {
                        const actor = targets[0];
                        const targetType = html.find("#gm-exch-to").val();
                        if (!RATES[targetType]) return fail("Unknown currency.");
                        if (type === targetType) return fail("Source and target currency are the same.");
                        const wallet = readWallet(actor);
                        if (wallet[type] < amount) return fail(`${actor.name} lacks enough ${type.toUpperCase()}.`);
                        const valueInCopper = amount * RATES[type];
                        if (valueInCopper % RATES[targetType] !== 0) return fail("That amount does not convert into a whole number of coins.");
                        const valueToAdd = valueInCopper / RATES[targetType];
                        wallet[type] -= amount;
                        wallet[targetType] += valueToAdd;
                        await pushUndo([walletSnapshot(actor)]);
                        await writeCurrency(actor, wallet);
                        const receipt = `<div style="text-align:center; color:#000000 !important; background:#ffffff !important;">${escapeHtml(actor.name)}: <span style="color:#000000 !important;">-${amount} ${type.toUpperCase()}</span> ➞ <span style="color:#000000 !important;">+${valueToAdd} ${targetType.toUpperCase()}</span></div>`;
                        const message = {
                            content: makeCard("Currency Exchange", receipt, true),
                            speaker: { alias: "Gold Manager" }
                        };
                        if (!getSetting("publicExchange")) message.whisper = [game.user.id];
                        ChatMessage.create(message);
                        playSound();
                        triggerFloatingText(html, `${type.toUpperCase()} -> ${targetType.toUpperCase()}`, "#22d3ee");
                        logTransaction(actor.name, "Exchange", `${amount} ${type.toUpperCase()}`, `To ${valueToAdd} ${targetType.toUpperCase()}`);
                        return;
                    }

                    if (operation === "transfer") {
                        const source = targets[0];
                        if (readWallet(source)[type] < amount) return fail(`${source.name} does not have enough ${type.toUpperCase()}.`);
                        const others = game.actors.contents
                            .filter((actor) => actor.id !== source.id && actor.type === "character" && (actor.hasPlayerOwner || actor.isOwner))
                            .sort((a, b) => a.name.localeCompare(b.name));
                        if (!others.length) return fail("No other character is available to receive this transfer.");
                        preserveInputs = true;
                        const otherOpts = others.map((actor) => `<option value="${escapeHtml(actor.id)}">${escapeHtml(actor.name)}</option>`).join("");
                        new Dialog({
                            title: "Select Recipient",
                            content: `<div class="gm-win"><div class="gm-row"><select id="gm-xfer-target" class="gm-select">${otherOpts}</select></div></div>`,
                            buttons: {
                                send: {
                                    label: "Send",
                                    callback: async (innerHtml) => {
                                        try {
                                            const dest = game.actors.get($(innerHtml).find("#gm-xfer-target").val());
                                            const freshSource = game.actors.get(source.id);
                                            if (!freshSource || !dest) return;
                                            if (!canEditActor(freshSource)) {
                                                ui.notifications.warn("You can only send coins from a character you own.");
                                                return;
                                            }
                                            const sourceWallet = readWallet(freshSource);
                                            if (sourceWallet[type] < amount) {
                                                ui.notifications.error(`${freshSource.name} does not have enough ${type.toUpperCase()}.`);
                                                return;
                                            }
                                            if (canEditActor(dest)) {
                                                await pushUndo([walletSnapshot(freshSource), walletSnapshot(dest)]);
                                                await setCurrency(freshSource, sourceWallet[type] - amount, type);
                                                await setCurrency(dest, readWallet(dest)[type] + amount, type);
                                                postTransferReceipt(freshSource, dest, amount, type, note);
                                                playSound();
                                                triggerFloatingText(html, `Sent ${amount} ${type.toUpperCase()}`, "#8b5cf6");
                                                logTransaction(freshSource.name, "Transfer Out", `${amount} ${type.toUpperCase()}`, `To ${dest.name}`);
                                                logTransaction(dest.name, "Transfer In", `${amount} ${type.toUpperCase()}`, `From ${freshSource.name}`);
                                            } else if (!activeGMOnline()) {
                                                ui.notifications.warn("A GM must be online to deliver coins to a character you do not own.");
                                                return;
                                            } else {
                                                const nonce = foundry.utils.randomID();
                                                await freshSource.update({
                                                    [`system.currency.${type}`]: sourceWallet[type] - amount,
                                                    [`flags.${MODULE_ID}.credit`]: { destId: dest.id, amount, type, nonce, note }
                                                }, { fromUniversalGold: true });
                                                ui.notifications.info("Transfer sent to the GM for delivery.");
                                            }
                                            amtInput.val("").trigger("focus");
                                            noteInput.val("");
                                        } catch (err) {
                                            console.error("Gold Manager transfer failed:", err);
                                            ui.notifications.error("Transfer failed. Check the console for details.");
                                        }
                                    }
                                }
                            }
                        }).render(true);
                        return;
                    }

                    let shares = targets.map(() => amount);
                    let isSplit = false;
                    if (operation === "add" && split && targets.length > 1) {
                        const base = Math.floor(amount / targets.length);
                        const remainder = amount % targets.length;
                        shares = targets.map((_, index) => base + (index < remainder ? 1 : 0));
                        isSplit = true;
                    }
                    const work = targets.map((actor, index) => ({ actor, share: shares[index] })).filter((entry) => entry.share > 0 || operation === "set");
                    if (!work.length) return fail("Amount is too small to split.");

                    if (operation === "remove") {
                        const short = work.filter(({ actor, share }) => walletToCopper(readWallet(actor)) < share * RATES[type]).map(({ actor }) => actor.name);
                        if (short.length) return fail(`Not enough coins: ${short.join(", ")}.`);
                    }

                    await pushUndo(work.map(({ actor }) => walletSnapshot(actor)));

                    const sign = operation === "add" ? "+" : (operation === "remove" ? "-" : "=");
                    const color = "#000000";
                    let listHtml = `<table style="width:100%; font-size:11px; border-collapse:collapse; color:#000000 !important; background:#ffffff !important;">`;
                    work.forEach(({ actor, share }) => {
                        listHtml += `<tr style="background:#ffffff !important;"><td style="padding:3px; color:#000000 !important; background:#ffffff !important;">${escapeHtml(actor.name)}</td><td style="text-align:right; font-weight:bold; color:#000000 !important; background:#ffffff !important;">${sign}${share} ${type.toUpperCase()}</td></tr>`;
                    });
                    listHtml += `</table>`;
                    const headline = isSplit ? `${sign}${amount} ${type.toUpperCase()} (Split)` : `${sign}${amount} ${type.toUpperCase()}`;
                    ChatMessage.create({
                        content: makeCard(`Currency ${operation.toUpperCase()}`, `<div style="text-align:center; margin-bottom:5px; background:#ffffff !important;"><div style="font-size:16px; font-weight:bold; color:${color} !important; background:#ffffff !important;">${headline}</div><div style="font-style:italic; font-size:11px; color:#000000 !important; background:#ffffff !important;">"${escapeHtml(note)}"</div></div>${listHtml}`, true),
                        speaker: { alias: "Gold Manager" }
                    });
                    if (operation === "add") {
                        triggerCoinShower(html);
                        triggerFloatingText(html, `+${isSplit ? amount : work[0].share} ${type.toUpperCase()}`, "#4ade80");
                    }
                    if (operation === "remove") triggerFloatingText(html, `-${amount} ${type.toUpperCase()}`, "#f87171");
                    playSound();

                    for (const { actor, share } of work) {
                        const wallet = readWallet(actor);
                        if (operation === "remove" && wallet[type] < share) {
                            await writeCurrency(actor, copperToWallet(walletToCopper(wallet) - (share * RATES[type])));
                        } else if (operation === "remove") {
                            await setCurrency(actor, wallet[type] - share, type);
                        } else if (operation === "add") {
                            await setCurrency(actor, wallet[type] + share, type);
                        } else {
                            await setCurrency(actor, share, type);
                        }
                        logTransaction(actor.name, operation, `${share} ${type.toUpperCase()}`, note);
                    }
                } catch (err) {
                    console.error("Gold Manager Main Loop Error:", err);
                    ui.notifications.error("Gold Manager could not finish that transaction.");
                    preserveInputs = true;
                } finally {
                    if (!preserveInputs) {
                        amtInput.val("").trigger("focus");
                        noteInput.val("");
                    }
                }
            };

            const handleBtnClick = (btnId, operation) => {
                html.find(btnId).on("click", async () => {
                    if (isTransactionLocked) return;
                    isTransactionLocked = true;
                    html.find(btnId).addClass("disabled");
                    try { await execute(operation); }
                    finally {
                        isTransactionLocked = false;
                        html.find(btnId).removeClass("disabled");
                    }
                });
            };
            handleBtnClick("#btn-add", "add");
            handleBtnClick("#btn-rem", "remove");
            handleBtnClick("#btn-set", "set");
            handleBtnClick("#btn-xfer", "transfer");
            handleBtnClick("#btn-exch-exec", "exchange");
            handleBtnClick("#btn-undo", "undo");
            amtInput.on("keydown", (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                if (isTransactionLocked) return;
                isTransactionLocked = true;
                execute("add").finally(() => { isTransactionLocked = false; });
            });
            refresh();
        }
    }, { width: 380, id: "gold-manager-ui", classes: ["gold-manager-window"] });

    window.GoldManager.app = dialog;
    dialog.render(true);
}

export async function toggleGoldManager() {
    return openGoldManager();
}
