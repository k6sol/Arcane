---
name: arcane-physics
description: "Implement stable Roblox vehicles, moving mechanisms and physical interactions with assembly-aware constraints, deliberate authority, responsive feedback and recoverable failure states."
license: MIT
---

# Engineer the physical mechanic, not just its shape

## Choose the minimum faithful simulation
Define the player action and measurable response: force/motion, contact, control, success/failure and reset. Decide which behavior needs physics and which is better represented by authoritative state plus kinematic/cosmetic motion. Preserve the requested mechanic; replacing a vehicle with a tweened prop is not equivalent.

Inspect real assemblies, pivots, attachments, anchored parts, collision geometry and scale before adding forces. Identify which parts must collide, which are decorative and which belong to one rigid assembly. Align attachment frames and constraints deliberately; extreme torque or density should not hide a broken joint or an anchored/unanchored conflict. Verify current supported APIs instead of mixing deprecated movers with guessed replacements.

## Separate simulation ownership from game authority
Choose network ownership for responsive controllable assemblies and define handoff when a driver leaves, changes seat, dies or disconnects. Revalidate control requests server-side. A client-owned position/contact is not sufficient proof of a finish, damage or reward; validate course/order, plausible movement and game state according to the mechanic.

For vehicles, implement usable acceleration, braking, steering, traction/air behavior, camera/input integration and recovery from rollover or leaving the play area. For doors/lifts/conveyors, define endpoints, occupancy/clearance, obstruction and cancellation. Tune values from mass, dimensions, desired response and observed stability rather than copying forces from a different-scale asset.

Use timestep-aware control and bounded work. Distinguish a force from an impulse and visual interpolation from authoritative motion. Avoid per-frame remote control of every part. Limit debris and repeated collision effects; sounds, wheel/lever animation and VFX should reflect the actual state without becoming the simulation owner.

## Make reset a state transition
Preserve the assembly's intended source pose and ownership. Reset stops owned inputs/forces/timers, releases occupants safely, restores valid placement and starts a new generation so old callbacks cannot act on it. Make recovery available to ordinary players where the game requires it. Do not leave a vehicle permanently unusable after one failure or spawn duplicates on each reset.

## Observe physical acceptance
Test sustained operation, slopes/obstacles or mechanism cycles, collision clearance, low frame rate, ownership change, driver exit, respawn and repeated reset. Inspect stability, controllability and final authoritative outcomes, not just an attractive model. Multiplayer latency/real engine behavior require actual permitted native tests; a mock solver, static screenshot or Blender mechanism does not establish them. Record tunable limits and remaining device/network evidence.
