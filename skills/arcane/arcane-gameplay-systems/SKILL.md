---
name: arcane-gameplay-systems
description: "Compose server-authoritative Roblox mechanics into working player journeys with explicit state, rewards, UI, animation, feedback and recovery contracts."
license: MIT
---

# Build connected gameplay systems

## Extend the real project
Inspect existing scripts and state owners before creating another currency, inventory, round or save module. Define the requested action, trusted state, transition rules, denial cases, presentation and cleanup. Use `arcane-luau-architecture`, networking and remote-security guidance; a client sends intent, not a price, damage amount, reward or accepted outcome.

Keep configuration shared but server decisions authoritative. Use typed modules with an explicit initialization/teardown owner and bounded per-player/character/round work. Create scene references through supported tools; write scripts with `script_update` and keep them disabled until the actual verification/activation path permits use. Do not claim unsupported object creation or arbitrary evaluation. Saving needs the actual persistence scope and failure policy, not an assumed successful load.

The [existing recipes](references/recipes.md), loadable as `arcane-gameplay-systems:recipes`, illustrate module boundaries. They are not a complete game's integration proof. Adapt timings, counts, names and rates to the brief and measured workload instead of treating example constants as engine requirements.

## Compose the loop
Maintain a transition table: current state + validated intent → next state + authoritative effects + published presentation. Each effect has one owner and a duplicate/late-event policy. Carry a round/action generation so old callbacks cannot affect a later lifetime. Replicate meaningful changes; do not send a remote every frame merely to animate a UI.

- Rounds: waiting/start/active/results/reset, minimum-player policy, late joins, ties, disconnects, early finish and exactly-once rewards. Give each map/mode real spawn/objective/cleanup bindings; a loop over a single arena is not completed content variety.
- Checkpoints/objectives: validate legal sequence and reachability, bind progress to the correct player/run, recover after death and distinguish session progress from approved persistence. Test skipping, duplicate touches and respawn before the character is ready.
- Currency/shop/inventory: one balance/item owner, bounded IDs/counts, eligibility and capacity checks, atomic grant/debit and recoverable failure. A purchase button, sound or receipt callback alone is not an awarded item. Keep Robux receipt processing in its dedicated skill.
- Movement/stamina/health: server-approved state and limits with responsive client presentation, respawn reset, cancellation, conflict handling and workload-derived update cadence. Couple actual movement/action state to animation, camera, audio and UI without letting the feedback grant authority.
- Keys/doors/dialogue/quests: validate current interaction state, distance and ownership; define repeat use, simultaneous players, unavailable content and reset. A door needs a real hinge/collision path; dialogue choices must execute legitimate outcomes and reject stale choices.
- NPC behavior: use the character/NPC skills for rig, navigation, perception, stuck recovery, animation and lifecycle. A moving dummy is not a completed enemy or companion.

## Wire presentation to actual outcomes
For every important action specify anticipation, accepted/denied/pending state, impact/result and recovery. Bind HUD values to authoritative changes; show useful empty/error states and support keyboard/touch/gamepad as required. Relevant animation, particles, trails, sound and camera response need real assets/events and lifetime cleanup. Do not hide missing audio behind empty IDs or call unconnected hooks finished. Respect accessibility and reduced-motion needs.

## Verify end to end
Use actual supported playtest assertions and Output reads for the same project/version. Exercise join→act→succeed/fail→retry→death/respawn→exit, plus duplicate, invalid and late inputs. Check UI state, rewards, world effects and cleanup together. Use representative multi-client tests where available and label them unverified otherwise. Repair within the host's actual allowance; do not invent three unlimited extra attempts. Missing scripts, imports, enabled state or native evidence stay pending rather than becoming a success message.
