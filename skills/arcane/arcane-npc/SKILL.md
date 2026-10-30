---
name: arcane-npc
description: "Build believable Roblox NPC behavior and navigation with observable perception, bounded planning and recovery when routes fail."
license: MIT
---

# NPCs with readable roles and recoverable behavior

Start with the NPC's purpose in this game: threat, companion, merchant, quest giver, worker, crowd or opponent. A shopkeeper needs useful interaction and clear availability, not an unnecessary combat AI. For a complete world, vary meaningful roles, routes, encounter conditions and responses; duplicated bodies with different colors are not a living population.

## Perception and decisions

Specify what each role can perceive, how it selects a target/task, what actions it can perform and when it gives up. Use a small observable state model or behavior structure with reasons for transitions. Keep omniscience, teleport correction and instant input reactions out of ordinary behavior unless the game intentionally exposes those powers. Seeded timing/personality can vary encounters without making failures unreproducible.

Combat perception needs actual distance, visibility/occlusion, target eligibility, memory and disengage rules. Social/quest roles need an interaction session, current dialogue/task node, distance and duplicate action checks. A client selecting a choice or showing an animation cannot grant a reward, complete a quest or decide a catch. Expose enough state for debugging without leaking hidden tactical information to players who should not have it.

## Navigation is part of the design

Check agent dimensions, doors, slopes, jump/traverse rules, dynamic blockers and streamed geometry against the actual routes. Replan when the destination or path becomes materially invalid, with a bounded cadence; never compute every agent's path every frame. Keep waypoint completion, stalled movement and unreachable goals distinct. Recovery may wait, choose an alternative or disengage; it should not tunnel through authored obstacles or reset every NPC to spawn invisibly.

Own perception/path/animation tasks by NPC lifetime and state epoch. Target loss, death, despawn, map unload and replacement cancel their old callbacks. Sleep distant actors where it preserves the game, cap active populations and stagger work; wake-up must restore a coherent role rather than replay expired attacks. Server decisions and client cosmetics should agree on where danger or interaction exists.

## Give behavior a body and a voice

Use the actual rig, scale and navigable footprint. Idle, locomotion, turn, action and reaction should communicate state; verify exported animations rather than assuming asset availability. Head/look behavior, foot contact, positional cues and dialogue presentation need restraint and timing. Merchant prompts show price/eligibility, companion indicators explain waiting, and threats telegraph attention before damaging. Use authorized media and the relevant character/rig/audio skills; missing speech or animation is a reported gap, not a fabricated asset ID.

## Acceptance

Exercise blocked doors, narrow passages, target loss, unreachable destinations, crowded encounters, late joins and prolonged rounds. Record stuck time, path work and transition reasons. Observe a full interaction/encounter, including interruption and recovery, from the player's camera. Test different archetypes in their actual locations and repeat after respawn/map reset. Synthetic path/state fixtures prove bounded logic; representative players and real navigation are needed before calling behavior believable or human-like.
