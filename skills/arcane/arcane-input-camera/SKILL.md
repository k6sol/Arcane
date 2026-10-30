---
name: arcane-input-camera
description: "Build coherent Roblox action input, camera and viewmodel systems across keyboard, controller and touch, with focus, accessibility and lifecycle-safe ownership."
license: MIT
---

# Make controls readable, responsive and reversible

## Start from actions and game modes
List semantic actions and states: movement, primary interaction, secondary action, menu, text entry, spectator and cutscene as relevant. For each supported device, define bindings, analog/digital behavior, hold versus toggle and visible prompts. Extend existing conventions and settings; do not invent a keyboard-only interface for a game advertised for touch/controller.

Map actions through the project's actual input layer. Keep UI navigation/activation and gameplay activation coordinated so one press does not both buy an item and fire a weapon. Respect consumed input and text focus. Release held actions on focus loss, menu takeover, unequip, death and disconnect. Rebinding must update both dispatch and prompts, including touch layout where supported.

## Separate presentation from consequence
Input controllers send intent to authoritative systems. The camera and local animation may respond immediately, but confirmed hit/reward/equipment state comes from the relevant owner. Show pending/denied feedback when a consequential action can fail. Keep action cadence and server cooldown consistent without treating the client cooldown as enforcement.

Define an explicit camera owner and priority/handoff policy. On a temporary mode, save the relevant previous state and restore it only if that mode still owns the camera. Respawn or another controller taking over must not be overwritten by a late cutscene cleanup. Keep camera obstruction, zoom, field of view, aiming and spectator transitions deliberate.

Use frame-rate-aware smoothing or a tuned spring with clear units, not a fixed per-frame lerp that changes feel with FPS. Clamp extreme deltas after stalls appropriately. Camera shake, sway and bob need controllable intensity/reduced-motion behavior. Important information must remain legible during motion.

## Bind the actual avatar and equipment
A viewmodel uses the equipped asset's real grip, attachments, animation states and field of view. Align hands, muzzle/interaction point and UI reticle; do not attach an unrelated placeholder and claim a completed first-person system. Coordinate animation markers, audio and VFX without letting a cancelled track emit a stale gameplay action. Clean up each character/equipment generation and its connections.

## Acceptance is interactive
Test advertised devices, analog extremes, rapid mode switching, typing in a text box, opening/closing menus while holding input, respawn, unequip and low FPS. Check camera restoration and absence of stuck movement/fire. Compare screen readability and item clipping at actual aspect ratios/FOV. A desktop screenshot verifies neither touch reachability nor controller focus; name unsupported device evidence rather than simulating a pass.
