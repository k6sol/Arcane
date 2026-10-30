---
name: arcane-inventory
description: "Build server-owned Roblox items, hotbars, equipment and consumables with consistent replicated presentation and duplication controls."
license: MIT
---

# Items that agree across ownership, UI and the world

Start from the actions the game needs: collect, inspect, equip, use, craft, store or trade. Do not add a large item grind to a small hotbar repair. For a full game, design an item roster with distinct uses, readable silhouettes and acquisition paths; several names sharing the same behavior do not provide meaningful equipment variety.

## Model the lifecycle

Separate item definition, owned instance, stack quantity, equipped slot and cosmetic variant. Stable instance IDs belong to owned items; a UI index is not authority. Decide what persists, what resets per round and what happens on death, respawn, disconnect, inventory-full and failed loading. Data definitions hold icon/model/animation references and allowed actions; server-owned state holds actual ownership and quantities.

Define pickup -> owned -> equipped -> use/consume/drop/destroy transitions. A physical pickup has one claimant even when two characters touch it together. Repeated pickup/use intents cannot duplicate a grant or consume twice. Validate exact item identity, current owner, usable quantity, slot compatibility, action cooldown and game state on the server. Client UI requests intent and reconciles to the actual result; optimistic feedback must not show a permanent grant after refusal.

Choose full-capacity behavior before rewards are wired: decline with the loot retained, reserve a real delivery slot, or use a bounded recoverable mailbox if the project implements one. Never mark a quest reward claimed and silently lose the item. Trading spans a separate durable protocol (`arcane-trading`); moving two inventories in memory is not crash-safe transfer. Save migrations preserve unknown/old items according to an explicit recovery rule rather than replacing a failed profile with defaults.

## Presentation that supports decisions

Build hotbar selection, inventory grid, details, compare/equip/use controls, capacity state and empty/locked/unavailable feedback appropriate to the loop. Separate gameplay stats from skins. Icons depict the actual variant at readable size, and descriptions explain the consequence of use. Support keyboard/controller/touch focus and avoid drag-only actions. Details should not cover the essential movement/combat view at small sizes.

An equipped logical item, third-person model, first-person view and animation must agree. Verify grip/attachment conventions with the actual rig/export; do not assume an animation marker or uploaded asset exists. Cleanup weapon trails, aim camera, sounds and input bindings on unequip/death/interruption. Re-equip should not stack listeners or leave a ghost model. Use readable pickup/use/denial cues without showering every quantity change in effects.

## Acceptance

Compare server-owned inventory with the visible held model and GUI after each transition. Exercise simultaneous pickup, repeated consumption, rapid slot changes, zero/full capacity, invalid definitions, denied equipment, death/respawn and requested save/rejoin. A reward interrupted between ownership change and presentation must recover without duplication or loss. Test the actual item functions, not merely that the grid renders. Report missing real rig/animation/icon IDs and untested persistence or multiplayer cases; a populated catalog is not proof that every item works.
