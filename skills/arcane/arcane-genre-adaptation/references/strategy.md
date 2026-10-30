# Strategy / tactical management

The player allocates scarce resources, reads information and commits to a plan against an opponent, system or objective. Choose turn-based, real-time, defense, squad tactics or management deliberately. More units and panels do not create depth if one obvious action dominates everything.

## Decisions, information and content

First prove a bounded encounter with understandable counters and two viable approaches. A full brief needs the requested factions/units/scenarios, a coherent start/result/retry flow and meaningful progression or campaign only where appropriate. Different encounters should change terrain, timing, resource access or objectives rather than simply add enemy health. Set content scope from the brief, not a universal campaign length.

Separate simulation authority, definitions, orders, visibility and UI. Validate current actor/ownership, resources, target, turn/phase and order identity on the server. Queued commands, cancellation, simultaneous completion and stale turns cannot charge or act twice. Hidden information should not leak through client snapshots. AI uses the same declared constraints or a disclosed difficulty model, not unexplained omniscience. Save/replay snapshots need an actual versioned deterministic contract if requested.

## Communicate the plan

Selection, reach/range, affordances, cost, consequence preview and invalid-order reasons must be readable at game scale. Unit silhouettes, movement/attack animation, positional effects and restrained sound communicate state without burying the tactical map. Keyboard/controller/touch selection needs alternatives to tiny drag targets. Use actual original/authorized units and media, and measure the intended simultaneous unit/projectile/path load before claiming performance.

Test resource shortages, duplicate/cancelled orders, fog/visibility, blocked movement, turn timeout, disconnect and win/loss/reset. Play contrasting strategies and observe whether players can predict consequences and explain counters. Distinguish deterministic simulations from real participant pacing and large-battle performance. `arcane-rounds`, economy, NPC, networking and interface guidance compose the actual system; a bot defeated in one small scene is not a balanced strategy game.
