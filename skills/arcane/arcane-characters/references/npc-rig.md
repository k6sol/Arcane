# NPC rig, animation and manager code (--!strict, server-authoritative)

Layout: `ServerStorage.Looks` HumanoidDescriptions per role (made by `scene_build`); `workspace.NPCSpawns` parts with attributes `Role`, `Hostile`, optional `Patrol` (name of a Folder of parts); `workspace.NPCs` Folder. ServerScriptService: Script `NpcServer` and Folder `Npc` with ModuleScripts `Anim`, `Mover`, `Brain`. All created disabled; enable with `script_set_enabled` after `script_read`. Pathing Mover and state Brain: `arcane-characters:npc-ai`.

## Npc/Anim
```lua
--!strict
-- Standard R15 Animate defaults. Verify in a playtest (character.Animate.walk.WalkAnim.AnimationId);
-- custom or R6 packs and every attack/emote clip need ids from the user. Missing ids just skip the clip.
local DEFAULTS: { [string]: number } = { idle = 507766666, walk = 507777826, run = 507767714 }
local PRIORITY: { [string]: Enum.AnimationPriority } = { idle = Enum.AnimationPriority.Idle, walk = Enum.AnimationPriority.Movement,
	run = Enum.AnimationPriority.Movement } -- anything else (attack, wave) plays at Action

local Anim = {}
Anim.__index = Anim

function Anim.new(model: Model, extra: { [string]: number }?)
	local holder = model:FindFirstChildOfClass("Humanoid") or model:FindFirstChildOfClass("AnimationController")
	assert(holder, "rig needs a Humanoid or AnimationController")
	local animator = holder:FindFirstChildOfClass("Animator")
	if not animator then
		animator = Instance.new("Animator")
		animator.Parent = holder
	end
	local self = setmetatable({ tracks = {} :: { [string]: AnimationTrack } }, Anim)
	local ids = table.clone(DEFAULTS)
	for name, id in extra or {} do ids[name] = id end
	for name, id in ids do
		local animation = Instance.new("Animation")
		animation.AnimationId = "rbxassetid://" .. tostring(id)
		local track = (animator :: Animator):LoadAnimation(animation) -- load once, reuse
		track.Priority = PRIORITY[name] or Enum.AnimationPriority.Action
		track.Looped = name == "idle" or name == "walk" or name == "run"
		self.tracks[name] = track
	end
	self.tracks.idle:Play(0.2, 1, 1)
	return self
end

-- Blend walk and run by speed with weights; idle keeps playing underneath at lower priority.
function Anim.setSpeed(self: any, speed: number)
	local walk, run = self.tracks.walk, self.tracks.run
	if speed < 0.5 then
		if walk.IsPlaying then walk:Stop(0.2) end
		if run.IsPlaying then run:Stop(0.2) end
		return
	end
	local runWeight = math.clamp((speed - 10) / 8, 0, 1)
	if not walk.IsPlaying then walk:Play(0.2, 1 - runWeight + 0.01) end
	if not run.IsPlaying then run:Play(0.2, runWeight + 0.01) end
	walk:AdjustWeight(1 - runWeight + 0.01, 0.2)
	run:AdjustWeight(runWeight + 0.01, 0.2)
	walk:AdjustSpeed(speed / 16)
	run:AdjustSpeed(speed / 16)
end

function Anim.action(self: any, name: string): boolean
	local track: AnimationTrack? = self.tracks[name]
	if not track then return false end -- no id provided: gameplay still works
	track:Play(0.1, 1, 1)
	return true
end

function Anim.destroy(self: any)
	for _, track in self.tracks do track:Stop(0); track:Destroy() end
	table.clear(self.tracks)
end

return Anim
```

## NpcServer (spawner + throttled manager)
```lua
--!strict
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local Brain = require(script.Parent.Npc.Brain)

local MAX_NPCS = 25
local folder = workspace:FindFirstChild("NPCs") or Instance.new("Folder")
folder.Name = "NPCs"
folder.Parent = workspace
local brains: { [Model]: any } = {}
local count = 0

local function nearestPlayer(position: Vector3): number
	local best = math.huge
	for _, player in Players:GetPlayers() do
		local character = player.Character
		local root = character and character:FindFirstChild("HumanoidRootPart")
		if root and root:IsA("BasePart") then best = math.min(best, (root.Position - position).Magnitude) end
	end
	return best
end

local function spawnAt(marker: BasePart)
	local role = marker:GetAttribute("Role")
	local look = ServerStorage.Looks:FindFirstChild(if typeof(role) == "string" then role else "")
	if count >= MAX_NPCS or not (look and look:IsA("HumanoidDescription")) then return end
	local model = Players:CreateHumanoidModelFromDescription(look:Clone(), Enum.HumanoidRigType.R15)
	model.Name = look.Name
	model.ModelStreamingMode = Enum.ModelStreamingMode.Atomic -- clients receive the whole rig at once
	model:PivotTo(marker.CFrame + Vector3.new(0, 3, 0))
	model.Parent = folder
	for _, part in model:GetDescendants() do
		if part:IsA("BasePart") and not part.Anchored and part:CanSetNetworkOwnership() then
			pcall(part.SetNetworkOwner, part, nil) -- server owns NPC physics
		end
	end
	local points: { Vector3 } = {}
	local patrol = workspace:FindFirstChild(tostring(marker:GetAttribute("Patrol") or ""))
	if patrol then
		local parts = patrol:GetChildren()
		table.sort(parts, function(a, b) return a.Name < b.Name end)
		for _, p in parts do if p:IsA("BasePart") then table.insert(points, p.Position) end end
	end
	local brain = Brain.new(model, marker:GetAttribute("Hostile") == true, points)
	brains[model] = brain
	count += 1
	CollectionService:AddTag(model, "NPC")
	local humanoid = model:FindFirstChildOfClass("Humanoid") :: Humanoid
	humanoid.Died:Once(function()
		brains[model] = nil
		count -= 1
		brain:destroy()
		task.delay(5, function() model:Destroy() end)
		task.delay(10, spawnAt, marker)
	end)
end

for _, marker in workspace.NPCSpawns:GetChildren() do
	if marker:IsA("BasePart") then spawnAt(marker) end
end

-- One scheduler: near NPCs think every 0.1 s, far ones every 0.75 s, NPCs beyond 250 studs sleep.
RunService.Heartbeat:Connect(function()
	local now = os.clock()
	for _, brain in brains do
		if not brain.busy and now >= brain.nextTick then
			local dist = nearestPlayer(brain.root.Position)
			brain.nextTick = now + (if dist < 60 then 0.1 elseif dist < 250 then 0.75 else 2) + math.random() * 0.05
			if dist < 250 then
				brain.busy = true
				task.spawn(function() -- ComputeAsync yields; never block the Heartbeat
					local ok, err = pcall(brain.update, brain, now)
					if not ok then warn("NPC", brain.model.Name, err) end
					brain.busy = false
				end)
			end
		end
	end
end)
```
