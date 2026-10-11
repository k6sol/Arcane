---
name: arcane-cinematics
description: "Build Roblox cutscenes, introductions and timed media with camera ownership, synchronized playback and interruption-safe gameplay transitions."
license: MIT
---

# Playable cinematics and broadcast sequences

## Define what the sequence must accomplish
Capture duration, story/action beats, player control, skip policy and transition into play. Make each frame purposefully staged; do not hide the game behind a long pre-render-like sequence. Preserve requested style without applying analog static to every project.

Use a timeline tied to actual camera, animation, image/audio and state events. Asset loading failure needs a bounded fallback. Give clients local presentation while server phase/eligibility remains authoritative.

Save and restore camera/input ownership on skip, death, disconnect or cancellation. Check framing of characters/items and avoid visible cropped or floating geometry. A preview timeline and the runtime sequence are separate evidence.

## Verification
Test start-to-gameplay, skipped and interrupted paths, missing audio/image and late joining. Inspect actual engine frames and synchronization. For projects using image/audio packages instead of video, preserve that rule explicitly; it is not a universal Roblox limitation.
