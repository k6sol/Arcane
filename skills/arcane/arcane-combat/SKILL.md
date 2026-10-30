---
name: arcane-combat
description: "Implement Roblox melee or ranged combat with readable timing, server-validated outcomes, accurate queries and counterplay."
license: MIT
---

# Combat where the visible action matches the result

Choose the encounter language first: deliberate melee commitment, rapid ranged positioning, cooperative abilities or another requested style. Define the decisions and counterplay before building a weapon catalog. A full combat game needs encounters that make different actions valuable; inflated health and reskinned weapons alone do not create variety. A single weapon fix should preserve the user's pace and existing controls.

## One action timeline

Specify anticipation, windup, active window, recovery, cooldown, cancel and interruption rules. Align animation, attachments, sampled hit volume and damage timing at actual game scale. A sword animation playing is not a hit; a tracer is not proof of damage. Bind animation markers only after verifying the actual exported/available asset and marker names. Choose spatial queries, filtering and occlusion appropriate to the weapon, avoiding repeated damage to one target from the same swing unless intentionally designed.

Server validation includes equipped weapon/ability, actor alive and eligible, current action state, resources/ammo, rate, target/team rules and plausible origin/range. Reject nonfinite or impossible intent before queries or mutation. Track a bounded action identity for replay prevention. Cosmetic prediction may start promptly, but reconcile denial, interruption and actual hit confirmation without double effects. Latency allowance is measured and bounded; do not trust client hit lists or allow shots through present cover merely to make combat feel generous.

## Compose encounters and feedback

Give enemies readable tells, vulnerable windows, disengage behavior and an escape/defense option. Tune reach, movement and cooldown together; a beautiful attack with an unavoidable hit is poor counterplay. Distinct archetypes should change spacing or priorities rather than all charge directly. Cooperative mechanics must specify credit, assists, simultaneous kills and friendly fire. Death, downed/revive, respawn and loadout restoration belong to the actual mode (`arcane-rounds`, `arcane-inventory`).

Separate authoritative health/ammo/action state from presentation. The HUD shows resources, cooldowns and confirmed outcomes without cluttering aim or movement. Coordinate impact sound, restrained shake, contact effect and hit animation around the same confirmed event. Provide readable denial/empty-ammo cues and motion/flash alternatives. Do not invent animation or sound IDs; use owned/authorized assets and report unavailable media honestly. Unequip, death and interrupted abilities release trails, sounds, camera changes and input listeners.

## Prove the dangerous edges

Test whiffs, edge contacts, walls, overlapping targets, repeated packets, rapid weapon switching, latency, reload/cancel and death during the active window. Inspect actual hit volumes and compare animation/action/server timestamps. Test an entire encounter through victory or defeat and retry, then a different encounter requiring another decision. Count ongoing effects, projectiles and query work under the intended player/NPC load. Use authorized playtest evidence for what the scenario can actually perform; report unscripted multiplayer/aim/animation timing as untested. No collection of source snippets establishes fair competitive combat.
