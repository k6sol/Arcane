---
name: arcane-characters
description: "NPCs and characters that look and behave well: R15 rigs from HumanoidDescription, default animations, AnimationController creatures, pathfinding, idle/patrol/chase/attack/flee state machines, ProximityPrompt dialogue, a pet or follower that follows the player, network ownership and server authority."
license: MIT
---

# NPCs and characters

Compiled code: `skills_get` ids ["arcane-characters"], allowExperimental true, one reference at a time: `arcane-characters:npc-rig` ([npc-rig](references/npc-rig.md): spawner, Animator blending, throttled manager), `:npc-ai` ([npc-ai](references/npc-ai.md): pathing Mover, state Brain), `:dialogue` ([dialogue](references/dialogue.md): server + UI client), `:pets` ([pets](references/pets.md): saved pets, followers).

## Rigs
- Server Script: `Players:CreateHumanoidModelFromDescription(desc, Enum.HumanoidRigType.R15)` gives a full R15 Model (Motor6Ds, Humanoid); `PivotTo` a marker, parent to `workspace.NPCs`.
- `scene.characters` lets `scene_build`/`scene_create` make only `Humanoid`, `HumanoidDescription` (colours, scales; e.g. in `ServerStorage.Looks`), `AnimationController` and `Animator`. No joints, so a parts Model is not a walking rig. ProximityPrompt, PathfindingModifier and PathfindingLink come from scripts.
- One palette per role. Clothing/accessory ids only from the user or `studio_asset_search`; a Creator Store `R15 rig` only on request.

## Animation
- Never invent animation ids. Verifiable R15 `Animate` defaults: idle 507766666, walk 507777826, run 507767714, jump 507765000, fall 507767968, climb 507765644; confirm via `character.Animate.walk.WalkAnim.AnimationId` in a playtest. Otherwise (custom/R6 packs, attacks, emotes) ask the user for ids, or use TweenService on a welded anchored root.
- `LoadAnimation` once per clip on the `Animator`; priority Idle < Movement < Action; blend walk/run with `AdjustWeight`, `AdjustSpeed(speed / 16)`.

## Pathfinding
- `PathfindingService:CreatePath` with `AgentRadius`/`AgentHeight` sized to the rig, `Costs` (`Danger = math.huge` modifiers). `pcall` `ComputeAsync`; only `PathStatus.Success` continues. `PathWaypointAction.Jump` jumps; re-issue `MoveTo` before the 8 s `MoveToFinished` timeout; `path.Blocked` ahead of the current waypoint replans.
- Stuck detection: < 1 stud in 1.5 s -> jump + replan; 3 times -> Return home.

## States
| State | Leave |
|---|---|
| Idle | 2-4 s -> Patrol; target seen (40 studs, 120 degree cone, clear Raycast) -> Chase |
| Patrol | `Waypoints` parts in order; seen -> Chase |
| Chase | in 5 studs -> Attack; lost 3 s -> Return; Health < 30% -> Flee |
| Attack | 1.2 s cooldown, server `TakeDamage` after its own reach check |
| Flee | 30 studs away, then Return -> Idle |
The server decides perception, damage, rewards and dialogue outcomes. Clients only display them.

## Dialogue and pets
- Server `ProximityPrompt` (Talk, 10 studs, HoldDuration 0); panel via `scene_build` (`arcane-interface`); the server tracks each player's node and validates choice index and distance (`arcane-gameplay-systems`).
- Pets save only `{ kind }` under server uids in the session-locked profile (`arcane-datastore-safety`), capped; bonuses come from saved data.

## Performance and ownership
- `SetNetworkOwner(nil)` on NPC parts (pcall); a cosmetic pet may be player-owned.
- One Heartbeat manager: 0.1 s ticks near players, 0.75 s far, sleep beyond 250 studs; at most 4 path computes per frame; ~20-30 moving Humanoids per server.
- StreamingEnabled: `ModelStreamingMode` Atomic; client code handles NPCs streaming in/out (CollectionService), never waits forever.
- Perception design `arcane-npc`; Blender creatures `arcane-rig-animation`.

## Verify
Enable with `script_set_enabled` after review. Test NPC 12 studs ahead; `playtest_request` (`hold-key` W, `hold-key` E) and `assert-player-attribute` TalkedTo or ChasedBy. Then the `arcane-playtest-qa` script check loop (at most 3 fixes). Report flee, respawn, pet rejoin and load as untested unless checked.
