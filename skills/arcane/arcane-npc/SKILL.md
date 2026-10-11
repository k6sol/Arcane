---
name: arcane-npc
description: "Build believable Roblox NPC behavior and navigation with observable perception, bounded planning and recovery when routes fail."
license: MIT
---

# NPC perception and pathing

## Give behavior a readable model
Specify what the NPC can perceive, how it chooses a target, which actions are available and why it disengages. Use explicit states or a small behavior structure. Do not simulate intelligence with teleporting, omniscient tracking or instant input reactions unless the game clearly intends it.

Navigation considers agent dimensions, traverse rules, dynamic blockers and streaming. Replan on meaningful changes with a bounded cadence; do not compute paths for every NPC on every frame. Include stalled movement, invalid targets, unreachable destinations and despawn cleanup.

Vary decisions through seeded personality/timing where useful, but keep challenge fair and debuggable. A bot being difficult does not prove it acts like a human. Client cosmetics and authoritative perception must not disagree about where danger exists.

## Verification
Test doors/obstacles, narrow spaces, target loss, unreachable goals, multiple NPCs and prolonged rounds. Record stuck time, path work and readable state transitions. Review behavior with real players before advertising human-like skill.
