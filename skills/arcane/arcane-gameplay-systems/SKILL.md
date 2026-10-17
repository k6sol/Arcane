---
name: arcane-gameplay-systems
description: "Concise server-authoritative recipes for common Roblox systems: checkpoints, round loop, leaderstats, doors and keys, NPC dialogue and pathfinding NPCs, built in batches and verified by playtest."
license: MIT
---

# Gameplay system recipes

## Rules first
- One `scene_build` for all parts of a system (pads, doors, waypoints) in named Folders/Models, with keys for the refs you need. Then one server Script per system in ServerScriptService via `scene_create` + `script_update`. Scripts stay disabled until activated with `script_read` + `script_set_enabled`.
- scene_build cannot add tags, attributes, prompts or Humanoids. The server script finds parts by Folder and name, adds tags, ProximityPrompts and RemoteEvents at start.
- All outcomes are decided on the server. Expose results as player attributes so `playtest_request` can assert them with `assert-player-attribute`.
- Code structure and cleanup: `arcane-luau-architecture`. Remote checks: `arcane-remote-security`. Saving anything: `arcane-datastore-safety` (never enable saving code without an explicit request).

## Checkpoints (obby)
- Build: Folder `Checkpoints` with Parts `CP_01`, `CP_02` ... (6 x 1 x 6, Neon or SmoothPlastic, distinct colour, CanCollide true) and Folder `Hazards` for kill parts (Neon red ff3b3b).
- Server: on a checkpoint's Touched, resolve the player from the Humanoid's parent; accept only `n == stage + 1` (no skipping) or ignore `n <= stage`. Set `leaderstats.Stage` and `player:SetAttribute("Checkpoint", n)`.
- On `CharacterAdded`, `task.defer`, then `character:PivotTo(cp.CFrame + Vector3.new(0, 4, 0))`.
- Hazards: server Touched sets `Humanoid.Health = 0`, with a per-character debounce.
- Do not use extra SpawnLocations as checkpoints: every neutral SpawnLocation is a random first spawn.
- Test: hold W onto CP_01, assert attribute Checkpoint = 1.

## Round loop
- States: Intermission 20 s -> Starting 3 s -> InRound 120 s -> Results 8 s. Minimum players 2 (1 in Studio via `RunService:IsStudio()`).
- Publish `workspace:SetAttribute("RoundState", s)` and `("TimeLeft", n)` once per second; the HUD reads them.
- Each round has an epoch number; callbacks from an older epoch do nothing. A per-round Folder and Cleanup are destroyed at Results.
- Teleport with `PivotTo` onto arena spawn pads with a random 0-4 stud offset. End early when one player or team remains; award winners once.
- Edge cases (late joins, simultaneous finish, disconnects): `arcane-rounds`.

## Leaderstats
- On PlayerAdded (and for players already present), create a Folder named exactly `leaderstats` with at most 4 IntValue/NumberValue children (e.g. Coins, Stage, Wins). Only the server changes them.
- Load saved values with the `arcane-datastore-safety` pattern before showing them; if loading fails, do not save over the old data.

## Doors and keys
- Build: Model `Door_Red` with a frame and a `Panel` part 4 x 7.5 x 0.4 (WoodPlanks), plus a `Key_Red` part 1 x 0.4 x 2 (Neon, matching colour).
- Server adds ProximityPrompts: key ActionText "Pick up", HoldDuration 0, MaxActivationDistance 8; door ActionText "Open", MaxActivationDistance 10, RequiresLineOfSight false.
- Picking up sets `player:SetAttribute("Key_Red", true)` and hides the key for that round.
- Opening checks the attribute and distance on the server, tweens the anchored panel's CFrame 90 degrees about its hinge edge (0.6 s Quad Out), sets CanCollide false while open and closes after 4 s. Locked: play a denied sound and show "Needs the red key".

## NPC dialogue
- Spawn rigs from code: `Players:CreateHumanoidModelFromDescription(HumanoidDescription.new(), Enum.HumanoidRigType.R15)`, anchor the HumanoidRootPart for stationary NPCs, PivotTo a stand part.
- Dialogue tree in a ReplicatedStorage ModuleScript: `nodes[id] = { text, choices = { { label, next, action? } } }`.
- Server ProximityPrompt (ActionText "Talk", MaxActivationDistance 10) fires the player's client with a node id. The client shows the bottom dialogue panel (`arcane-interface`) with a 40 chars/s typewriter that clicking skips.
- A choice sends `(npcId, nodeId, choiceIndex)`. The server checks the node is the player's current node and the distance, then runs the action (quest, item). Rewards are never sent by the client.

## Pathfinding NPC
- `PathfindingService:CreatePath({ AgentRadius = 2, AgentHeight = 5, AgentCanJump = true, WaypointSpacing = 4, Costs = { Water = 20 } })`.
- `pcall(path.ComputeAsync, path, from, to)`; continue only when `path.Status == Enum.PathStatus.Success`.
- Walk waypoints with `Humanoid:MoveTo` and `MoveToFinished` (it times out after 8 s); for a Jump waypoint set `Humanoid.Jump = true`. Recompute on `path.Blocked`.
- Chasing: replan every 0.5-1 s only if the target moved more than 4 studs. Stuck (moved under 1 stud in 2 s): jump, then replan.
- `HumanoidRootPart:SetNetworkOwner(nil)` to stop stutter. Limit concurrent path computations (e.g. 4 per frame budget). Patrols use parts in a `Waypoints` Folder in order.
- Perception and behaviour design: `arcane-npc`.

## Verify
`playtest_request` with movement steps and `assert-player-attribute` (Checkpoint, Key_Red) or `assert-text` on HUD labels. Report systems that need multiple clients as untested.
