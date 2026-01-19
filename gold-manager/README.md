💰 Universal Gold Manager (Macro)
Version: v1 (Golden Master / Standalone) Platform: Foundry VTT (v11 / v12 / v13 Verified) System: dnd5e Author: CtrlAltDefeat

📜 Project Overview
Universal Gold Manager is a high-performance, neon-styled interface designed to streamline currency management in D&D 5e. It replaces the tedious process of opening individual character sheets to edit gold with a unified, "God-Tier" HUD.

It allows Game Masters to reward the entire party instantly, lets players transfer funds between each other, and includes a built-in calculator for splitting loot on the fly.

STATUS: Standalone. This system functions 100% independently. It does not require any external modules (like MidiQOL or DAE) to function.

🛡️ License & Protective Disclaimer
Usage Rights: This macro is provided free of charge for personal and community use. You are free to modify it for your own private games. If you redistribute this code or include it in a module, you must retain the original attribution to CtrlAltDefeat.

Liability: This software is provided "as is," without warranty of any kind. While extensive testing has been done to ensure data safety (using core Foundry API methods), the author is not liable for any data loss or corruption resulting from the use of this macro. Always backup your world before installing new automation tools.

Wizards of the Coast Fan Content Policy: This content is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

🌟 Key Features
1. The Interface (UI) & Performance
Neon Dark Mode: A sleek, high-contrast interface designed to look good on both V12 and V13. It uses a flat, GPU-accelerated background scheme to prevent rendering lag.

Zero-Shutter Technology: The window utilizes translateZ(0) hardware acceleration and isolated paint layers to ensure dragging the window does not cause frame drops, even on lower-end laptops.

Reactive Layout: The window automatically adjusts based on the selected mode (e.g., hiding the "Split" option when in Single Target mode).

Hotkey Support: Press Shift + G to instantly toggle the interface open or closed.

2. "The Overseer" (Passive Tracking)
The macro includes a background listener called The Overseer.

If a player manually edits their gold on their character sheet (typing in a new number), the Gold Manager detects it.

It calculates the difference (e.g., "Manually removed 5 GP") and automatically logs it to the Chat and Ledger.

Ghost-Killer: The code includes self-cleaning logic to ensure you never get "double posts" if you restart the macro multiple times.

3. The Ledger System
Persistent Database: Creates a dedicated Journal Entry ("Gold Manager Ledger") to track every single coin transaction.

Fault-Tolerant Logic: The system uses a "Firewall" execution order:

Chat Receipt: Fires instantly (Guaranteed feedback).

Visual FX: Plays sound and coin drop animation.

Data Update: Changes the actual actor currency.

Ledger Log: Writes to the journal.

This ensures that even if the Journal is locked or permissions fail, the player still gets their gold and a chat message.

4. Targeting Modes
🔘 All (GM / Treasurer Only): Applies the transaction to every player-owned character in the game. Perfect for group loot distribution.

🔘 Selected: Applies the transaction only to the tokens currently selected on the canvas.

🔘 Single: Allows you to select a specific character from a dropdown menu.

🕹️ Usage Instructions
For GMs
Launch: Run the macro or press Shift + G.

Reward Party: Select "All", type 500, check "Split Amount", and click Add.

Settings: Click the ⚙️ Cog Icon in the top right to access:

GM Only Mode: Restrict the macro so players cannot open it.

Treasurer Mode: Allow players to see/edit all characters (useful if one player manages the party funds).

Sound File: Customize the sound effect played during transactions.

For Players
Launch: Run the macro or press Shift + G.

Looting: Type the gold found and click Add.

Transferring:

Click Transfer.

Select the recipient from the popup list.

Click Send.

Note: Players can only transfer FROM characters they own.

⚙️ Technical Details
Undo System
The macro uses a User-Specific Flag (world.goldUndoHistory) to store snapshots of actor data before every transaction.

Isolation: A player cannot undo a GM's edit, and the GM cannot undo a player's edit. History is private to the user.

Depth: The history stack is limited to the last 2 transactions to save data size.

Transfer Safety
Permission Check: The macro verifies ownership before executing a transfer. If a player tries to move gold from a token they don't control, the macro blocks the action.

Chat Log: Every transfer creates a stylized chat card showing exactly who sent what to whom, ensuring transparency.

Calculator Logic
Sanitization: The calculator uses a "safe eval" method that strips out any characters except numbers and math operators (0-9, +, -, *, /, (), .) before calculating. This prevents code injection attacks.

Clear Function: Pressing C on the calculator clears both the calculator display and the main interface's Amount box.

🔧 Troubleshooting
Q: The window stutters when I drag it.

A: Ensure you are using v55+. This version includes GPU acceleration (translateZ) specifically to fix browser rendering lag on Chromium-based browsers (Foundry).

Q: I see double chat messages for every action.

A: Update to v55+. Older versions could leave "ghost hooks" running in the background. The new version includes a "Ghost Killer" script that purges old listeners immediately upon launch.

Q: Players cannot see the "All" option.

A: This is intended behavior. Players are restricted to "Single" or "Selected" (own tokens only) unless the GM enables "Treasurer Mode" in the Settings menu.

Q: Ledger isn't updating for players.

A: The macro attempts to set ownership permissions on the Gold Manager Ledger journal automatically. If it fails, manually configure that Journal Entry to give players "Owner" or "Observer" permissions. The macro's "Fault Tolerant" logic will simply skip the log and proceed with the gold transaction if it cannot write to the journal.