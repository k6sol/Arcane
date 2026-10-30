# Horror code patterns (--!strict, server decides, client renders)

## Integration boundary: timing fragments are not a horror director

The retained samples assume actual Config, helpers, rigs and authorized media. They do not supply a finished threat/objective system or prove suspense. Begin with readable danger, a useful objective and fair recovery, then author the requested route/chapter variation and resolution. Do not transplant a stalker/jump-scare formula into a different horror brief.

Own every loop, delayed scare, path callback, camera offset and audio duck by the current player/scene epoch. The shown while loops require cancellation/teardown integration. Repeated triggers, death, map unload and interrupted hiding must release only their own state and restore controls; a character cannot remain anchored after the sequence ends. Verify finite direction/zero-distance perception, actual occlusion, remembered last-known position and a way to disengage. The hiding paragraph and simplified canSee fragment are not a completed seen-entry exception.

Audio ducking/recovery must handle overlapping/interrupted cues without accumulating lower volume or restoring another system's changed mix. Use real authorized sounds and actual rig/animation assets; a placeholder Stingers folder or shake helper does not count as delivery. Keep essential clues visible and subtitled, with reduced motion/flash options and no total-darkness test shortcut.

Play a complete objective chain, actual detection/escape/catch and checkpoint retry, then observe tension/relief without narration. Test blocked paths, seen hiding, duplicate trigger, cooperative shared objects and unloading during delayed playback. A LastScare attribute or ScareFrame assertion proves only that signal, not navigation, fair pursuit, a finished chapter roster or player fear.

Scripts start disabled (`scene_create` + `script_update`), then `script_read` + `script_set_enabled`. Rig, pathfinding (`pcall` around `ComputeAsync`, waypoint walking, stuck recovery) and animation: `arcane-characters`.

## HorrorConfig
```lua
--!strict
return {
	Tension = { darkGain = 2, noiseGain = 10, lightDecay = 5, peakAt = 70, peakCooldown = 90 },
	ScareCooldown = 180, SilenceBefore = 3, FakeToReal = 2,
	Stalker = { walk = 10, chase = 20, sightRange = 70, sightAngle = 60, catchRange = 4, searchTime = 15, grace = 5 },
	Sprint = { speed = 22, duration = 4, recharge = 8 },
}
```

## DirectorService (per-player tension, server)
```lua
local tension: { [Player]: number } = {}
local lastPeak: { [Player]: number } = {}
local fired: { [Player]: { [string]: boolean } } = {}
local Players = game:GetService("Players")
Players.PlayerRemoving:Connect(function(player) tension[player], lastPeak[player], fired[player] = nil, nil, nil end)
task.spawn(function()
	while true do
		for _, player in Players:GetPlayers() do
			local t = tension[player] or 0
			t += if inLight(player) or player:GetAttribute("InSafeRoom") then -Config.Tension.lightDecay else Config.Tension.darkGain
			tension[player] = math.clamp(t, 0, 100)
			player:SetAttribute("Tension", math.floor(tension[player]))
		end
		task.wait(1)
	end
end)
local function canScare(player: Player): boolean
	return (tension[player] or 0) >= Config.Tension.peakAt and os.clock() - (lastPeak[player] or -math.huge) >= Config.ScareCooldown
end
for _, trigger in workspace.Triggers:GetChildren() do
	trigger.Touched:Connect(function(hit)
		local player = Players:GetPlayerFromCharacter(hit.Parent)
		if not player then return end
		fired[player] = fired[player] or {}
		if fired[player][trigger.Name] then return end
		fired[player][trigger.Name] = true
		player:SetAttribute("LastScare", trigger.Name)
		local real = canScare(player)
		if real then lastPeak[player] = os.clock(); tension[player] = 20 end
		Scare:FireClient(player, trigger.Name, real) -- client: silence, then stinger (+ visual when real)
	end)
end
```
`inLight` tests the distance to the nearest enabled PointLight within its Range (cache light positions at start) or the player's own flashlight state for short range.

## Client scare playback
```lua
Scare.OnClientEvent:Connect(function(id: string, real: boolean)
	local ambience = SoundService.Ambience -- SoundGroup
	TweenService:Create(ambience, TweenInfo.new(0.4), { Volume = ambience.Volume * 0.25 }):Play()
	task.wait(Config.SilenceBefore)
	local stinger = (real and Stingers.Real or Stingers.Fake):Clone() -- Sounds built under ReplicatedStorage with searched ids
	stinger.Parent = workspace.CurrentCamera; stinger:Play()
	if real then
		hud.ScareFrame.Visible = true
		shake(0.6, 0.8) -- camera offset noise, respects a Reduce Motion setting
		task.delay(0.9, function() hud.ScareFrame.Visible = false end)
	end
	subtitles:Show(real and "[A shriek right behind you]" or "[Something moves upstairs]")
	task.delay(3, function() TweenService:Create(ambience, TweenInfo.new(2), { Volume = baseVolume }):Play() end)
	Debris:AddItem(stinger, 6)
end)
```

## Light flicker (one server loop)
```lua
local lamps = CollectionService:GetTagged("Flicker") -- tagged at start from workspace.Lights.Flicker
task.spawn(function()
	if #lamps == 0 then return end -- math.random(0) would error and kill the loop
	while true do
		local lamp = lamps[math.random(#lamps)]
		local light = lamp:FindFirstChildWhichIsA("PointLight")
		if light then
			for _ = 1, math.random(2, 5) do
				light.Enabled = not light.Enabled; task.wait(math.random(4, 12) / 100)
			end
			light.Enabled = true
		end
		task.wait(math.random(15, 40) / 10)
	end
end)
```

## Stalker perception and states
```lua
local function canSee(npcHead: BasePart, target: Model): boolean
	local head = target:FindFirstChild("Head") :: BasePart?
	if not head or target:GetAttribute("Hidden") then return false end
	local delta = head.Position - npcHead.Position
	if delta.Magnitude > Config.Stalker.sightRange then return false end
	if math.deg(math.acos(npcHead.CFrame.LookVector:Dot(delta.Unit))) > Config.Stalker.sightAngle / 2 then return false end
	local params = RaycastParams.new(); params.FilterDescendantsInstances = { npcHead.Parent :: Instance }
	local hit = workspace:Raycast(npcHead.Position, delta, params)
	return hit ~= nil and hit.Instance:IsDescendantOf(target)
end
-- Every 0.25 s: Patrol (walk waypoints) -> sees player -> Chase (path to target, recompute <= 2/s)
-- lost sight -> Search lastKnown for searchTime -> Patrol. Noise events set Investigate(point).
-- Catch: distance <= catchRange and not in grace -> Caught:FireClient, PivotTo checkpoint, grace window.
```

## Hiding
A ProximityPrompt on each locker (`Hide`, HoldDuration 0.3): the server checks distance, sets `Hidden = true`, anchors the HumanoidRootPart inside the locker; leaving reverses it. If the stalker saw the player enter within 2 s, `Hidden` does not protect.

## Conditional tuning examples from the original kit

These inherited figures describe one starting configuration, not universal limits, verified performance or required mechanics. Choose relevant values for the actual brief, bind total resources to the intended audience/device and measure them in real play. Vehicle/platform motion, threat readability and commerce/persistence still require the integration checks above. Do not weaken supported-tool or production bounds to fit an example.

### Tension and pacing (Director)
| Phase | Duration | Allowed |
|---|---|---|
| Calm | 60-120 s | ambient creaks, distant sounds |
| Build | 30-60 s | close stingers, light flicker |
| Peak | 10-30 s | jump scare or chase |
| Relief | 20-40 s | safe room, no scares |
- Tension 0-100: +2/s in dark, +10 on noise, -5/s in light or safe room. Peak when >= 70 and >= 90 s since last peak.
- Jump scares: max 1 per 3 min per player, never twice from the same trigger, preceded by 2-4 s of silence (duck ambience -12 dB). Visual 0.6-1.2 s; stinger peak <= Volume 1.2 in SFX group.
- Fake-outs (sound only) 2:1 to real scares.

### Performance budgets
<= 20 shadow-casting lights visible at once (others Shadows false), <= 12 looping 3D sounds, 1 stalker per 4-6 players, path recompute <= 2/s, Atmosphere Density 0.45-0.6 (not fog walls), <= 15k parts with StreamingEnabled.
