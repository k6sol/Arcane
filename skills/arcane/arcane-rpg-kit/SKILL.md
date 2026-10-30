---
name: arcane-rpg-kit
description: "Prescriptive RPG/adventure genre kit: quests, NPC dialogue, inventory, combat basics, XP and levels, enemy camps and session-locked saves, with build order, balancing curves, budgets and playtest plan."
license: MIT
---

# RPG and adventure: connected characters, quests and places

Establish the actual fantasy, audience, camera, party structure and main verbs. An RPG may emphasize exploration, dialogue, combat or crafting; do not force every quest into kill/collect chores. For a complete game, the first quest is a slice: deliver the requested journey, useful progression, varied encounters/discoveries and a meaningful ending or ongoing loop. A narrow quest bug does not authorize rebuilding the whole world.

Use [patterns](references/patterns.md) (`arcane-rpg-kit:patterns`) as retained content/state fragments. Connect `arcane-gameplay-systems`, `arcane-npc`, `arcane-characters`, `arcane-inventory`, `arcane-combat`, `arcane-world-building`, `arcane-interface` and requested persistence. Their responsibilities should fit one coherent player experience.

## Content with consequences

Write a compact content graph: characters with motives, locations with purpose, quest prerequisites, information/rewards and the changes they unlock. Mix investigation, conversation, traversal, resource use and conflict where the brief supports them. Branches should lead to observable consequences, not duplicate dialogue buttons. Stable quest/item/character IDs support references and migration; visible names and text remain localizable content, not hard-coded state keys.

Build navigable regions with recognizable landmarks, useful paths, return routes and readable danger. A new location should introduce a decision, revelation or encounter rather than only higher enemy HP. Match the requested breadth without inventing a universal zone count. Original art, props, character silhouettes, lighting and sound define the setting; do not substitute generic forest templates or Toolbox unless requested. Verify custom asset/rig/animation availability through actual supported capabilities and grants.

## Server state and interaction

Separate quest/dialogue progression, inventory/rewards, combat/enemy behavior and profile storage. The server advances objectives only from verified game events and the current quest step; clients cannot report trusted kills, pickups or completion. Dialogue sessions bind the actual NPC, current node, distance, eligibility and allowed choice. Repeated turn-in must not grant twice, and reward capacity must be resolved before marking a quest irrevocably done.

Define cooperative credit, death/respawn, abandon/retry, missing quest objects and reconnect. Requested durable quest rewards and inventory changes need the real profile/claim protocol; setting state='Done' in memory is not crash-safe award settlement. A failed load stays protected. Save meaningful safe progress rather than blindly restoring arbitrary coordinates into changed/streamed geometry. Keep optional commerce out unless requested.

## Playable presentation and proof

Provide objective tracking with useful destination/context, readable dialogue choices, inventory/equipment, health/resources where needed and a clear unavailable-action reason. Do not cover combat or force long text while a player is attacked. Actual idle/movement/attack/reaction animations, positional dialogue/ambience and restrained quest/reward effects communicate state. Use real authorized IDs; placeholders and silent NPCs are not completed character polish.

Inspect and build through current scoped scene/script tools, review disabled code and use separately approved finite playtests followed through cleanup. Traverse introduction -> accept -> complete real steps -> reward -> use reward -> later content, plus failure/retry. Test dialogue distance/invalid choices, duplicate progress, full inventory, shared credit and death during interaction. Review enemy navigation, encounter variety, requested save/rejoin and target-device GUI. A single scripted talk action proves that action only; report untested combat, story branches, content breadth and native media rather than claiming the full adventure is complete.
