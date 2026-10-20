# Arena code patterns (--!strict, server-authoritative)

Scripts start disabled (`scene_create` + `script_update`), then `script_read` + `script_set_enabled`. Edge cases (disconnect during results, simultaneous final hits): `arcane-rounds`.

## RoundService (epoch state machine)
```lua
--!strict
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local RoundService = {}
local epoch = 0
local MIN_PLAYERS = if RunService:IsStudio() then 1 else 2

local function setState(state: string, seconds: number)
	workspace:SetAttribute("RoundState", state)
	workspace:SetAttribute("TimeLeft", seconds)
end
local function countdown(myEpoch: number, seconds: number, stopEarly: (() -> boolean)?)
	for t = seconds, 1, -1 do
		if epoch ~= myEpoch then return end
		workspace:SetAttribute("TimeLeft", t)
		if stopEarly and stopEarly() then return end
		task.wait(1)
	end
end

function RoundService.run()
	while true do
		setState("Waiting", 0)
		while #Players:GetPlayers() < MIN_PLAYERS do task.wait(1) end
		epoch += 1
		local myEpoch = epoch
		setState("Intermission", 20)
		VoteService.open(MapService.pick(3))
		countdown(myEpoch, 20)
		local mapName = VoteService.close()
		setState("Loading", 3)
		local map = MapService.load(mapName)
		MapService.teleportAll(map)
		setState("InRound", 150)
		local winner: Player? = nil
		countdown(myEpoch, 150, function()
			winner = StatsService.leaderReached(15) or StatsService.lastAlive()
			return winner ~= nil
		end)
		setState("Results", 8)
		StatsService.awardOnce(myEpoch, winner or StatsService.topKills())
		countdown(myEpoch, 8)
		MapService.unload(map)
		MapService.returnAllToLobby()
	end
end
return RoundService
```
`awardOnce` keeps `awarded[epoch] = true` so timeout and last-alive paths cannot both grant a win.

## VoteService
```lua
local votes: { [Player]: string } = {}
local options: { string } = {}
local open = false
game:GetService("Players").PlayerRemoving:Connect(function(player) votes[player] = nil end) -- leavers do not count
Vote.OnServerEvent:Connect(function(player, mapName)
	if not open or type(mapName) ~= "string" or not table.find(options, mapName) then return end
	votes[player] = mapName
	player:SetAttribute("VotedFor", mapName)
end)
function VoteService.open(list: { string })
	options, votes, open = list, {}, true
	workspace:SetAttribute("VoteOptions", table.concat(list, ","))
end
function VoteService.close(): string
	open = false
	local tally: { [string]: number } = {}
	for _, name in votes do tally[name] = (tally[name] or 0) + 1 end
	local best, bestCount, ties = options[1], -1, {}
	for _, name in options do
		local n = tally[name] or 0
		if n > bestCount then best, bestCount, ties = name, n, { name }
		elseif n == bestCount then table.insert(ties, name) end
	end
	return ties[math.random(#ties)] or best
end
```

## WeaponService (validated ranged fire with rewind)
```lua
local history: { [Player]: { { t: number, cf: CFrame } } } = {} -- 20 Hz, 1 s per player
local lastShot: { [Player]: number } = {}
game:GetService("Players").PlayerRemoving:Connect(function(player) history[player], lastShot[player] = nil, nil end)
Fire.OnServerEvent:Connect(function(player, origin, direction, shotId)
	if typeof(origin) ~= "Vector3" or typeof(direction) ~= "Vector3" or type(shotId) ~= "number" then return end
	if workspace:GetAttribute("RoundState") ~= "InRound" or not player:GetAttribute("Alive") then return end
	local tool = player.Character and player.Character:FindFirstChildOfClass("Tool")
	local spec = tool and WeaponConfig[tool.Name]
	if not spec or direction.Magnitude < 0.99 or direction.Magnitude > 1.01 then return end
	local now = os.clock()
	if now - (lastShot[player] or 0) < (60 / spec.rpm) * 0.9 then return end
	lastShot[player] = now
	local head = player.Character:FindFirstChild("Head") :: BasePart?
	if not head or (head.Position - origin).Magnitude > 6 then return end
	if not Ammo.consume(player, tool) then return end
	local rewind = math.clamp(player:GetNetworkPing(), 0, 0.25)
	local victim, part = raycastAgainstHistory(origin, direction * spec.range, now - rewind, player)
	if victim and victim ~= player and sameTeamAllowed(player, victim) then
		local hum = victim.Character and victim.Character:FindFirstChildOfClass("Humanoid")
		if hum and hum.Health > 0 and not victim:GetAttribute("SpawnProtected") then
			hum:TakeDamage(part and part.Name == "Head" and spec.headDamage or spec.damage)
			HitConfirm:FireClient(player, shotId)
			if hum.Health <= 0 then StatsService.kill(player, victim) end
		end
	end
end)
```
`raycastAgainstHistory` moves cheap hitbox proxies (one per player, in a server-only Folder) to the rewound CFrames, raycasts with a whitelist of those proxies and the map, then restores them. Never move real characters.

## Melee swing
On a validated `Swing` intent (cooldown, alive, equipped), the server runs `workspace:GetPartBoundsInBox(root.CFrame * CFrame.new(0, 0, -4), Vector3.new(5, 5, 6), params)` once, collects unique Humanoids (excluding self), damages each once.

## Data record
`{ version = 1, lock = { jobId, time }, data = { wins, kills, deaths, matches, xp, unlocked } }` through session-locked `UpdateAsync` with budget-checked retries; save at Results (staggered) and on leave/BindToClose.
