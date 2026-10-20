# Gameplay system code (--!strict, server-authoritative)

Layout: ServerScriptService `Main` Script requires `Services/*` and calls `start()`; ReplicatedStorage `Shared/Config`; one LocalScript per client controller. All created disabled; enable with `script_set_enabled` after review. `PlayerData` is the module from `arcane-datastore-safety:template` (or the place's existing data module).

## Services/Net (remotes + guard)
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local folder = ReplicatedStorage:FindFirstChild("Remotes") or Instance.new("Folder")
folder.Name = "Remotes"
folder.Parent = ReplicatedStorage

type Bucket = { tokens: number, t: number }
local buckets: { [Player]: { [string]: Bucket } } = {}
Players.PlayerRemoving:Connect(function(player) buckets[player] = nil end)

local Net = {}

function Net.event(name: string): RemoteEvent
	local existing = folder:FindFirstChild(name)
	if existing and existing:IsA("RemoteEvent") then return existing end
	local remote = Instance.new("RemoteEvent")
	remote.Name = name
	remote.Parent = folder
	return remote
end

function Net.allow(player: Player, key: string, perSecond: number, burst: number): boolean
	local per = buckets[player]
	if not per then per = {}; buckets[player] = per end
	local now = os.clock()
	local b = per[key] or { tokens = burst, t = now }
	per[key] = b
	b.tokens = math.min(burst, b.tokens + (now - b.t) * perSecond)
	b.t = now
	if b.tokens < 1 then return false end
	b.tokens -= 1
	return true
end

function Net.isId(v: unknown): boolean
	return typeof(v) == "string" and #v > 0 and #v <= 32 and not string.find(v, "[^%w_%-]")
end

function Net.near(player: Player, position: Vector3, maxDistance: number): boolean
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	return root ~= nil and root:IsA("BasePart") and (root.Position - position).Magnitude <= maxDistance
end

return Net
```

## Services/Shop
```lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(ReplicatedStorage.Shared.Config) -- Config.Shop = { Sword = { price = 100 } }
local Net = require(script.Parent.Net)
local PlayerData = require(script.Parent.PlayerData)

local Shop = {}

function Shop.start()
	local result = Net.event("ShopResult")
	Net.event("BuyItem").OnServerEvent:Connect(function(player: Player, itemId: unknown)
		if not Net.allow(player, "BuyItem", 2, 4) or not Net.isId(itemId) then return end
		local id = itemId :: string
		local item = Config.Shop[id]
		if not item then return end
		local data = PlayerData.get(player)
		if not data then result:FireClient(player, id, false, "Loading"); return end
		if data.owned[id] then result:FireClient(player, id, false, "Owned"); return end
		if data.coins < item.price then result:FireClient(player, id, false, "Not enough coins"); return end
		-- No yield between the check and the write: the purchase cannot be doubled.
		data.coins -= item.price
		data.owned[id] = true
		PlayerData.changed(player)
		result:FireClient(player, id, true, nil)
	end)
end

return Shop
```
Leaderstats: on `PlayerData.onChanged`, create `leaderstats.Coins` once and set `Value = data.coins`.

## ShopController (LocalScript)
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local remotes = ReplicatedStorage:WaitForChild("Remotes", 10)
if not remotes then warn("Shop: Remotes missing"); return end
local buy = remotes:WaitForChild("BuyItem") :: RemoteEvent
local result = remotes:WaitForChild("ShopResult") :: RemoteEvent
local gui = Players.LocalPlayer:WaitForChild("PlayerGui"):WaitForChild("ShopGui")
local list = gui:WaitForChild("Main"):WaitForChild("Items")

local pending: { [string]: TextButton } = {}
for _, button in list:GetChildren() do
	if button:IsA("TextButton") then
		button.Activated:Connect(function()
			if pending[button.Name] then return end
			pending[button.Name] = button
			button.AutoButtonColor = false
			buy:FireServer(button.Name) -- the button name is the item id; price comes from the server
			task.delay(5, function() -- no reply (rate-limited): unlock
				if pending[button.Name] then pending[button.Name] = nil; button.AutoButtonColor = true end
			end)
		end)
	end
end
result.OnClientEvent:Connect(function(id: string, ok: boolean, reason: string?)
	local button = pending[id]
	pending[id] = nil
	if button then
		button.AutoButtonColor = true
		button.Text = if ok then "Owned" else (reason or "Failed")
	end
end)
```

## Services/Stamina (sprint)
```lua
--!strict
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Net = require(script.Parent.Net)

local MAX, DRAIN, REGEN, REGEN_DELAY = 100, 25, 20, 1
local WALK, RUN = 16, 24
type State = { stamina: number, wants: boolean, idle: number }
local states: { [Player]: State } = {}

local Stamina = {}

function Stamina.start()
	Net.event("Sprint").OnServerEvent:Connect(function(player: Player, on: unknown)
		if typeof(on) ~= "boolean" or not Net.allow(player, "Sprint", 8, 8) then return end
		local s = states[player]
		if s then s.wants = on end
	end)
	local function added(player: Player)
		states[player] = { stamina = MAX, wants = false, idle = 0 }
		player:SetAttribute("Stamina", MAX)
		player.CharacterAdded:Connect(function()
			local s = states[player]
			if s then s.stamina, s.wants = MAX, false end
		end)
	end
	Players.PlayerAdded:Connect(added)
	for _, player in Players:GetPlayers() do added(player) end
	Players.PlayerRemoving:Connect(function(player) states[player] = nil end)

	local acc = 0
	RunService.Heartbeat:Connect(function(dt: number)
		acc += dt
		if acc < 0.1 then return end -- 10 Hz
		local step = acc
		acc = 0
		for player, s in states do
			local character = player.Character
			local hum = character and character:FindFirstChildOfClass("Humanoid")
			local root = character and character:FindFirstChild("HumanoidRootPart")
			if not hum or hum.Health <= 0 or not root or not root:IsA("BasePart") then continue end
			local v = root.AssemblyLinearVelocity
			local moving = Vector3.new(v.X, 0, v.Z).Magnitude > 2
			local running = s.wants and moving and s.stamina > 0
			if running then
				s.stamina = math.max(0, s.stamina - DRAIN * step)
				s.idle = 0
			else
				s.idle += step
				if s.idle >= REGEN_DELAY then s.stamina = math.min(MAX, s.stamina + REGEN * step) end
			end
			local speed = if running then RUN else WALK
			if hum.WalkSpeed ~= speed then hum.WalkSpeed = speed end
			local shown = math.floor(s.stamina)
			if player:GetAttribute("Stamina") ~= shown then player:SetAttribute("Stamina", shown) end
		end
	end)
end

return Stamina
```
Client: `ContextActionService:BindAction("Sprint", handler, true, Enum.KeyCode.LeftShift, Enum.KeyCode.ButtonL3)`; the handler fires `Sprint:FireServer(true)` on Begin and `false` on End/Cancel, only when the value changes. The bar listens to `player:GetAttributeChangedSignal("Stamina")` and sets `fill.Size = UDim2.fromScale(stamina / 100, 1)`.

## Services/Damage
```lua
--!strict
local Players = game:GetService("Players")
local FRIENDLY_FIRE = false
local last: { [Humanoid]: { [Player]: number } } = setmetatable({}, { __mode = "k" }) :: any

local Damage = {}

function Damage.apply(target: Humanoid, amount: number, source: Player?, cooldown: number?): boolean
	if target.Health <= 0 or amount ~= amount or amount <= 0 then return false end
	if source then
		local victim = Players:GetPlayerFromCharacter(target.Parent)
		if victim == source then return false end
		if victim and not FRIENDLY_FIRE and source.Team ~= nil and victim.Team == source.Team then return false end
		local per = last[target]
		if not per then per = {}; last[target] = per end
		local now = os.clock()
		if now - (per[source] or 0) < (cooldown or 0.4) then return false end
		per[source] = now
	end
	target:TakeDamage(math.min(amount, 1000)) -- amount always comes from server config
	return true
end

return Damage
```

## Services/Inventory
```lua
--!strict
local ServerStorage = game:GetService("ServerStorage")
local Net = require(script.Parent.Net)
local PlayerData = require(script.Parent.PlayerData)
local CAPACITY = 30

local Inventory = {}

function Inventory.grant(player: Player, id: string, count: number): boolean
	local data = PlayerData.get(player)
	if not data or count < 1 or count ~= math.floor(count) then return false end
	local kinds = 0
	for _ in data.items do kinds += 1 end
	if not data.items[id] and kinds >= CAPACITY then return false end
	data.items[id] = (data.items[id] or 0) + count
	PlayerData.changed(player)
	return true
end

function Inventory.start()
	Net.event("Equip").OnServerEvent:Connect(function(player: Player, raw: unknown)
		if not Net.allow(player, "Equip", 4, 4) or not Net.isId(raw) then return end
		local id = raw :: string
		local data = PlayerData.get(player)
		if not data or not (data.items[id] or data.owned[id]) then return end -- must own it
		local tools = ServerStorage:FindFirstChild("Tools")
		local template = tools and tools:FindFirstChild(id)
		local backpack, character = player:FindFirstChildOfClass("Backpack"), player.Character
		if not template or not template:IsA("Tool") or not backpack or backpack:FindFirstChild(id) or (character and character:FindFirstChild(id)) then return end
		template:Clone().Parent = backpack
	end)
end

return Inventory
```

## Teams
```lua
--!strict
local Players = game:GetService("Players")
local Teams = game:GetService("Teams")
local function team(name: string, color: BrickColor): Team
	local t = (Teams:FindFirstChild(name) :: Team?) or Instance.new("Team")
	t.Name, t.TeamColor, t.AutoAssignable = name, color, false
	t.Parent = Teams
	return t
end
local red, blue = team("Red", BrickColor.new("Bright red")), team("Blue", BrickColor.new("Bright blue"))
local function assign(player: Player)
	player.Team = if #red:GetPlayers() <= #blue:GetPlayers() then red else blue
end
Players.PlayerAdded:Connect(assign)
for _, player in Players:GetPlayers() do assign(player) end
```
Spawns: SpawnLocation `Neutral = false`, `TeamColor` matching each team (set with scene_update or at server start).
