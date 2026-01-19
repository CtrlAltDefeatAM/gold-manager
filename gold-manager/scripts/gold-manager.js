// =======================================================
// UNIVERSAL GOLD MANAGER (v55 - The Final Cut)
// System: dnd5e (uses system.currency.*)
// Optimization: GPU Accel, V13 Safe, Flood Protection
// =======================================================

export async function openGoldManager() {

    // ================= LOCALIZATION =================
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
        BTN_BACK: "Back",
        BTN_UNDO: "Undo",
        PH_AMT: "Amount...",
        PH_NOTE: "Reason (Loot, Service...)",
        LBL_SPLIT: "Split Amount"
    };

    const DEFAULT_SETTINGS = {
        gmOnly: false,
        playerSeeAll: false,
        soundSrc: "sounds/lock.wav",
        defaultCurrency: "gp",
        publicExchange: true
    };

    const RATES = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
    const LEDGER_NAME = "Gold Manager Ledger";
    const PLAYER_COLORS = [
        "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", 
        "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b"
    ];

    // ================= HELPERS & SETUP =================
    window.GoldManager = window.GoldManager || {};

    function getSetting(key) { 
        return game.user.getFlag("world", "goldManagerSettings")?.[key] ?? DEFAULT_SETTINGS[key];
    }

    async function saveSetting(key, val) {
        const s = game.user.getFlag("world", "goldManagerSettings") || DEFAULT_SETTINGS;
        s[key] = val;
        await game.user.setFlag("world", "goldManagerSettings", s);
    }

    function playSound() {
        const src = getSetting("soundSrc");
        if (!src) return;
        const ah = (typeof AudioHelper !== "undefined") ? AudioHelper : foundry.audio.AudioHelper;
        if (ah) ah.play({ src: src, volume: 0.8, autoplay: true, loop: false }, true);
    }

    function getCurrency(actor, type) { return foundry.utils.getProperty(actor, `system.currency.${type}`) ?? 0; }
    async function setCurrency(actor, value, type) { return actor.update({ [`system.currency.${type}`]: value }, { fromUniversalGold: true }); }

    function getValidActors() {
        const seeAll = game.user.isGM || getSetting("playerSeeAll");
        return game.actors.contents
            .filter(a => (seeAll ? a.hasPlayerOwner : a.isOwner) && a.type === "character")
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // ================= LEDGER SYSTEM (STABLE) =================
    async function getOrCreateLedger() {
        let journal = game.journal.getName(LEDGER_NAME);
        if (!journal && game.user.isGM) {
            journal = await JournalEntry.create({
                name: LEDGER_NAME,
                "ownership": { "default": 3 } 
            });
            await journal.createEmbeddedDocuments("JournalEntryPage", [{
                name: "Log",
                type: "text",
                text: { content: `<h1>Gold Transaction Ledger</h1><table border="1" style="width:100%; border-collapse: collapse; font-family: monospace;"><thead><tr style="background:#222; color:#fff;"><th>Time</th><th>User</th><th>Character</th><th>Action</th><th>Amount</th><th>Reason</th></tr></thead><tbody></tbody></table>` }
            }]);
        }
        return journal;
    }

    function getActorColor(name) {
        if (!name) return "#ccc";
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const index = Math.abs(hash) % PLAYER_COLORS.length;
        return PLAYER_COLORS[index];
    }

    async function logTransaction(actorName, action, amountString, reason) {
        try {
            const journal = game.journal.getName(LEDGER_NAME);
            if (!journal) {
                if(game.user.isGM) await getOrCreateLedger(); 
                return;
            }
            if (!journal.testUserPermission(game.user, "OWNER")) return;

            const timestamp = new Date().toLocaleString();
            const userName = game.user.name;
            const nameColor = getActorColor(actorName);

            const rowHtml = `<tr style="border-bottom:1px solid #444;">
                <td style="padding:4px;">${timestamp}</td>
                <td style="padding:4px;">${userName}</td>
                <td style="padding:4px; font-weight:bold; color:${nameColor};">${actorName}</td>
                <td style="padding:4px;">${action}</td>
                <td style="padding:4px; font-weight:bold;">${amountString}</td>
                <td style="padding:4px; font-style:italic;">${reason}</td>
            </tr>`;

            if (journal.pages.size > 0) {
                const page = journal.pages.contents[0];
                let content = page.text.content;
                if (content.includes("</tbody>")) {
                    content = content.replace("</tbody>", `${rowHtml}</tbody>`);
                    await page.update({ "text.content": content });
                }
            }
        } catch (err) {
            console.error("Gold Manager Ledger Error:", err);
        }
    }

    async function showLedger() {
        const journal = await getOrCreateLedger();
        if (journal) journal.sheet.render(true);
        else ui.notifications.warn("Ledger missing. GM must run macro once.");
    }

    // ================= MANUAL TRACKING (DEBOUNCED) =================
    if (!window.GoldManagerHooksRegistered) {
        window.GoldManagerHooksRegistered = true;
        let updateQueue = [];
        let debounceTimer = null;

        Hooks.on("updateActor", (actor, data, options, userId) => {
            if (actor.type !== "character" || !foundry.utils.hasProperty(data, "system.currency")) return;
            if (options.fromUniversalGold) return; 
            if (userId !== game.user.id) return; 

            const oldC = actor._source.system.currency;
            const newC = data.system.currency;
            let changes = [];

            for (let [key, val] of Object.entries(newC)) {
                const diff = val - (oldC[key] || 0);
                if (diff !== 0) {
                    const sign = diff > 0 ? "+" : "";
                    changes.push(`${sign}${diff} ${key.toUpperCase()}`);
                }
            }

            if (changes.length > 0) {
                updateQueue.push({ name: actor.name, change: changes.join(", ") });
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    let msgHtml = `<div style="text-align:center; font-size:11px;">`;
                    updateQueue.forEach(u => {
                        msgHtml += `<div><b>${u.name}:</b> ${u.change}</div>`;
                        logTransaction(u.name, "Manual Edit", u.change, "Sheet Edit");
                    });
                    msgHtml += `</div>`;
                    ChatMessage.create({ 
                        content: makeCard("Manual Adjustment", msgHtml, false), 
                        speaker: { alias: "Gold Manager" } 
                    });
                    updateQueue = []; 
                }, 200);
            }
        });
    }

    // =============== VISUAL FX (GPU OPTIMIZED) ===============
    function triggerCoinShower(html) {
        const container = html.find('.gm-win')[0];
        if (!container) return;
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < 15; i++) {
            const coin = document.createElement("div");
            coin.classList.add("gm-coin-fx");
            const left = Math.random() * 95; 
            const duration = 0.5 + Math.random() * 0.7;
            const delay = Math.random() * 0.3;
            coin.style.left = `${left}%`;
            coin.style.animationDuration = `${duration}s`;
            coin.style.animationDelay = `${delay}s`;
            fragment.appendChild(coin);
            setTimeout(() => { if(coin.parentNode) coin.remove(); }, (duration + delay) * 1000);
        }
        container.appendChild(fragment);
    }

    function triggerFloatingText(html, text, color) {
        const win = html.closest('.window-app'); 
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
        setTimeout(() => { if(el.parentNode) el.remove(); }, 1500);
    }

    // =============== CSS & OBFUSCATION ===============
    const injectStyles = () => {
        if (document.getElementById("gm-gold-styles")) return;
        const style = document.createElement("style");
        style.id = "gm-gold-styles";
        style.innerHTML = `
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
            .ledger-btn { font-size: 14px; cursor: pointer; color: #64748b; transition: color 0.2s; margin-left: 15px; } 
            .settings-btn { font-size: 14px; cursor: pointer; color: #64748b; transition: color 0.2s; margin-left: 8px; }
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
            .gm-splash-window .window-header { display: none !important; }
            .gm-splash-window { background: transparent !important; box-shadow: none !important; border: none !important; z-index: 99999 !important; }
            .gm-splash-img { border:none; width:100%; border-radius:8px; display:block; margin-bottom:10px; min-height: 150px; object-fit: cover; }
            .gm-loading-dots::after { content: '.'; animation: gm-dots 1.5s steps(5, end) infinite; }
            @keyframes gm-dots { 0%, 20% { content: '.'; } 40% { content: '..'; } 60% { content: '...'; } 80%, 100% { content: ''; } }
        `;
        document.head.appendChild(style);
    };
    injectStyles();

    function makeCard(title, messageHtml, highlight = false) {
        const borderColor = highlight ? "#10b981" : "#3b82f6";
        return `
        <div style="all: initial; display: block; width: 100%; background: #111827 !important; background-color: #111827 !important; border: 1px solid ${borderColor}; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.5); color: #f3f4f6 !important; font-family: 'Signika', sans-serif; font-size: 12px; overflow: hidden; text-shadow: none !important;">
          <div style="background: rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,255,255,0.1); padding: 6px; font-weight: bold; text-align: center; text-transform: uppercase; letter-spacing: 1px; color: #f3f4f6 !important;">${title}</div>
          <div style="padding: 8px; color: #e5e7eb !important;">${messageHtml}</div>
        </div>`;
    }

    if (!window._goldManagerHotkeyAttached) {
        window._goldManagerHotkeyAttached = true;
        $(document).off('keydown.gm');
        $(document).on('keydown.gm', (e) => {
            if (e.shiftKey && (e.key === "G" || e.code === "KeyG") && !$(e.target).is("input, textarea, [contenteditable]")) {
                e.preventDefault(); e.stopPropagation();
                if (window.GoldManager.toggle) window.GoldManager.toggle();
            }
        });
    }

    const showCalculator = (targetInput) => {
        let expr = "";
        const updateDisplay = (displayEl) => { displayEl.text(expr || "0"); };
        const safeEval = (str) => {
            try {
                const sanitized = str.replace(/[^0-9+\-*/().]/g, "");
                if (!sanitized) return "";
                return new Function('return ' + sanitized)();
            } catch (e) { return "Err"; }
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
                    } else { if (expr === "Err") expr = ""; expr += key; }
                    updateDisplay(display);
                };
                html.find(".calc-btn").click((e) => { processInput($(e.currentTarget).data("key")); });
                html.on("keydown", (e) => {
                    const k = e.key;
                    const valid = ['0','1','2','3','4','5','6','7','8','9','.','+','-','*','/','(',')','=','Enter','Backspace','c','C'];
                    if (valid.includes(k) || k.toLowerCase() === 'c') {
                        e.preventDefault(); e.stopPropagation();
                        let m = k; if(k.toLowerCase()==='c') m="C"; if(k==='Backspace') m="DEL";
                        processInput(m);
                    }
                });
            }
        }, { width: 220, height: "auto" }).render(true);
    };

    const showSettings = () => {
        const s = { 
            gmOnly: getSetting("gmOnly"), 
            playerSeeAll: getSetting("playerSeeAll"), 
            soundSrc: getSetting("soundSrc"),
            publicExchange: getSetting("publicExchange") ?? true 
        };
        new Dialog({
            title: "Gold Manager Settings",
            content: `
            <div class="gm-settings-form">
                <div class="form-group"><label>GM Only Mode</label><input type="checkbox" id="set-gmOnly" ${s.gmOnly?"checked":""}></div>
                <span class="notes">If checked, players cannot run this macro.</span>
                
                <div class="form-group"><label>Treasurer Mode</label><input type="checkbox" id="set-seeAll" ${s.playerSeeAll?"checked":""}></div>
                <span class="notes">Allows players to view all characters and transfer gold between party members.</span>
                
                <div class="form-group"><label>Public Exchange Log</label><input type="checkbox" id="set-publicExchange" ${s.publicExchange?"checked":""}></div>
                <span class="notes">Visible receipts for currency exchange.</span>

                <div class="form-group" style="display:block;"><label style="display:block; margin-bottom:4px;">Sound File</label><input type="text" id="set-sound" value="${s.soundSrc}"></div>
                <span class="notes">Path to audio file (e.g. sounds/lock.wav).</span>
            </div>`,
            buttons: { save: { label: "Save", callback: async (h) => { 
                h = $(h); 
                await saveSetting("gmOnly", h.find("#set-gmOnly").is(":checked"));
                await saveSetting("playerSeeAll", h.find("#set-seeAll").is(":checked")); 
                await saveSetting("publicExchange", h.find("#set-publicExchange").is(":checked")); 
                await saveSetting("soundSrc", h.find("#set-sound").val()); 
                ui.notifications.info("Settings Saved."); 
            }}}
        }).render(true);
    };

    window.GoldManager.render = async () => {
        if (!window.goldManagerInitShown) {
            window.goldManagerInitShown = true;
            const gifUrl = "modules/gold-manager/assets/splash.gif";
            await new Promise(resolve => {
                const img = new Image();
                img.onload = resolve;
                img.onerror = resolve; 
                img.src = gifUrl;
            });
            const splashContent = `
            <div style="text-align:center; background:#020617; border:2px solid #fbbf24; border-radius:12px; padding:15px; color:#fbbf24; font-family:'Cinzel'; box-shadow: 0 0 20px rgba(251,191,36,0.3);">
                <img src="${gifUrl}" class="gm-splash-img">
                <div id="gm-loading-text" style="font-size:14px; font-weight:bold; margin-bottom:5px;">Initializing...</div>
                <div style="font-size:10px; color:#94a3b8; font-family:'Signika';">System ready. Built by CtrlAltDefeat.<br>Happy spending.</div>
            </div>`;
            const splash = new Dialog({
                title: "",
                content: splashContent,
                buttons: {}
            }, { width: 320, height: "auto", classes: ["gm-splash-window"] }).render(true);

            const loadingSteps = ["Loading Assets...", "Syncing Exchange Rates...", "Calibrating Wallets...", "System Ready."];
            let step = 0;
            let lastUpdate = 0;
            let isRunning = true;

            const loop = (timestamp) => {
                if (!isRunning) return;
                if (timestamp - lastUpdate > 600) {
                     const el = document.getElementById("gm-loading-text");
                     if(el && step < loadingSteps.length) {
                         el.innerText = loadingSteps[step];
                         step++;
                         lastUpdate = timestamp;
                     }
                }
                if (step <= loadingSteps.length) requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);

            setTimeout(() => {
                isRunning = false;
                splash.close();
                getOrCreateLedger(); 
                window.GoldManager.render(); 
            }, 3000);
            return;
        }

        if (!game.user.isGM && getSetting("gmOnly")) return ui.notifications.warn("Gold Manager: Access Restricted.");
        if (window.GoldManager.app) { window.GoldManager.app.close(); window.GoldManager.app = null; return; }

        const validActors = getValidActors();
        if (!validActors.length) return ui.notifications.warn("No controllable characters found.");
        const defaultActorId = game.user.character?.id || validActors[0]?.id;
        const optionsHtml = validActors.map(a => `<option value="${a.id}" ${a.id === defaultActorId ? "selected" : ""}>${a.name}</option>`).join("");
        const isGM = game.user.isGM;
        const canSelectMode = isGM || getSetting("playerSeeAll");
        const displayTargetBlock = canSelectMode ? "flex" : "none";
        const defaultTargetDisplay = canSelectMode ? "none" : "block";

        // --- SECURITY OBFUSCATION ---
        const _p = ["P","a","t","r","e","o","n"].join("");
        const _d = ["D","i","s","c","o","r","d"].join("");
        const _u1 = "https://www."+_p.toLowerCase()+".com/Ctrl_Alt_Defeat";
        const _u2 = "https://"+_d.toLowerCase()+".gg/fBf7xw2bmB";

        const dialogContent = `
        <div class="gm-win">
          <div class="gm-head">
              <span style="flex:1;"></span>
              <span>${LANG.TITLE}</span>
              <span style="flex:1; text-align:right;">
                ${isGM ? `<i class="fas fa-cog icon-btn" id="btn-settings" title="${LANG.SETTINGS}"></i>` : ""}
              </span>
          </div>

          <div class="gm-row" style="display:${displayTargetBlock};">
            <div class="gm-label">TARGET</div>
            <div style="flex:1; display:flex; justify-content:space-between; font-size:11px;">
              <label><input type="radio" name="gm-gold-mode" value="all" checked> ${LANG.TGT_ALL}</label>
              <label><input type="radio" name="gm-gold-mode" value="selected"> ${LANG.TGT_SEL}</label>
              <label><input type="radio" name="gm-gold-mode" value="single"> ${LANG.TGT_SGL}</label>
            </div>
            <i class="fas fa-book ledger-btn" id="btn-ledger" title="${LANG.LEDGER}"></i>
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
            <div id="row-split" style="flex:1; visibility:${canSelectMode?'visible':'hidden'}; font-size:11px;">
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
            <a href="${_u1}" target="_blank" class="link-patreon"><i class="fab fa-patreon"></i> ${_p}</a>
            <span style="color:#555;">|</span>
            <a href="${_u2}" target="_blank" class="link-discord"><i class="fab fa-discord"></i> ${_d}</a>
          </div>
        </div>`;
        const d = new Dialog({
            title: "",
            content: dialogContent,
            buttons: {},
            close: () => { window.GoldManager.app = null; },
            render: (html) => {
                html = $(html); 
                const inputs = html.find('input[name="gm-gold-mode"]');
                const targetRow = html.find('#row-target-select');
                const splitRow = html.find('#row-split');
                const amtInput = html.find('#gm-gold-amount');
                const noteInput = html.find('#gm-gold-note'); 
                const mainActions = html.find("#gm-main-actions");
                const exchPanel = html.find("#gm-exchange-panel");
                
                let isTransactionLocked = false;
                
                if (!canSelectMode) inputs.filter('[value="single"]').prop("checked", true);

                const refresh = () => {
                    const mode = inputs.filter(':checked').val();
                    if (mode === "single") { targetRow.slideDown(100); splitRow.css("visibility", "hidden"); } 
                    else { targetRow.slideUp(100); splitRow.css("visibility", "visible"); }
                }
                inputs.on("change", refresh);
                html.find('.gm-qbtn').on('click', (e) => { const v = Number($(e.currentTarget).data('val')); amtInput.val((Number(amtInput.val()) || 0) + v); });
                html.find('#btn-settings').click(() => showSettings());
                html.find('#btn-ledger').click(() => showLedger());
                html.find('#gm-calc-open').click(() => showCalculator(amtInput));
                
                html.find('#btn-exch-open').click(() => { mainActions.slideUp(100); exchPanel.slideDown(100); html.find('#btn-undo').slideUp(100); });
                html.find('#btn-exch-back').click(() => { exchPanel.slideUp(100); mainActions.slideDown(100); html.find('#btn-undo').slideDown(100); });
                
                const handleBtnClick = (btnId, op) => {
                    html.find(btnId).click(async () => {
                       if (isTransactionLocked) return;
                       isTransactionLocked = true;
                       html.find(btnId).addClass('disabled');
                       try { await execute(op); }
                       finally {
                           isTransactionLocked = false;
                           html.find(btnId).removeClass('disabled');
                       }
                    });
                };

                handleBtnClick('#btn-add', 'add');
                handleBtnClick('#btn-rem', 'remove');
                handleBtnClick('#btn-set', 'set');
                handleBtnClick('#btn-xfer', 'transfer');
                handleBtnClick('#btn-exch-exec', 'exchange');
                handleBtnClick('#btn-undo', 'undo');

                const execute = async (operation) => {
                    const mode = inputs.filter(':checked').val();
                    const amount = Number(amtInput.val());
                    const type = html.find("#gm-gold-type").val();
                    const split = html.find("#gm-gold-split").is(":checked");
                    const note = noteInput.val().trim() || (operation === "set" ? "Set Balance" : (operation==="transfer"?"Transfer":"Adjustment"));

                    if (operation !== "undo" && (!amount || amount < 0)) return ui.notifications.warn("Invalid Amount");
                    try { 
                        let targets = [];
                        if (mode === "all" && canSelectMode) targets = validActors;
                        else if (mode === "selected" && canSelectMode) {
                            targets = canvas.tokens.controlled.map(t => t.actor).filter(a => a && (game.user.isGM ? a.hasPlayerOwner : a.isOwner) && a.type === "character");
                            if (!targets.length) return ui.notifications.warn("Select Tokens!");
                        } else {
                            const a = game.actors.get(html.find("#gm-gold-target").val());
                            if (a) targets.push(a);
                        }
                        if (!targets.length) return;

                        // [NEW] SAVE HISTORY FOR UNDO
                        if (["add", "remove", "set"].includes(operation)) {
                            const history = game.user.getFlag("world", "goldUndoHistory") || [];
                            const snapshot = targets.map(t => ({
                                id: t.id,
                                type: type,
                                val: getCurrency(t, type)
                            }));
                            const newHistory = [...history, snapshot].slice(-10); // Keep last 10
                            await game.user.setFlag("world", "goldUndoHistory", newHistory);
                        }

                        // --- EXCHANGE ---
                        if (operation === "exchange") {
                            const actor = targets[0];
                            if (targets.length > 1) return ui.notifications.warn("Exchange only works on single targets.");
                            const tgtType = html.find("#gm-exch-to").val();
                            const srcType = type;
                            if (srcType === tgtType) return ui.notifications.warn("Source and Target currency are the same.");
                            let wallet = { cp: getCurrency(actor, "cp"), sp: getCurrency(actor, "sp"), ep: getCurrency(actor, "ep"), gp: getCurrency(actor, "gp"), pp: getCurrency(actor, "pp") };
                            if (wallet[srcType] < amount) return ui.notifications.warn(`${actor.name} lacks enough ${srcType.toUpperCase()}.`);

                            const valueInCP = amount * RATES[srcType];
                            const tgtRate = RATES[tgtType];
                            if (RATES[srcType] < tgtRate && (valueInCP % tgtRate !== 0)) return ui.notifications.warn(`Cannot convert cleanly.`);
                            
                            const valueToAdd = valueInCP / tgtRate;
                            const msg = makeCard("Currency Exchange", `<div style="text-align:center; color:#e5e7eb !important;">${actor.name}: <span style="color:#f87171;">-${amount} ${srcType.toUpperCase()}</span> ➞ <span style="color:#4ade80;">+${valueToAdd} ${tgtType.toUpperCase()}</span></div>`, true);
                            if (getSetting("publicExchange")) ChatMessage.create({ content: msg, speaker: { alias: "Gold Manager" } });
                            else ChatMessage.create({ content: msg, speaker: { alias: "Gold Manager" }, whisper: [game.user.id] });
                            
                            playSound();
                            triggerFloatingText(html, `${srcType.toUpperCase()} -> ${tgtType.toUpperCase()}`, "#22d3ee");

                            wallet[srcType] -= amount;
                            wallet[tgtType] += valueToAdd;
                            await actor.update({ "system.currency": { cp: Math.floor(wallet.cp), sp: Math.floor(wallet.sp), ep: Math.floor(wallet.ep), gp: Math.floor(wallet.gp), pp: Math.floor(wallet.pp) }}, { fromUniversalGold: true });
                            logTransaction(actor.name, "Exchange", `${amount} ${srcType}`, `To ${tgtType}`);
                            return;
                        }

                        // --- TRANSFER ---
                        if (operation === "transfer") {
                            const source = targets[0];
                            if (getCurrency(source, type) < amount) return ui.notifications.error(`${source.name} does not have enough ${type.toUpperCase()}.`);
                            const others = game.actors.contents.filter(a => a.id !== source.id && a.hasPlayerOwner && a.type==="character").sort((a,b)=>a.name.localeCompare(b.name));
                            const otherOpts = others.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
                            new Dialog({
                                title: "Select Recipient",
                                content: `<div class="gm-win"><div class="gm-row"><select id="gm-xfer-target" class="gm-select">${otherOpts}</select></div></div>`,
                                buttons: {
                                    send: { label: "Send", callback: async (h2) => {
                                        h2 = $(h2); 
                                        const destId = h2.find("#gm-xfer-target").val();
                                        const dest = game.actors.get(destId);
                                        if (!dest) return;
                                        
                                        let listHtml = `<table style="width:100%; font-size:11px; border-collapse:collapse; background:transparent !important; color:#e5e7eb !important;"><tr style="background:rgba(255,255,255,0.05) !important;"><td style="padding:3px; background:transparent !important; color:#f3f4f6 !important;">${source.name}</td><td style="text-align:right; font-weight:bold; background:transparent !important; color:#f87171 !important;">-${amount} ${type.toUpperCase()}</td></tr><tr style="background:rgba(255,255,255,0.05) !important;"><td style="padding:3px; background:transparent !important; color:#f3f4f6 !important;">${dest.name}</td><td style="text-align:right; font-weight:bold; background:transparent !important; color:#4ade80 !important;">+${amount} ${type.toUpperCase()}</td></tr></table>`;
                                        ChatMessage.create({ content: makeCard(`Transfer`, `<div style="text-align:center; margin-bottom:5px; color:#f3f4f6 !important;">${note}</div>` + listHtml, true), speaker: { alias: "Gold Manager" } });

                                        playSound();
                                        triggerFloatingText(html, `Sent ${amount} ${type.toUpperCase()}`, "#8b5cf6");
                                        await setCurrency(source, getCurrency(source, type) - amount, type);
                                        await setCurrency(dest, getCurrency(dest, type) + amount, type);
                                        
                                        logTransaction(source.name, "Transfer Out", `${amount} ${type}`, `To ${dest.name}`);
                                        logTransaction(dest.name, "Transfer In", `${amount} ${type}`, `From ${source.name}`);
                                        
                                        amtInput.val('').focus(); noteInput.val('');
                                    }}
                                }
                            }).render(true);
                            return;
                        }

                        // --- UNDO ---
                        if (operation === "undo") {
                            let history = game.user.getFlag("world", "goldUndoHistory");
                            if (!Array.isArray(history) || !history.length) return ui.notifications.warn("No recent transactions.");
                            playSound();
                            const undoData = history.pop();
                            await game.user.setFlag("world", "goldUndoHistory", history);
                            for (const entry of undoData) {
                                const actor = game.actors.get(entry.id);
                                if (actor) {
                                    if (entry.type === "all") await actor.update({ "system.currency": entry.val });
                                    else await setCurrency(actor, entry.val, entry.type);
                                }
                            }
                            logTransaction("System", "UNDO", "-", "Reverted last action");
                            ChatMessage.create({ content: makeCard("↺ Undo Successful", "Transaction reverted.", false), speaker: { alias: "Gold Manager" } });
                            return;
                        }

                        // --- ADD / REMOVE / SET ---
                        let perActor = amount;
                        let isSplit = false;
                        if (operation === "add" && split && targets.length > 0) { perActor = Math.floor(amount / targets.length); isSplit = true; }

                        const sign = operation === "add" ? "+" : (operation === "remove" ? "-" : "=");
                        const color = operation === "add" ? "#4ade80" : (operation === "remove" ? "#f87171" : "#60a5fa");
                        let listHtml = `<table style="width:100%; font-size:11px; border-collapse:collapse; background:transparent !important; color:#e5e7eb !important;">`;
                        targets.forEach((t, i) => { 
                            listHtml += `<tr style="background:${i%2===0?'rgba(255,255,255,0.05)':'transparent'} !important;"><td style="padding:3px; background:transparent !important; color:#f3f4f6 !important;">${t.name}</td><td style="text-align:right; font-weight:bold; background:transparent !important; color:#f3f4f6 !important;">${sign}${perActor} ${type.toUpperCase()}</td></tr>`; 
                        });
                        listHtml += `</table>`;
                        ChatMessage.create({ content: makeCard(`Currency ${operation.toUpperCase()}`, `<div style="text-align:center; margin-bottom:5px; color:#f3f4f6 !important;"><div style="font-size:16px; font-weight:bold; color:${color} !important;">${sign}${perActor} ${type.toUpperCase()} ${isSplit?"(Split)":""}</div><div style="font-style:italic; font-size:11px; color:#9ca3af !important;">"${note}"</div></div>` + listHtml, true), speaker: { alias: "Gold Manager" } });
                        
                        if (operation === "add") { triggerCoinShower(html); triggerFloatingText(html, `+${perActor} ${type.toUpperCase()}`, "#4ade80"); }
                        if (operation === "remove") triggerFloatingText(html, `-${perActor} ${type.toUpperCase()}`, "#f87171");
                        playSound();

                        for (let actor of targets) {
                            let current = getCurrency(actor, type);
                            let newVal = current;
                            if (operation === "remove") {
                                let wallet = { cp: getCurrency(actor, "cp"), sp: getCurrency(actor, "sp"), ep: getCurrency(actor, "ep"), gp: getCurrency(actor, "gp"), pp: getCurrency(actor, "pp") };
                                let totalCP = (wallet.cp) + (wallet.sp*10) + (wallet.ep*50) + (wallet.gp*100) + (wallet.pp*1000);
                                let costCP = perActor * RATES[type];
                                if (wallet[type] >= perActor) { 
                                    newVal = current - perActor; 
                                    await setCurrency(actor, newVal, type);
                                } 
                                else if (totalCP >= costCP) {
                                    let remaining = totalCP - costCP;
                                    wallet.pp = Math.floor(remaining / 1000); remaining %= 1000;
                                    wallet.gp = Math.floor(remaining / 100); remaining %= 100;
                                    wallet.ep = Math.floor(remaining / 50); remaining %= 50;
                                    wallet.sp = Math.floor(remaining / 10); remaining %= 10;
                                    wallet.cp = remaining;
                                    await actor.update({ "system.currency": wallet }, { fromUniversalGold: true });
                                    newVal = wallet[type]; 
                                } else { newVal = current; }
                            } 
                            else if (operation === "add") { newVal = current + perActor; await setCurrency(actor, newVal, type); }
                            else if (operation === "set") { newVal = amount; await setCurrency(actor, newVal, type); }
                            
                            logTransaction(actor.name, operation, `${perActor} ${type}`, note);
                        }
                    
                    } catch(err) {
                        console.error("Gold Manager Main Loop Error:", err);
                    } finally {
                        amtInput.val('').focus();
                        noteInput.val('');
                    }
                };

                amtInput.on('keydown', (e) => { 
                    if (e.key === "Enter") { 
                        e.preventDefault(); e.stopPropagation(); 
                        if (!isTransactionLocked) {
                            isTransactionLocked = true;
                            execute('add').finally(() => isTransactionLocked = false);
                        }
                    } 
                });
                refresh();
            }
        }, { width: 350, id: "gold-manager-ui", classes: ["gold-manager-window"] }).render(true);
    };

    window.GoldManager.toggle = () => {
        if (window.GoldManager.app && window.GoldManager.app.rendered) window.GoldManager.app.close();
        else window.GoldManager.render();
    };

    window.GoldManager.render();
};

export async function toggleGoldManager() {
  if (window.GoldManager?.app && window.GoldManager.app.rendered) window.GoldManager.app.close();
  else window.GoldManager?.render?.();
}