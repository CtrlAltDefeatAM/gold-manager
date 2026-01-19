import { openGoldManager } from "./gold-manager.js";

Hooks.once("ready", () => {
  const id = "gold-manager";
  const mod = game.modules.get(id);

  if (mod) {
    // Registers the API command to match the .db file above
    mod.api = {
      open: openGoldManager
    };
    console.log(`[${id}] API Registered Successfully.`);
  }
});