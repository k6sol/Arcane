---
name: arcane-rig-animation
description: "Author and integrate Blender rigs and purposeful animation clips with verified joint frames, deformation, timing, grips, transitions and interruption-safe runtime behavior."
license: MIT
---

# Motion that fits the rig and the game

## Lock the rig and action contracts
Read the real skeleton/joints, rest transforms, root, units, axes and supported import path. Treat static props, Motor6D rigs and skinned meshes separately. Matching a Blender pose does not prove compatible joint frames, and a static GLB converter does not imply animation support. Preserve existing controllers and unrelated tracks.

Define the clips the requested gameplay actually needs. For a full character this may include idle/locomotion, jump/fall and relevant use/combat/reaction states; a door or prop needs only its real motion. Specify duration, loop or one-shot behavior, root motion versus in-place, priority, interrupt conditions, grip points and marker meaning. Coordinate anticipation, active interaction and recovery with gameplay without making client animation the authority for damage or rewards.

## Author and review
Build original geometry, UVs/PBR and rig source in Blender where authoring is required. Check rest pose and joint orientation with isolated single-joint rotations before a complete clip. Place deformation loops where bending matters; test weights at shoulders, hips, elbows/knees or the equivalent creature joints. Detect collapsing volume, detached pieces, twisted limbs and mirrored axes early.

Block key poses and weight shifts, then timing/breakdowns, then curves and secondary motion. Ground feet during planted phases; align locomotion speed with actual travel to avoid sliding. Check arcs, balance, hand/weapon contact and readable anticipation rather than filling every channel with noise. Mechanical motion should honor hinges and hard stops; organic motion needs purposeful spacing and overlap, not a universal interpolation rule.

Keep named actions and clean frame ranges. Bake only channels/constraints the verified export consumes and inspect exported samples. Verify required runtime markers survived; if unsupported, preserve the artifact and state the gap instead of silently dropping event timing. Never invent animation IDs or imply upload/moderation succeeded.

## Runtime integration
Load verified clips through the actual controller/Animator and reuse tracks. Define transitions and blending so movement, action and reactions do not fight. Clean up tracks, marker callbacks and delayed effects on interrupt, unequip, death, respawn and character replacement. Attachment/grip orientation must be checked on both the actor and held item.

For camera animation or cosmetic secondary motion, coordinate ownership with the camera/cinematic controller. Server-owned gameplay timing remains separate from the local visible pose. Unsupported publishing or rig metadata cannot be granted by loading this skill.

## Acceptance
Use neutral pose, single-joint rotation, root movement, a loop and a representative use/action on every advertised rig type. Inspect close deformation and the actual player-view silhouette. Measure clip length, loop seam, foot displacement during contact, grip alignment and transition timing against the contract.

Play start/stop, rapid state changes, interruption and respawn/unequip in the engine; confirm markers/effects occur once and no stale track survives. Record what was tested, the actual import/publication path and remaining unsupported states. A Blender preview, clip file or successful LoadAnimation call is not the full motion acceptance.
