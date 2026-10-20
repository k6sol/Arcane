# NPC pathing and state machine code (--!strict, server-authoritative)

ModuleScripts in ServerScriptService Folder `Npc`, created disabled. Spawner, `Anim` and the throttled manager that calls `Brain.update`: `arcane-characters:npc-rig`.

## Npc/Mover
```lua
--!strict
local PathfindingService = game:GetService("PathfindingService")
local RunService = game:GetService("RunService")

local Mover = {}
Mover.__index = Mover

-- Shared ComputeAsync budget per Heartbeat across all NPCs.
local BUDGET = 4
local left = BUDGET
RunService.Heartbeat:Connect(function() left = BUDGET end)

function Mover.new(model: Model)
	local humanoid = model:FindFirstChildOfClass("Humanoid") :: Humanoid
	local root = model:FindFirstChild("HumanoidRootPart") :: BasePart
	local self = setmetatable({ humanoid = humanoid, root = root, waypoints = {} :: { PathWaypoint }, index = 0, goal = nil :: Vector3?,
		replan = false, failures = 0, lastPos = root.Position, lastCheck = os.clock(), lastMove = 0 }, Mover)
	-- Size the agent to the rig (R15 scale 1: radius 2, height 5). Labels: PathfindingModifier "Danger", PathfindingLink "Jump".
	self.path = PathfindingService:CreatePath({ AgentRadius = 2, AgentHeight = 5, AgentCanJump = true, AgentCanClimb = false,
		WaypointSpacing = 4, Costs = { Water = 20, Danger = math.huge, Jump = 6 } })
	self.blocked = self.path.Blocked:Connect(function(blockedIndex: number)
		if blockedIndex >= self.index then self.replan = true end
	end)
	return self
end

-- Yields. Returns false when the frame budget is spent or no path exists; callers retry next tick.
function Mover.moveTo(self: any, goal: Vector3): boolean
	if left <= 0 then return false end
	left -= 1
	self.replan = false
	local ok = pcall(self.path.ComputeAsync, self.path, self.root.Position, goal)
	if not ok or self.path.Status ~= Enum.PathStatus.Success then
		self.waypoints, self.index, self.goal = {}, 0, nil
		return false
	end
	self.goal = goal
	self.waypoints, self.index = self.path:GetWaypoints(), 1
	self:advance()
	return true
end

function Mover.advance(self: any)
	self.index += 1
	local wp: PathWaypoint? = self.waypoints[self.index]
	if not wp then return end
	if wp.Action == Enum.PathWaypointAction.Jump or wp.Label == "Jump" then self.humanoid.Jump = true end
	self.humanoid:MoveTo(wp.Position)
	self.lastMove = os.clock()
end

-- Call every brain tick. Returns "idle" | "moving" | "arrived" | "stuck".
function Mover.step(self: any): string
	local wp: PathWaypoint? = self.waypoints[self.index]
	if not wp then return if self.goal then "arrived" else "idle" end
	local now, pos = os.clock(), self.root.Position
	if self.replan and self.goal then
		self:moveTo(self.goal)
		return "moving"
	end
	local flat = Vector3.new(wp.Position.X - pos.X, 0, wp.Position.Z - pos.Z)
	if flat.Magnitude < 2.5 then
		self:advance()
		if not self.waypoints[self.index] then return "arrived" end
	elseif now - self.lastMove > 6 then
		self.humanoid:MoveTo(wp.Position) -- MoveTo times out after 8 s
		self.lastMove = now
	end
	if now - self.lastCheck >= 1.5 then
		if (pos - self.lastPos).Magnitude < 1 then
			self.failures += 1
			self.humanoid.Jump = true
			self.replan = true
			if self.failures >= 3 then self.failures = 0; return "stuck" end
		else
			self.failures = 0
		end
		self.lastPos, self.lastCheck = pos, now
	end
	return "moving"
end

function Mover.stop(self: any)
	self.waypoints, self.index, self.goal = {}, 0, nil
	self.humanoid:MoveTo(self.root.Position)
end

function Mover.destroy(self: any)
	self.blocked:Disconnect()
	self.path:Destroy()
end

return Mover
```

## Npc/Brain (Idle, Patrol, Chase, Attack, Flee, Return)
```lua
--!strict
local Players = game:GetService("Players")
local Anim = require(script.Parent.Anim)
local Mover = require(script.Parent.Mover)

local Brain = {}
Brain.__index = Brain

local AGGRO, FOV_COS, REACH, LOSE_AFTER = 40, math.cos(math.rad(60)), 5, 3
local DAMAGE, COOLDOWN, FLEE_AT, WALK, RUN = 10, 1.2, 0.3, 10, 16

function Brain.new(model: Model, hostile: boolean, patrol: { Vector3 }, ids: { [string]: number }?)
	local humanoid = model:FindFirstChildOfClass("Humanoid") :: Humanoid
	local root = model:FindFirstChild("HumanoidRootPart") :: BasePart
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { model }
	local self = setmetatable({ model = model, humanoid = humanoid, root = root, hostile = hostile, patrol = patrol, home = root.Position,
		state = "Idle", until_ = os.clock() + 2, patrolIndex = 0, target = nil :: Player?, lastSeen = 0, lastHit = 0,
		params = params, anim = Anim.new(model, ids), mover = Mover.new(model), busy = false, nextTick = 0, conns = {} :: { RBXScriptConnection } }, Brain)
	humanoid:SetStateEnabled(Enum.HumanoidStateType.Climbing, false)
	table.insert(self.conns, humanoid.Running:Connect(function(speed: number) self.anim:setSpeed(speed) end))
	return self
end

function Brain.set(self: any, state: string, now: number)
	self.state = state
	self.model:SetAttribute("State", state) -- visible in Properties while debugging
	if state == "Idle" then self.until_ = now + 2 + math.random() * 2 end
	self.humanoid.WalkSpeed = if state == "Chase" or state == "Flee" then RUN else WALK
end

-- Closest visible player in range and view cone; the server is the only judge.
function Brain.perceive(self: any): (Player?, BasePart?)
	local best, bestRoot, bestDist = nil, nil, AGGRO
	local look = self.root.CFrame.LookVector
	for _, player in Players:GetPlayers() do
		local character = player.Character
		local hum = character and character:FindFirstChildOfClass("Humanoid")
		local root = character and character:FindFirstChild("HumanoidRootPart")
		if hum and hum.Health > 0 and root and root:IsA("BasePart") then
			local offset = root.Position - self.root.Position
			local dist = offset.Magnitude
			local chasing = self.target == player
			if dist < bestDist and (chasing or look:Dot(offset.Unit) >= FOV_COS) then
				local hit = workspace:Raycast(self.root.Position, offset, self.params)
				if not hit or hit.Instance:IsDescendantOf(character) then best, bestRoot, bestDist = player, root, dist end
			end
		end
	end
	return best, bestRoot
end

function Brain.update(self: any, now: number)
	if self.humanoid.Health <= 0 then return end
	local seen: Player?, seenRoot: BasePart? = nil, nil
	if self.hostile then seen, seenRoot = self:perceive() end
	if seen then self.target, self.lastSeen = seen, now end
	local state, move = self.state, self.mover:step()
	if self.hostile and self.humanoid.Health < self.humanoid.MaxHealth * FLEE_AT and state ~= "Flee" and seenRoot then
		self:set("Flee", now)
		local away = self.root.Position - seenRoot.Position
		self.mover:moveTo(self.root.Position + (if away.Magnitude > 0 then away.Unit else Vector3.zAxis) * 30)
	elseif state == "Idle" then
		if seen then self:set("Chase", now) elseif now > self.until_ and #self.patrol > 0 then
			self.patrolIndex = self.patrolIndex % #self.patrol + 1
			if self.mover:moveTo(self.patrol[self.patrolIndex]) then self:set("Patrol", now) end
		end
	elseif state == "Patrol" then
		if seen then self:set("Chase", now) elseif move ~= "moving" then self:set("Idle", now) end
	elseif state == "Chase" or state == "Attack" then
		local target: Player? = self.target
		local character = target and target.Character
		local root = character and character:FindFirstChild("HumanoidRootPart")
		if not (root and root:IsA("BasePart")) or now - self.lastSeen > LOSE_AFTER then
			self.target = nil
			self:set("Return", now)
			self.mover:moveTo(self.home)
			return
		end
		target:SetAttribute("ChasedBy", self.model.Name)
		local dist = (root.Position - self.root.Position).Magnitude
		if dist <= REACH then
			if state ~= "Attack" then self:set("Attack", now); self.mover:stop() end
			if now - self.lastHit >= COOLDOWN then
				self.lastHit = now
				self.anim:action("attack") -- only if the user gave an attack id
				local hum = character:FindFirstChildOfClass("Humanoid")
				if hum then hum:TakeDamage(DAMAGE) end -- server-side reach check above
			end
		else
			if state == "Attack" then self:set("Chase", now) end
			local goal: Vector3? = self.mover.goal
			if dist < 12 and seen then
				self.humanoid:MoveTo(root.Position) -- clear line, close: skip pathfinding
			elseif move ~= "moving" or not goal or (goal - root.Position).Magnitude > 4 then
				self.mover:moveTo(root.Position) -- replan only when the target moved > 4 studs
			end
		end
	elseif state == "Flee" or state == "Return" then
		if move == "arrived" or move == "idle" or move == "stuck" then
			if state == "Flee" then self:set("Return", now); self.mover:moveTo(self.home) else self:set("Idle", now) end
		end
	end
	if move == "stuck" and state ~= "Flee" and state ~= "Return" then self:set("Return", now); self.mover:moveTo(self.home) end
end

function Brain.destroy(self: any)
	for _, conn in self.conns do conn:Disconnect() end
	self.mover:destroy()
	self.anim:destroy()
end

return Brain
```

## Notes
- Gaps and ladders: a PathfindingLink (Attachment0/Attachment1 on two parts, Label `Jump`) created by a server Script; the Mover jumps on it. Doors that open: PathfindingModifier `PassThrough` true.
- Walking followers/companions: same Mover with goal = owner root + offset when farther than 8 studs; snap behind the owner beyond 80 studs.
- Attacks: damage only in the server Brain after its own reach check; never from client hit reports (`arcane-combat`).
