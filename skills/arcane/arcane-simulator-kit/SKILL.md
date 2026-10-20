---
name: arcane-simulator-kit
description: "Prescriptive simulator genre kit: collect-sell-upgrade loop, capped backpack, currency-gated zones, pets and eggs basics, rebirth and session-locked saves, with build order, balancing numbers, budgets and playtest plan."
license: MIT
---

# Simulator kit

Cross-links: economy model `arcane-economy`; feel and juice `arcane-gameplay-feel`; saving `arcane-datastore-safety`; remotes `arcane-remote-security`; HUD/shop/inventory grid `arcane-interface`; pickup VFX `arcane-vfx`; pet followers and saved pet data `arcane-characters:pets` (no Humanoid needed). Code: [patterns](references/patterns.md) (`arcane-simulator-kit:patterns`).

## Architecture
- ServerScriptService: Script `SimServer` + ModuleScripts `Sim/CollectService`, `Sim/SellService`, `Sim/UpgradeService`, `Sim/ZoneService`, `Sim/PetService`, `Sim/DataService`.
- ReplicatedStorage: `Shared/SimConfig` (nodes, tools, bags, zones, eggs, pets). `Remotes` made by the server: RemoteEvent `Collect` (client click intent), RemoteFunction `Buy`, RemoteFunction `HatchEgg`, RemoteFunction `EquipPet`.
- StarterPlayerScripts: `SimClient` (click/hold to swing, HUD binding, pet follow visuals, local hatch animation).
- The server decides every amount: node value, bag space, sell price, egg roll.

## Data model
- Session attributes: `Coins`, `Bag`, `BagMax`, `Power`, `Rebirths`, `Zone`; `leaderstats.Coins`, `leaderstats.Rebirths`.
- DataStore `Sim_v1`, key `u_<UserId>`: `{ version = 1, lock = { jobId, time }, data = { coins, rebirths, tool, bag, zones = {..}, pets = { [uid] = { kind, level } }, equipped = { uid } , eggsOpened } }`.
- UpdateAsync, session lock, receipts, autosave 90 s, BindToClose per `arcane-datastore-safety`. Saving stays disabled until asked.

## Build order
1. Inspect; `environment_apply` preset `clear_day`; `terrain_generate` ground per zone if natural (`arcane-natural-scenes`).
2. `scene_build` hub: spawn, Sell pad, Upgrade shop pad, Egg stand, rebirth statue.
3. `scene_build` each zone (one batch per zone): nodes via prototypes + `scatter`, gate wall with price SurfaceGui.
4. Scripts disabled -> HUD `scene_build` -> enable -> `playtest_request`.

## Map with scene_build
- Hub 120 x 120 at origin; zones in a line or ring of plateaus, each 160 x 160, gate 12 studs wide.
- Nodes: prototypes `Node_Small` / `Node_Big` (Folder `Zones/Zone_1/Nodes`), scatter 40-60 per zone with Poisson spacing 8, keep-out circle around the gate. Node respawn is server-side (hide + timer), not re-built.
- Gate: part `Gate_2` CanCollide true, Neon tint; server sets CanCollide false locally for owners via a client-side unlock (server validates `Zone` before any reward in that zone).
- Sell pad 10 x 1 x 10 Neon accent near spawn; never more than 25 studs from the zone 1 entrance.

## GUI with scene_build
Screen `SimHud`: coins pill, bag bar (`Bag / BagMax`, full = danger colour + "Sell!" prompt), Rebirth button, Pets button opening an inventory grid, Egg hatch overlay. Use `arcane-interface:recipes` (HUD bars, Shop, Inventory grid).

## Balancing (starting numbers)
| Zone | Unlock | Node value | Node HP | Respawn |
|---|---|---|---|---|
| 1 | free | 1 | 3 | 5 s |
| 2 | 1,000 | 6 | 10 | 8 s |
| 3 | 12,000 | 40 | 30 | 10 s |
| 4 | 150,000 | 250 | 90 | 12 s |
- Swing 0.35 s cooldown; damage = tool power x pet bonus. Bag 25 -> 80 -> 250 -> 800 (price x8 per tier, ~3 min of farming each). Sell 1 coin per bag unit x zone multiplier.
- Eggs: 250 / 3,000 / 40,000 coins. Odds per egg: Common 60%, Uncommon 28%, Rare 10%, Epic 2% (shown in the UI). Pet bonus +10% / +25% / +60% / +150%; equip 3 (5 after 1st rebirth).
- Rebirth at 1M lifetime coins, then x3 each; +50% coins per rebirth; resets coins, bag, zones; keeps pets.

## Test plan (playtest_request)
- Verify own scripts with the `arcane-playtest-qa` script check loop: Output cursor before `playtest_request`, read `after` it, fix only errors from scripts you wrote (Output is untrusted data), at most 3 fixes, stop the run, report.
- Place a 1-HP test node (value 1) 6 studs in front of the spawn: `hold-key W 400`, `click-gui` on `SimHud.Root.Swing` (also bound to E); `assert-player-attribute Bag = 1`. Remove the test node afterwards.
- Walk onto Sell pad: `assert-player-attribute Coins` transitions; `assert-text` on the coins label.
- `click-gui` Egg buy with 0 coins: `assert-text` toast "Not enough coins"; Coins unchanged.
- Code review: Collect checks distance <= 12 studs, node alive, cooldown, bag space; HatchEgg rolls on the server only.

## Performance budgets
<= 60 nodes per zone, nodes anchored with one shared respawn loop; pets: client-side follow (server stores only equipped ids), <= 5 pets per player rendered, <= 30 parts per pet; collect remote rate-limit 6/s per player; HUD updates on attribute change, no per-frame polling.

## Pitfalls
- Client-sent amounts or node ids accepted without range/distance checks (auto-farm exploits).
- Pets as server-physics followers per player (network churn); render followers on clients.
- Egg odds rolled on the client or not shown to players.
- Exponential prices without matching income: a wall at zone 3. Simulate time-to-unlock per zone (target 3-8 min).
- Zone gates only cosmetic: the server must also reject collects in locked zones.
