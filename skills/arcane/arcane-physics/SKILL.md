---
name: arcane-physics
description: "Create stable Roblox physical interactions, mechanisms and vehicles with deliberate authority, constraints and recoverable states."
license: MIT
---

# Physics, vehicles and mechanisms

## Choose the simulation boundary
Determine whether the mechanic truly needs physics or a scripted visual/kinematic state. Define network ownership, collision groups, constraints, moving attachments and reset behavior. Use scale and mass deliberately; more detail is not necessarily more stable.

For interactable mechanisms, separate player input from authoritative state and cosmetic motion. For vehicles, specify acceleration/braking, steering, seat ownership, exit safety and lost-owner behavior. Do not trust client-controlled position as permission to grant a reward.

Inspect assemblies and pivots before adding constraints. Avoid anchoring conflicts and extreme forces used to hide a broken attachment. Keep expensive debris bounded, pooled or cosmetic where possible.

## Verification
Test collision/clearance, ownership changes, occupants leaving, resets and low-rate/latency conditions. Exercise repeated conveyor/door cycles or sustained vehicle operation. Report measured instability and tune it; a polished Blender mechanism does not prove an engine simulation works. Use a current capability check before claiming advanced physics features are supported.
