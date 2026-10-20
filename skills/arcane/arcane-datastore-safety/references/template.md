# PlayerData module (--!strict, session-locked)

ServerScriptService/Services/PlayerData, created disabled. Before writing it, `script_search` for `GetDataStore`: if the place already saves, copy its store name, key format and field names into the constants and `migrate`, and remove the old save code only in the same change that replaces it.

```lua
--!strict
local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

-- Existing place? Use its exact store name and key format. Never rename them.
local STORE_NAME = "PlayerData"
local KEY_FORMAT = "Player_%d"
local VERSION = 1
local LOCK_TTL = 1800 -- s; a crashed server's lock expires
local AUTOSAVE = 90
-- Studio writes the live experience's data when API access is on; off by default.
local USE_STORE = not RunService:IsStudio()

export type Data = { version: number, coins: number, owned: { [string]: boolean }, items: { [string]: number } }

local store = if USE_STORE then DataStoreService:GetDataStore(STORE_NAME) else nil
local profiles: { [Player]: Data } = {}
local listeners: { (Player, Data) -> () } = {}

local PlayerData = {}

-- Pure, old -> new. Keeps unknown fields, fills new ones, never downgrades.
local function migrate(raw: unknown): any
	local data: any = if typeof(raw) == "table" then raw else {}
	if data.coins == nil then data.coins = 0 end
	if data.owned == nil then data.owned = {} end
	if data.items == nil then data.items = {} end
	data.version = math.max(tonumber(data.version) or 0, VERSION)
	return data
end

local function retry(kind: Enum.DataStoreRequestType, call: () -> any): (boolean, any)
	for attempt = 1, 5 do
		local waited = 0
		while DataStoreService:GetRequestBudgetForRequestType(kind) <= 0 and waited < 10 do
			waited += task.wait(0.5)
		end
		local ok, result = pcall(call)
		if ok then return true, result end
		warn(string.format("[PlayerData] attempt %d failed: %s", attempt, tostring(result)))
		if attempt < 5 then task.wait(2 ^ (attempt - 1) + math.random()) end
	end
	return false, nil
end

local function key(player: Player): string
	return string.format(KEY_FORMAT, player.UserId)
end

-- Claim the session lock and load in one UpdateAsync.
local function claim(player: Player): Data?
	if not store then return migrate(nil) end
	local ds = store :: DataStore
	for _ = 1, 4 do
		local locked = false
		local ok, saved = retry(Enum.DataStoreRequestType.UpdateAsync, function()
			return ds:UpdateAsync(key(player), function(old)
				locked = false
				local data = migrate(old)
				local lock = data._lock
				if typeof(lock) == "table" and lock.jobId ~= game.JobId and os.time() - (tonumber(lock.time) or 0) < LOCK_TTL then
					locked = true
					return nil -- cancel: another server owns this player
				end
				data._lock = { jobId = game.JobId, time = os.time() }
				return data
			end)
		end)
		if not ok then return nil end
		if not locked then return migrate(saved) end
		task.wait(6)
	end
	return nil
end

local function save(player: Player, release: boolean): boolean
	local data = profiles[player]
	if not data or not store then return false end -- never save a profile that failed to load
	local ds = store :: DataStore
	local ok = retry(Enum.DataStoreRequestType.UpdateAsync, function()
		return ds:UpdateAsync(key(player), function(old)
			local current: any = old
			if typeof(current) == "table" then
				local lock = current._lock
				if typeof(lock) == "table" and lock.jobId ~= game.JobId then return nil end -- lost the lock
				if (tonumber(current.version) or 0) > data.version then return nil end -- newer format
			end
			local out: any = table.clone(data)
			out._lock = if release then nil else { jobId = game.JobId, time = os.time() }
			return out
		end)
	end)
	return ok
end

function PlayerData.get(player: Player): Data? -- nil until loaded: refuse purchases and rewards
	return profiles[player]
end

function PlayerData.changed(player: Player) -- call after every server-side mutation
	local data = profiles[player]
	if data then for _, fn in listeners do task.spawn(fn, player, data) end end
end

function PlayerData.onChanged(fn: (Player, Data) -> ())
	table.insert(listeners, fn)
end

function PlayerData.start()
	local function added(player: Player)
		local data = claim(player)
		if not player.Parent then -- left while loading: release without writing defaults
			if data and store then profiles[player] = data; save(player, true); profiles[player] = nil end
			return
		end
		if not data then
			player:Kick("Your data could not be loaded. Please rejoin.")
			return
		end
		profiles[player] = data
		PlayerData.changed(player)
	end
	Players.PlayerAdded:Connect(added)
	for _, player in Players:GetPlayers() do task.spawn(added, player) end
	Players.PlayerRemoving:Connect(function(player)
		save(player, true)
		profiles[player] = nil
	end)
	task.spawn(function() -- autosave refreshes the lock; staggered
		while true do
			task.wait(AUTOSAVE)
			for player in profiles do
				task.spawn(save, player, false)
				task.wait(1)
			end
		end
	end)
	game:BindToClose(function()
		if not store then return end
		local pending = 0
		for player in profiles do
			pending += 1
			task.spawn(function()
				save(player, true)
				pending -= 1
			end)
		end
		local deadline = os.clock() + 25
		while pending > 0 and os.clock() < deadline do task.wait(0.1) end
	end)
end

return PlayerData
```

## Notes
- Existing records without `_lock` load normally; the lock is an extra field, so older readers keep working. If an old store holds a bare number or another shape, add that case to `migrate` and keep the key.
- Never SetAsync or RemoveAsync a player key. Value grants (shop, rewards, Robux receipts) mutate `data` with no yield between the check and the write, then call `PlayerData.changed`.
- Leaderstats mirror: `PlayerData.onChanged(function(player, data) coins.Value = data.coins end)`; never read balances back from leaderstats.
- Test with `USE_STORE = false` (defaults, no writes) unless the user explicitly asks to test against a separate experience.
