---
name: arcane-characters
description: "Build original characters and NPC presentation that fit their gameplay roles, with a genuine rig, readable animation, server-owned behavior and tested dialogue/follower integration."
license: MIT
---

# Characters with a role, body and working behavior

## Define the character's job
Determine whether the request is a player appearance, ambient actor, enemy, quest giver, creature or companion. Specify silhouette, scale, personality, movement envelope, interaction distance and the gameplay facts it must communicate. For a full game, give important roles distinct readable shapes and motion while sharing the art direction. Do not add decorative characters or scale figures to unrelated asset tasks.

Author custom bodies, UVs, textures and PBR in Blender when needed; use a faithful available authoring route and retain source. A permitted existing platform rig/description can supply its actual supported skeleton. Clothing, accessories and animation IDs must come from the user, project or an expressly authorized source; never guess IDs or search Toolbox/free assets by default.

Inspect the real hierarchy and animation controller. scene.characters can create supported Humanoid/description/controller instances, but a parts Model without the necessary joints is not a walking rig. Static mesh conversion does not establish skinning or animation import support. Report an unsupported rig route rather than disguising a rigid tween as a completed walking character.

## Connect the visual and behavioral contracts
Use named root, joints, attachment/grip points, navigation size, collision and hit/interaction targets. Separate cosmetic motion from server decisions about perception, damage, rewards and dialogue choices. Character animation markers may drive local effects; they do not authorize damage from a client.

Build only the needed states, with explicit entry/exit and interruption: idle, travel, investigate, chase, attack, flee, return, talk or follow. Tune reach, cooldown, perception and home/leash distance for the actual role. Use path success, blocked-path replanning and bounded stuck recovery rather than assuming every MoveTo arrives. Reset targets and tracks on death, despawn and replacement.

Load verified clips on the actual Animator, reuse tracks, select priorities and blend locomotion by measured speed. Discover existing default animations from the actual rig rather than copying remembered asset numbers. Check grounded feet, turn behavior, attack anticipation and recovery. Custom creature and grip work belongs with arcane-rig-animation.

## Dialogue, companions and load
Dialogue needs a server-owned node/choice contract, distance/eligibility validation, a real GUI state and cancel/close behavior. Companions need follow spacing, obstacle recovery, spawn/despawn and only authorized saved state; cosmetic network ownership must not control bonuses or rewards.

Choose explicit server ownership for gameplay-critical NPC physics where supported; cosmetic ownership must not decide hits. Throttle AI/perception/path queries according to distance and measured population; use a manager and clean up tracks, connections and tasks. Handle streamed-out/replaced actors without indefinite waits. Load the existing declared [npc-rig](references/npc-rig.md), [npc-ai](references/npc-ai.md), [dialogue](references/dialogue.md) or [pets](references/pets.md) reference only for that mode; validate its assumptions against current capabilities and project state.

## Acceptance
With the supported human-approved playtest flow, observe the real actor moving through its route, encountering an obstacle, entering/exiting interaction and recovering after interruption. Check contact/hit timing, denied dialogue choice, loss of target, respawn and observer view where relevant. Measure a representative population, path failures and runtime errors. State exactly which states, rejoin/pet persistence or custom clips were not checked. A posed mesh, enabled script or decorative NPC is not functional character acceptance.
