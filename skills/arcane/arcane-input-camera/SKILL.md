---
name: arcane-input-camera
description: "Build responsive Roblox keyboard, controller and touch input, camera and viewmodels with explicit focus and lifecycle behavior."
license: MIT
---

# Controls and camera

## Define the feel contract
List intended actions and states: gameplay, menu focus, text entry, spectator and cutscene if applicable. Map supported device inputs without assuming every player has a keyboard or pointer. Preserve rebindings/conventions when extending an existing game.

Separate authoritative requests from camera and cosmetic arm motion. Camera ownership must transfer and restore cleanly across respawn, mode changes and cancellation. Ensure a viewmodel uses the actual equipped item's grip and animations rather than clipping an unrelated model onto the screen.

Apply damping/spring motion deliberately and test at varied frame rates. Avoid excessive shake, obstruction, forced zoom or motion that defeats the user's accessibility preference. Input held during focus loss/unequip must not remain active.

## Verification
Test rapid mode switching, text-box focus, respawn, low frame rate and each advertised device. Compare action responsiveness and visible hands/items at actual field of view. A desktop screenshot alone is not evidence of touch/controller behavior.
