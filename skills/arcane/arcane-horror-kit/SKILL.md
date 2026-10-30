---
name: arcane-horror-kit
description: "Prescriptive horror genre kit: atmosphere and lighting moods, positional audio stingers, a stalker chase AI, jump-scare pacing, objectives and safe saves, with build order, tension numbers, budgets and playtest plan."
license: MIT
---

# Horror: readable threat, authored tension and a way through

Use horror only when the user requested it. Identify the intended fear, audience, camera and limits on intensity. A full horror game needs an understandable objective, discoveries, changing pressure, fair failure/retry and a resolution; one dark corridor and a timed jump scare are a first experiment, not a complete experience. Preserve the chosen style instead of making every horror project the same stalker forest.

Read [patterns](references/patterns.md) (`arcane-horror-kit:patterns`) for retained director/perception/effect fragments. Compose `arcane-npc`, `arcane-characters`, `arcane-level-design`, `arcane-audio`, `arcane-vfx`, `arcane-interface` and accessibility. Sample scare timing/lighting values are hypotheses, not required formulas for fear.

## Lay out information and escape

Design the player's objective, what evidence teaches it and how risk changes along the route. Use purposeful rooms, connected routes, landmarks, sightlines and safe recovery. A key must lead to a useful reachable lock; a chase must give readable choices rather than an unavoidable dead end. Different locations should develop the story/mechanic, not repeat the same fuse search in recolored rooms. Match content breadth to the brief without arbitrary room counts.

Block out visibility, movement, interaction and threat navigation before detailed decay. Preserve a readable baseline on actual target displays: total darkness, occluding fog or constant camera noise is not tension. Original architecture/props and grounded material detail support the chosen setting. Custom Blender work requires actual authoring capabilities and workspace permission; unsupported asset features stay explicit. Toolbox and third-party free assets are not default substitutes.

## Threats and objectives with counterplay

Keep objective/item state, perception, director scheduling and client presentation separate. Server-owned catches, pickups and hiding eligibility check actual distance, current state and target. A client Hidden flag or scare animation does not decide safety. Define what the threat hears/sees/remembers, how it investigates, when it searches/disengages and what the player can learn. Own delayed scares/path work by scene/character epoch; death, escape, unload and cancellation must not leave controls anchored or a stale scare active.

Tension should have contrast and relief. Use authored event conditions and cooldowns; random timing alone is weak pacing. Repeating a trigger should not repeatedly punish the same player. Cooperative play needs explicit item sharing, door state, catch/revive and spectator/rejoin rules. Requested chapter/checkpoint saves preserve genuine progress and failed-load safety; do not add persistence or paid recovery unasked.

## Sound, animation and acceptance

Prioritize positional cues, intelligible objective/interaction prompts, threat tells and subtitles. Vary ambience, silence and stingers without deafening peaks; provide motion/flash alternatives and restore owned camera/audio state after interruption. Use actual authorized sound/animation IDs, never invented ones. The HUD can be quiet while still explaining the next action, battery/resource limits and retry.

Build through current scoped tools, exact source baselines and reviewed disabled scripts. Request finite playtests for separate human approval and follow status through input release/owned stop/restoration. Prove a real objective chain, detection/escape/catch, checkpoint retry and completion, then observe pacing without developer narration. Check hiding while seen, blocked routes, repeated triggers, concurrent players and low-frame-rate readability. A scare-frame assertion or source review does not prove suspense, navigation or chase fairness. Report untested media, threat behavior and remaining chapters rather than labelling an atmospheric blockout finished.

## Tool integration

Use scene_build for measured routes, doors, hiding/interaction hosts and authored lighting/effects. Keep threat perception and damage authoritative; connect the actual NPC rig, animation, audio and GUI states. Test both a quiet route and the escalation/recovery path.

Use script_update for complete disabled source and script_set_enabled only through its exact syntax/review gate. Follow the `arcane-playtest-qa` script check loop: playtest_request, playtest_status and playtest_cancel retain the actual host repair/cleanup allowance. Existing requested saves use arcane-datastore-safety and the project's single writer; keep session lock, UpdateAsync and failure handling intact. Load this kit's declared patterns only when needed; its fragments are not a finished game.
