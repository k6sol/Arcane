---
name: arcane-combat
description: "Implement Roblox melee or ranged combat with readable timing, server-validated outcomes, accurate queries and counterplay."
license: MIT
---

# Combat and hit detection

## Align action and outcome
Define windup, active, recovery, cancel and cooldown rules plus counterplay. Choose appropriate spatial queries and filtering for the actual weapon. Visual blade/shot motion, sampled hit volume and permitted damage window must agree; do not damage merely because an animation played.

The server validates eligibility, equipped weapon, action state, timing and target rules. Latency tolerance needs bounds and measurements, not unlimited client claims. Avoid repeated damage from one swing unless intentionally designed. Distinguish cosmetic prediction from authoritative hit confirmation.

Bind markers and attachments to a verified exported animation; do not assume a marker survived the chosen pipeline. Cleanup on unequip, death and interruption. Weapon breakage separates inventory state, animation, physical pieces and effects.

## Verification
Test whiffs, near edges, obstructions, multiple targets, duplicate requests, latency and interrupted attacks. Inspect actual hit volumes at game scale. Compare animation and authoritative event timestamps. Preserve genre-specific pace; do not force an elaborate combo system into a deliberately simple game.
