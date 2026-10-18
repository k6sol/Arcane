---
name: arcane-characters
description: "NPCs and characters that look and behave well: R15 rigs from HumanoidDescription, default animations, AnimationController creatures, pathfinding, idle/patrol/chase/flee state machines, ProximityPrompt dialogue, network ownership and server authority."
license: MIT
---

# NPCs and characters

## Rigs and appearance
- Default: a server Script in ServerScriptService spawns rigs with the official API `Players:CreateHumanoidModelFromDescription(desc, Enum.HumanoidRigType.R15)`. It returns a complete R15 Model (HumanoidRootPart, Motor6D joints, Humanoid). Set `Name`, `PivotTo(marker.CFrame + Vector3.new(0, 3, 0))`, then parent it to a `workspace.NPCs` Folder. This is the most reliable path.
- Appearance comes from `HumanoidDescription`: body colours (`HeadColor`, `TorsoColor`, `LeftArmColor` ...) and scales (`HeightScale`, `WidthScale`, `DepthScale`, `HeadScale`, `BodyTypeScale`, `ProportionScale`). Give each role a distinct palette (vendor warm, guard steel blue, enemy dark red) so roles read at a glance. Set clothing, face or accessory ids only when the user gave them or `studio_asset_search` returned them.
- Direct classes (plugin with `scene.characters`): `scene_build`/`scene_create` make `Humanoid` (WalkSpeed 0-100, JumpPower 0-200, UseJumpPower, DisplayName, MaxHealth, Health <= MaxHealth, HipHeight, AutoRotate, RigType, DisplayDistanceType) inside a Model, `HumanoidDescription` inside a Humanoid or a Model/Folder (e.g. `ServerStorage.Looks`, read by the spawn script), `AnimationController` inside a Model and `Animator` inside a Humanoid or AnimationController. They cannot make Motor6D joints, so a hand-built parts Model plus Humanoid is not a walking rig: use it for static or tweened characters, or to tune an inserted rig.
- Creator Store rig: `studio_asset_search` category Model, query `R15 rig` or `dummy`; `studio_asset_insert` one into a hidden template Folder (scripts are stripped). Check that it has HumanoidRootPart, Humanoid and Motor6Ds before cloning.
- Readability: short `DisplayName`, `DisplayDistanceType` Viewer, standard scale 1 (avatar 5.5 studs) unless the user wants giants or children.

## Animation
- Never invent animation ids. Verifiable defaults are the ones in the standard `Animate` script that Roblox adds to every player character. R15 values (use as `rbxassetid://` + number): idle 507766666, walk 507777826, run 507767714, jump 507765000, fall 507767968, climb 507765644. To confirm, read `character.Animate.walk.WalkAnim.AnimationId` from a player character during a playtest. Custom clips need an id the user uploaded.
- In the server Script: `local animator = humanoid:FindFirstChildOfClass("Animator") or Instance.new("Animator", humanoid)`; create an `Animation` per clip and call `animator:LoadAnimation(anim)` once. Play idle `Looped` at priority Idle. On `humanoid.Running:Connect(function(speed) ... end)` switch to walk when speed > 0.5 and back to idle, with `track:AdjustSpeed(speed / 16)`. Tracks played on the server replicate.
- Creatures without a humanoid body use a Model + `AnimationController` + `Animator`. With no animation asset, use procedural motion: TweenService on an anchored root part with the other parts welded to it (body bob 0.4 s Sine InOut, Reverses, RepeatCount -1), plus small sway tweens on welded wings or tails. Cancel tweens on despawn.

## Pathfinding
- `PathfindingService:CreatePath({ AgentRadius = 2, AgentHeight = 5, AgentCanJump = true, AgentCanClimb = false, WaypointSpacing = 4, Costs = { Water = 20, Danger = math.huge } })`. Hazards get a `PathfindingModifier` with Label `Danger`.
- `local ok = pcall(path.ComputeAsync, path, root.Position, goal)`. Continue only when `ok and path.Status == Enum.PathStatus.Success`; otherwise wait 1 s and pick another goal.
- Walk `path:GetWaypoints()` with `humanoid:MoveTo(wp.Position)`; when `wp.Action == Enum.PathWaypointAction.Jump` set `humanoid.Jump = true`. Wait for `MoveToFinished` (it gives up after 8 s, so keep waypoints short).
- `path.Blocked:Connect(function(i) if i >= nextIndex then replan() end end)`.
- Stuck detection: every 0.5 s compare root position; under 1 stud of progress in 2 s while moving means jump once, then replan. After 3 failed replans go back to the home point.
- Budget: replan a chase every 0.5-1 s only if the target moved more than 4 studs; stagger NPC updates; at most a few `ComputeAsync` calls per frame.

## Behaviour state machine
| State | Enter | Leave |
|---|---|---|
| Idle | spawn, patrol point reached (wait 2-4 s random) | timer -> Patrol; target seen -> Chase |
| Patrol | parts of a `Waypoints` Folder in order | target seen -> Chase |
| Chase | target within 40 studs, in a 120 degree view cone, unblocked Raycast | lost for 3 s -> Return; Health < 30% -> Flee |
| Flee | low health | path to `root + (root - threat).Unit * 30`, then Return |
| Return | target lost | home reached -> Idle |
- One loop per NPC (`task.spawn`, `task.wait(0.2)` while alive) or one manager for many NPCs. Publish `npc:SetAttribute("State", state)` for debugging.
- On `humanoid.Died`: stop the loop, disconnect everything, remove the body after 5 s and respawn from the template after 10 s.

## Dialogue
- The server adds a `ProximityPrompt` to the HumanoidRootPart: ActionText "Talk", ObjectText = DisplayName, MaxActivationDistance 10, HoldDuration 0, RequiresLineOfSight false.
- Build the dialogue panel with `scene_build` (container ScreenGui, `Enabled` false; layout in `arcane-interface`). A LocalScript shows it when the server fires a RemoteEvent with a node id. Turn a stationary NPC to the player with `CFrame.lookAt` on a flattened Y.
- The node tree, typewriter text and server-checked choices follow the NPC dialogue recipe in `arcane-gameplay-systems`.

## Performance and server authority
- After parenting, call `part:SetNetworkOwner(nil)` on every unanchored BasePart (pcall) so the server owns NPC physics: no stutter at ownership handoff and no client-moved NPCs.
- Stationary NPCs: anchor HumanoidRootPart, `WalkSpeed` 0, disable unused states (`humanoid:SetStateEnabled(Enum.HumanoidStateType.Climbing, false)`).
- Keep moving Humanoids to about 20-30; use anchored, tweened AnimationController crowds for background life. Tag NPCs with CollectionService and cap spawns.
- The server decides perception, damage, rewards and dialogue outcomes; clients only display. Remote checks: `arcane-remote-security`. Perception design: `arcane-npc`. Blender-made creature meshes: `arcane-rig-animation`.

## Verify
Scripts stay disabled until `script_read` + `script_set_enabled`. Expose results as player attributes: the dialogue server sets `player:SetAttribute("TalkedTo", npc.Name)`; a chasing NPC sets `ChasedBy` on its target. Place a test NPC about 12 studs in front of the spawn. `playtest_request`: `hold-key` W 1000 ms toward it, `hold-key` E, then `assert-player-attribute` TalkedTo; for enemies assert ChasedBy. Report flee, respawn and multi-NPC load as untested unless checked.
