# Obby code patterns (--!strict, server-authoritative)

All scripts are created disabled with `scene_create` + `script_update` and enabled only after `script_read` + `script_set_enabled`. Saving stays disabled unless the user asked for it (`arcane-datastore-safety`).

## StageService (checkpoints and respawn)
```lua
--!strict
local Players = game:GetService("Players")
local StageService = {}
local cps: Folder = workspace:WaitForChild("Obby"):WaitForChild("Checkpoints") :: Folder

local function cpIndex(part: BasePart): number?
	return tonumber(string.match(part.Name, "^CP_(%d+)$"))
end

function StageService.set(player: Player, n: number)
	player:SetAttribute("Stage", n)
	player:SetAttribute("Checkpoint", n)
	local stats = player:FindFirstChild("leaderstats")
	local value = stats and stats:FindFirstChild("Stage") :: IntValue?
	if value then value.Value = n end
end

function StageService.start()
	for _, cp in cps:GetChildren() do
		if not cp:IsA("BasePart") then continue end
		local n = cpIndex(cp)
		if not n then continue end
		cp.Touched:Connect(function(hit)
			local player = Players:GetPlayerFromCharacter(hit.Parent)
			if not player then return end
			local hum = (hit.Parent :: Model):FindFirstChildOfClass("Humanoid")
			if not hum or hum.Health <= 0 then return end
			local stage = player:GetAttribute("Stage") :: number? or 0
			if n == stage + 1 then StageService.set(player, n) end -- never skip ahead
		end)
	end
	local function added(player: Player)
		local stats = Instance.new("Folder"); stats.Name = "leaderstats"
		local stage = Instance.new("IntValue"); stage.Name = "Stage"; stage.Parent = stats
		stats.Parent = player
		StageService.set(player, 0) -- DataService raises this after a successful load
		player.CharacterAdded:Connect(function(character)
			task.defer(function()
				local cp = cps:FindFirstChild(string.format("CP_%02d", player:GetAttribute("Stage") :: number? or 0)) :: BasePart?
				if cp then character:PivotTo(cp.CFrame + Vector3.new(0, 4, 0)) end
			end)
		end)
	end
	Players.PlayerAdded:Connect(added)
	for _, player in Players:GetPlayers() do task.spawn(added, player) end -- joined before start()
end
return StageService
```

## HazardService (kill bricks)
```lua
local debounce: { [Model]: boolean } = {}
for _, part in workspace.Obby.Hazards:GetDescendants() do
	if part:IsA("BasePart") then
		part.Touched:Connect(function(hit)
			local character = hit.Parent :: Model
			local hum = character and character:FindFirstChildOfClass("Humanoid")
			if not hum or debounce[character] then return end
			debounce[character] = true
			hum.Health = 0
			task.delay(1, function() debounce[character] = nil end)
		end)
	end
end
```

## MoverService (one Heartbeat for all movers)
```lua
local RunService = game:GetService("RunService")
type Mover = { part: BasePart, origin: CFrame, axis: Vector3, distance: number, period: number }
local movers: { Mover } = {}
for _, part in workspace.Obby.Movers:GetChildren() do
	if part:IsA("BasePart") then
		local axisName = string.match(part.Name, "_(%a)$") or "X"
		local axis = axisName == "Y" and Vector3.yAxis or axisName == "Z" and Vector3.zAxis or Vector3.xAxis
		table.insert(movers, { part = part, origin = part.CFrame, axis = axis, distance = 16, period = 6 })
	end
end
RunService.Heartbeat:Connect(function()
	local t = os.clock()
	for _, m in movers do
		local s = math.sin(t * 2 * math.pi / m.period)
		local velocity = m.axis * (m.distance / 2) * math.cos(t * 2 * math.pi / m.period) * (2 * math.pi / m.period)
		m.part.CFrame = m.origin + m.axis * (m.distance / 2) * s
		m.part.AssemblyLinearVelocity = velocity -- carries standing players
	end
end)
```

## DataService (session-locked UpdateAsync)
```lua
local DataStoreService = game:GetService("DataStoreService")
local store = DataStoreService:GetDataStore("Obby_v1")
local LOCK_TTL = 1800
local function retry<T>(kind: Enum.DataStoreRequestType, fn: () -> T): (boolean, T?)
	for attempt = 1, 5 do
		while DataStoreService:GetRequestBudgetForRequestType(kind) <= 0 do task.wait(1) end
		local ok, result = pcall(fn)
		if ok then return true, result end
		task.wait(2 ^ (attempt - 1) + math.random())
	end
	return false, nil
end
local function load(player: Player): any?
	local key = "u_" .. player.UserId
	local ok, record = retry(Enum.DataStoreRequestType.UpdateAsync, function()
		return store:UpdateAsync(key, function(old)
			old = old or { version = 1, data = { maxStage = 0, skips = 0, completions = 0, totalTime = 0 } }
			if old.lock and old.lock.jobId ~= game.JobId and os.time() - old.lock.time < LOCK_TTL then return nil end
			old.lock = { jobId = game.JobId, time = os.time() }
			return old
		end)
	end)
	if not ok or not record or not record.lock or record.lock.jobId ~= game.JobId then return nil end -- failed: never save over
	return record.data
end
local loaded: { [Player]: any } = {} -- only profiles that load() returned; never save a failed load
local function save(player: Player, release: boolean): boolean
	local data = loaded[player]
	if not data then return false end
	return (retry(Enum.DataStoreRequestType.UpdateAsync, function()
		return store:UpdateAsync("u_" .. player.UserId, function(old)
			if not old or not old.lock or old.lock.jobId ~= game.JobId then return nil end -- lost the lock
			old.data = data
			old.lock = if release then nil else { jobId = game.JobId, time = os.time() }
			return old
		end)
	end))
end
-- Autosave every 90 s staggered; PlayerRemoving: save(player, true) then loaded[player] = nil.
game:BindToClose(function() -- save all in parallel, <= 25 s
	local pending = 0
	for player in loaded do
		pending += 1
		task.spawn(function() save(player, true); pending -= 1 end)
	end
	local deadline = os.clock() + 25
	while pending > 0 and os.clock() < deadline do task.wait(0.1) end
end)
```

## Skip-stage receipt stub (idempotent, inactive while id is nil)
```lua
local MarketplaceService = game:GetService("MarketplaceService")
local Config = require(game.ReplicatedStorage.Shared.ObbyConfig)
if Config.SkipStageProductId then
	MarketplaceService.ProcessReceipt = function(info)
		local player = game.Players:GetPlayerByUserId(info.PlayerId)
		if not player or info.ProductId ~= Config.SkipStageProductId then return Enum.ProductPurchaseDecision.NotProcessedYet end
		-- Record info.PurchaseId inside the player's UpdateAsync record first; if already recorded return PurchaseGranted.
		StageService.set(player, (player:GetAttribute("Stage") :: number? or 0) + 1)
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end
end
```
The client `SkipStage` remote only calls `MarketplaceService:PromptProductPurchase`; it never changes Stage.
