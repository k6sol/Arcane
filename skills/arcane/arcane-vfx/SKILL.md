---
name: arcane-vfx
description: "Build Roblox effects tied to real game events with coherent style, pooling/lifecycle controls and device-tested readability."
license: MIT
---

# Readable and bounded VFX

## Give each effect a purpose
Identify the event, location, direction, duration and information conveyed. Build anticipation, impact and aftermath only when the mechanic needs them. Match the project's shape/color/motion language rather than adding a generic expensive burst.

Separate cosmetic effects from damage/state authority. Effects follow acknowledged or reconciled predicted actions. Use bounded emission, pooling where beneficial and deterministic cleanup on cancellation/respawn. Avoid full-screen noise that hides threats or accessibility-relevant cues.

Measure overdraw, lights, lifetime and concurrent peak load in the representative scene. Source Blender simulation is not automatically a viable Roblox runtime effect; bake/convert using a supported route when required.

## Verification
Test multiple concurrent effects, interrupted actions, low frame rate and selected motion/flash options. Check both owner and observer views. A successful render does not establish runtime cost or effect lifecycle. Preserve the user's requested restrained style when it fits the game.
