import { initGoldManager, openGoldManager, readyGoldManager } from "./gold-manager.js";

Hooks.once("init", () => {
  initGoldManager();
});

Hooks.once("ready", () => {
  const id = "gold-manager";
  const mod = game.modules.get(id);
  if (mod) {
    mod.api = { open: openGoldManager };
    console.log(`[${id}] API Registered Successfully.`);
  }
  return readyGoldManager();
});
