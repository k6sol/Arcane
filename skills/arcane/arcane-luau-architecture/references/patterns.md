# Luau code templates (--!strict)

## Service module
```lua
--!strict
local Players = game:GetService("Players")

local CoinService = {}
local balances: { [Player]: number } = {}

function CoinService.get(player: Player): number
	return balances[player] or 0
end

function CoinService.add(player: Player, amount: number)
	assert(amount == amount and amount >= 0 and amount <= 1e6, "bad amount")
	balances[player] = CoinService.get(player) + math.floor(amount)
end

function CoinService.start()
	local function added(player: Player) balances[player] = 0 end
	Players.PlayerAdded:Connect(added)
	for _, player in Players:GetPlayers() do task.spawn(added, player) end
	Players.PlayerRemoving:Connect(function(player) balances[player] = nil end)
end

return CoinService
```

## Cleanup (Janitor-like)
```lua
--!strict
export type Cleanup = { add: <T>(item: T) -> T, clean: () -> () }

local function new(): Cleanup
	local items: { any } = {}
	local function add<T>(item: T): T
		table.insert(items, item)
		return item
	end
	local function clean()
		local list = items
		items = {}
		for i = #list, 1, -1 do
			local item = list[i]
			local kind = typeof(item)
			if kind == "RBXScriptConnection" then item:Disconnect()
			elseif kind == "Instance" then item:Destroy()
			elseif kind == "thread" then pcall(task.cancel, item)
			elseif kind == "function" then item()
			end
		end
	end
	return { add = add, clean = clean }
end

return { new = new }
```
Use one Cleanup per character, round or screen: `cleanup.add(humanoid.Died:Connect(onDied))`, then `cleanup.clean()` on exit.

## Tag binder
```lua
local CollectionService = game:GetService("CollectionService")

local function bindTag(tag: string, setup: (Instance) -> (() -> ())?)
	local undo: { [Instance]: () -> () } = {}
	local function added(inst: Instance)
		local stop = setup(inst)
		if stop then undo[inst] = stop end
	end
	CollectionService:GetInstanceAddedSignal(tag):Connect(added)
	CollectionService:GetInstanceRemovedSignal(tag):Connect(function(inst)
		local stop = undo[inst]
		undo[inst] = nil
		if stop then stop() end
	end)
	for _, inst in CollectionService:GetTagged(tag) do task.spawn(added, inst) end
end
```

## Remote guard with rate limit (server)
```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local folder = Instance.new("Folder")
folder.Name = "Remotes"
folder.Parent = ReplicatedStorage

local function remote(name: string): RemoteEvent
	local r = Instance.new("RemoteEvent")
	r.Name = name
	r.Parent = folder
	return r
end

type Bucket = { tokens: number, t: number }
local buckets: { [Player]: { [string]: Bucket } } = {}
local function allow(player: Player, key: string, perSecond: number, burst: number): boolean
	local per = buckets[player]
	if not per then per = {}; buckets[player] = per end
	local now = os.clock()
	local b = per[key]
	if not b then b = { tokens = burst, t = now }; per[key] = b end
	b.tokens = math.min(burst, b.tokens + (now - b.t) * perSecond)
	b.t = now
	if b.tokens < 1 then return false end
	b.tokens -= 1
	return true
end
Players.PlayerRemoving:Connect(function(p) buckets[p] = nil end)

local function isId(v: unknown, maxLen: number): boolean
	return typeof(v) == "string" and #v > 0 and #v <= maxLen and not string.find(v, "[^%w_%-]")
end
local function isFinite(v: unknown, limit: number): boolean
	return typeof(v) == "number" and v == v and math.abs(v) <= limit
end

local buy = remote("BuyItem")
buy.OnServerEvent:Connect(function(player: Player, itemId: unknown)
	if not allow(player, "BuyItem", 2, 4) then return end
	if not isId(itemId, 32) then return end
	-- Look up price and ownership on the server; never accept them from the client.
end)
```
Positions from clients: check `isFinite` on each axis and distance to the character (`(pos - root.Position).Magnitude <= 12`).

## Throttled loop and tween
```lua
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local acc = 0
RunService.Heartbeat:Connect(function(dt: number)
	acc += dt
	if acc < 0.1 then return end -- 10 Hz
	acc = 0
	-- update all managed objects in one pass
end)

local OPEN = TweenInfo.new(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local active: { [Instance]: Tween } = {}
local function tweenTo(inst: Instance, goal: { [string]: any }, info: TweenInfo)
	local old = active[inst]
	if old then old:Cancel() end
	local tween = TweenService:Create(inst, info, goal)
	active[inst] = tween
	tween:Play()
	return tween
end
```
