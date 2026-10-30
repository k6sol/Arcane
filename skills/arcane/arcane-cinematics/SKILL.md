---
name: arcane-cinematics
description: "Create purposeful Roblox cutscenes and timed presentation with actual camera/animation/audio contracts, readable staging and reliable skip, interruption and return-to-play behavior."
license: MIT
---

# Sequences that return control cleanly

## Define the purpose and beats
Determine what the sequence must teach, reveal or celebrate, its duration, player eligibility, control policy and skip behavior. A full-game introduction should lead into an actionable first objective; a small interaction needs only its useful beat. Do not turn every spawn or prop into a cutscene.

Stage an establishing view, readable action/detail and an intentional transition into play as needed. Plan subject, eye-line, screen direction, camera path and focal change before decoration. Preserve the project's style and avoid hiding missing gameplay behind a long showcase. Do not add unrequested people or scale figures.

## Build a real timeline
Bind beats to named actors/props, camera poses, verified animation clips, relevant sound/captions and actual gameplay phase. Author original Blender geometry, UV/PBR and motion where needed through available routes; static mesh conversion does not imply animated import support. Use only user/project-owned or expressly authorized external media, never invented IDs or unrequested free assets.

Choose a single clock and explicit event ordering. Define what occurs on start, at each beat, on completion and on interruption; do not accumulate drift through unrelated chained waits. Use bounded load/fallback behavior when a clip, image or sound is unavailable. Keep authoritative eligibility/phase and rewards on the server while local presentation follows the accepted state. Late joiners need an explicit join-at-time, abbreviated or bypass policy rather than restarting the whole server sequence.

Camera moves should support the action: avoid intersections, accidental cropping, abrupt unwanted roll and excessive shake. Keyframe/bake only supported channels and verify markers rather than assuming export retained them. Synchronize essential cues with actual accepted events; cosmetic timing is not server authority.

## Own and release presentation
Capture the prior camera and input state and define a single cleanup path for finish, skip, death, respawn, cancellation and replaced actors. Restore only state the sequence still owns; do not overwrite a newer controller's camera. Cancel delayed cues and disconnect listeners so skipped events cannot fire afterward. Server completion/reward decisions must not depend on trusting a local skip report.

If the project explicitly uses image/audio packages instead of video, retain that product rule; do not present it as a universal platform limitation. Respect reduced-motion, caption and volume options when relevant.

## Acceptance
Run the actual start-to-gameplay path and observe the first controllable action after completion. Test skip during early/late beats, death/respawn, a missing media item and the intended late-join policy. Check camera restoration, input release, no double rewards, no delayed audio/VFX and no orphan tracks.

Inspect engine frames at the real aspect ratios for subject visibility, readable captions and safe-area placement. Measure sequence duration and important cue offsets against the timeline; a timeline preview alone is not synchronized runtime evidence. Use the supported human-approved playtest flow and actual status/observations, respecting capture limitations. State untested paths and unresolved media ownership/import limits instead of claiming a cinematic is complete from one attractive shot.
