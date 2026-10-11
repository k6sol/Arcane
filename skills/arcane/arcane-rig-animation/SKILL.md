---
name: arcane-rig-animation
description: "Author and validate Roblox rig conversions, animation clips, grips and transitions in Blender and on the actual runtime rig."
license: MIT
---

# Rigs, clips and motion integration

## Lock the rig contract first
Capture hierarchy, joints/rest transforms, root conventions and intended character family. Use tested basis conversions for static props, Motor6D rigs and skinned assets separately. A matching visual pose in Blender does not establish matching joint frames.

Define clips by action purpose, timing, loops, priority and interruption behavior. Block and review motion before polishing curves. Keep foot contact, weight, silhouette and weapon alignment readable. Motion design is distinct from authoritative hit/gameplay timing.

Bake only supported channels and verify any markers required for runtime events survive the chosen path. Keep local sequences/artifacts when publishing fails. Update logical clips without deleting unrelated animation/controller state.

## Verification
Use neutral pose, single-joint rotation, root movement, a loop and representative attack/use fixtures on each advertised rig type. Test transitions, respawn/unequip and weapon grips in Studio. State unsupported metadata or publication paths instead of silently dropping them.
