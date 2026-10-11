---
name: arcane-inventory
description: "Build server-owned Roblox items, hotbars, equipment and consumables with consistent replicated presentation and duplication controls."
license: MIT
---

# Inventory, equipment and item lifecycle

## Model identities and ownership
Distinguish item definition, owned instance, equipped slot and cosmetic variant. Decide which fields persist and which are round-local. The server validates grants, consumption, transfers and equipment; clients render the resulting state and request intent.

Define equip/use/drop/destroy transitions and behavior during respawn, death, disconnect and inventory-full cases. Replayed pickup or use must not grant a second item or consume twice. Physical loot representations need a single authoritative claimant.

Keep first-person presentation and world-held models synchronized with the equipped logical item. Preserve grip/attachment conventions and cleanup animation/effect state on unequip. Icons are actual item variants at readable scale, not an unrelated generic symbol.

## Verification
Test simultaneous pickup, rapid slot switching, repeated consumption, full capacity, respawn and save/load. Compare server-owned inventory with both UI and visible held item. Separate requested skins from gameplay stats. Do not add random crates or monetization when the brief only asks to repair an existing hotbar.
