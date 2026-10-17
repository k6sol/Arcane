---
name: arcane-luau-architecture
description: "Write production-quality typed Luau for Roblox: server/client split, ModuleScripts, server-validated remotes, cleanup ownership, CollectionService, TweenService, RunService and performance, using Arcane's disabled-until-activated script flow."
license: MIT
---

# Luau architecture and scripting

## Rules first
- Arcane flow: `scene_create` the Script/LocalScript/ModuleScript, `script_read` for the exact baseline, then `script_update` with the full implementation. New scripts start disabled. Enable with `script_read` + `script_set_enabled` only after the code is complete. Syntax verification is not behaviour: test with `playtest_request`.
- Never enable or run code that writes DataStores, spends currency or teleports players without an explicit request (`arcane-datastore-safety`).
- Inspect existing entrypoints, frameworks and naming first; extend them instead of adding a second framework.
- Never trust the client. The client sends intent (an item id, an aim direction); the server validates and computes every outcome. Remote checklist: `arcane-remote-security`.
- `--!strict` on every script. Export types at module boundaries. Annotations do not validate network data; check with `typeof` at runtime.

## Layout (Arcane roots)
- ServerScriptService: one `Main` Script that requires `Services/*` ModuleScripts and calls `start()` in a fixed order.
- ReplicatedStorage: `Shared/*` (types, config, pure helpers). Remotes are created at runtime by the server in a `Remotes` Folder, because Arcane cannot create RemoteEvent instances; clients use `WaitForChild("Remotes", 10)` and handle nil.
- ServerStorage: server-only templates and secrets. Nothing secret in ReplicatedStorage or client code.
- StarterPlayer.StarterPlayerScripts: one `ClientMain` LocalScript requiring client controllers; UI lives in `arcane-interface` modules.
- scene_build cannot add tags or attributes. Group parts in named Folders (e.g. `Workspace.Hazards`) and let the server tag them at start: `part:AddTag("KillBrick")`.

## Patterns
- Lifecycle: handle `Players.PlayerAdded` and loop `Players:GetPlayers()` for players already present; clear per-player tables on `PlayerRemoving`.
- Cleanup: every connection, tween, thread and temporary instance has one owner that cleans it on character death, round end or UI close.
- CollectionService binder: `GetTagged` + `GetInstanceAddedSignal` + `GetInstanceRemovedSignal`, with per-instance cleanup.
- Use `task.wait`, `task.spawn`, `task.delay` and `task.defer`; never `wait`, `spawn` or `delay`. Use events (`GetPropertyChangedSignal`, `AttributeChanged`) instead of polling loops.
- RunService: Heartbeat for server simulation; RenderStepped only for client camera and visuals; never yield inside. Throttle non-visual logic to 10-20 Hz with an accumulator.
- TweenService: tween anchored parts and UI only, cancel the previous tween on the same target, and keep TweenInfo values in a shared config.
- Wrap calls that can fail (DataStore, MarketplaceService, `PathfindingService:ComputeAsync`, HTTP) in `pcall` and `warn` with context.

## Performance
- Cache services and requires at the top. Do not allocate tables or closures per frame; reuse with `table.clear`.
- Set properties before `Parent` when creating instances.
- Remotes: at most 20 sends per second per player; batch state into one table per tick. Replicate state with attributes or values, not per-frame events.
- Prefer one manager loop over N per-object loops for more than 20 objects.

## Code templates
Module, cleanup class, tag binder, remote guard with rate limit, throttled loop: `skills_get` with ids ["arcane-luau-architecture"], references ["arcane-luau-architecture:patterns"], allowExperimental true ([patterns](references/patterns.md)).

## Refactor and verify
- Inventory callers, remote contracts and saved fields before changing an interface; keep compatibility or migrate deliberately.
- Verify with `playtest_request` scenarios (`assert-player-attribute`, `assert-gui`, `assert-displacement`) where they fit, and report what was not tested, such as multi-client behaviour.
