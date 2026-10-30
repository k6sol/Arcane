# Simulator code patterns (--!strict, server-authoritative)

## Integration boundary: collection must connect to useful play

These snippets assume Config, remotes, profiles and helpers supplied by the actual game. They do not implement a complete progression economy, durable purchase or safe paid random-item system. Keep pets/eggs/rebirth out unless they serve the brief. A physical simulation is not automatically a collect-sell simulator.

Compose authoritative collection, capacity, selling and upgrades before adding the full requested activity/location roster. Validate alive/equipped actor, current node/zone ownership, range, rate and eligibility; UI and a hidden gate are not authority. Depletion/respawn callbacks require the original zone/node epoch, cleanup of removed nodes and a single reward claim. Full inventory, simultaneous depletion and duplicate sell touches need intentional outcomes.

The egg roll is a server-side weighted sampling fragment, not a complete persistent receipt/grant path or platform-policy approval. Validate bounded definitions and current eligibility before indexing, serialize related profile effects and recover uncertain persistence through the original transaction. Never activate a real purchase with fabricated IDs, client rolls or merely a successful reveal animation. Requested saves preserve failed-load protection and consistent equipment/bonus state.

Build actual tool contact/recovery animation, bag/currency/benefit UI, useful location affordances and restrained collection sound/VFX. Pets are bounded presentation over real owned equipment, not source of trusted bonuses. Test full-bag/locked-zone denials, later upgrade effects, expired respawn after unload, repeated sale, failed load and reset. Compare actual travel/action time with the example price curve; a clickable hub and rising number are not proof of varied content, satisfying activity or retention.

Scripts start disabled (`scene_create` + `script_update`), then `script_read` + `script_set_enabled`. Saving stays disabled until the user asks (`arcane-datastore-safety`).

## SimConfig (ReplicatedStorage.Shared)
```lua
--!strict
return {
	Zones = {
		{ id = 1, price = 0, nodeValue = 1, nodeHp = 3, respawn = 5 },
		{ id = 2, price = 1000, nodeValue = 6, nodeHp = 10, respawn = 8 },
		{ id = 3, price = 12000, nodeValue = 40, nodeHp = 30, respawn = 10 },
	},
	Bags = { 25, 80, 250, 800 }, BagPrices = { 0, 200, 1600, 12800 },
	SwingCooldown = 0.35, CollectRange = 12,
	Eggs = {
		Basic = { price = 250, odds = { { "Common", 60 }, { "Uncommon", 28 }, { "Rare", 10 }, { "Epic", 2 } } },
	},
	PetBonus = { Common = 0.10, Uncommon = 0.25, Rare = 0.60, Epic = 1.50 },
}
```

## CollectService (validated click intent)
```lua
local lastSwing: { [Player]: number } = {}
local nodeHp: { [BasePart]: number } = {}
game:GetService("Players").PlayerRemoving:Connect(function(player) lastSwing[player] = nil end)
Collect.OnServerEvent:Connect(function(player, node)
	if typeof(node) ~= "Instance" or not node:IsA("BasePart") or not node:IsDescendantOf(workspace.Zones) then return end
	local now = os.clock()
	if now - (lastSwing[player] or 0) < Config.SwingCooldown then return end
	lastSwing[player] = now
	local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not root or (root.Position - node.Position).Magnitude > Config.CollectRange then return end
	local zoneId = node:GetAttribute("Zone")
	local zone = typeof(zoneId) == "number" and Config.Zones[zoneId]
	if not zone or (player:GetAttribute("Zone") :: number? or 1) < zoneId or node.Transparency >= 1 then return end
	local bag, bagMax = player:GetAttribute("Bag") :: number? or 0, player:GetAttribute("BagMax") :: number? or 25
	if bag >= bagMax then return end
	nodeHp[node] = (nodeHp[node] or zone.nodeHp) - power(player)
	if nodeHp[node] > 0 then return end
	player:SetAttribute("Bag", math.min(bagMax, bag + zone.nodeValue))
	nodeHp[node] = nil
	node.Transparency, node.CanCollide = 1, false
	task.delay(zone.respawn, function() node.Transparency, node.CanCollide = 0, true end)
end)
```
The server sets each node's `Zone` attribute at start from its Folder (scene_build cannot add attributes).

## SellService (pad touch, no remote)
```lua
sellPad.Touched:Connect(function(hit)
	local player = game.Players:GetPlayerFromCharacter(hit.Parent)
	if not player or selling[player] then return end
	selling[player] = true
	local bag = player:GetAttribute("Bag") :: number? or 0
	player:SetAttribute("Coins", (player:GetAttribute("Coins") :: number? or 0) + bag * multiplier(player))
	player:SetAttribute("Bag", 0)
	task.delay(0.5, function() selling[player] = nil end)
end)
```

## Weighted egg roll (server only)
```lua
local rng = Random.new()
local function roll(odds: { { any } }): string
	local total = 0
	for _, row in odds do total += row[2] end
	local pick = rng:NextNumber(0, total)
	for _, row in odds do
		pick -= row[2]
		if pick <= 0 then return row[1] end
	end
	return odds[#odds][1]
end
HatchEgg.OnServerInvoke = function(player, eggName)
	local egg = Config.Eggs[eggName]
	if type(eggName) ~= "string" or not egg or busy[player] then return nil end
	local coins = player:GetAttribute("Coins") :: number? or 0
	if coins < egg.price then return nil end
	busy[player] = true
	player:SetAttribute("Coins", coins - egg.price)
	local rarity = roll(egg.odds)
	local uid = game:GetService("HttpService"):GenerateGUID(false)
	addPet(player, uid, rarity) -- session data; saved by DataService
	busy[player] = nil
	return { uid = uid, rarity = rarity } -- client plays the reveal
end
```

## Pet follow (client visuals only)
Clone a pet template from ReplicatedStorage per equipped uid into a client Folder; each RenderStepped lerp its pivot toward `root.CFrame * CFrame.new(offsetX, 1.5 + math.sin(t*3)*0.3, 4)` with alpha `1 - 0.001 ^ dt`. Other players' pets are rendered from their `EquippedPets` attribute (comma-separated uids or kinds).

## Zone unlock (Buy RemoteFunction)
Validate `zoneId == player.Zone + 1`, price from config, coins >= price; deduct, set `Zone`, return true. The client then hides the gate locally; rewards in the zone are still checked on the server.

## Data record
`{ version = 1, lock = { jobId, time }, data = { coins, rebirths, tool, bag, zones, pets, equipped, eggsOpened } }` through session-locked `UpdateAsync` with budget-checked retries; never save after a failed load; BindToClose saves all.

## Conditional tuning examples from the original kit

These inherited figures describe one starting configuration, not universal limits, verified performance or required mechanics. Choose relevant values for the actual brief, bind total resources to the intended audience/device and measure them in real play. Vehicle/platform motion, threat readability and commerce/persistence still require the integration checks above. Do not weaken supported-tool or production bounds to fit an example.

### Balancing (starting numbers)
| Zone | Unlock | Node value | Node HP | Respawn |
|---|---|---|---|---|
| 1 | free | 1 | 3 | 5 s |
| 2 | 1,000 | 6 | 10 | 8 s |
| 3 | 12,000 | 40 | 30 | 10 s |
| 4 | 150,000 | 250 | 90 | 12 s |
- Swing 0.35 s cooldown; damage = tool power x pet bonus. Bag 25 -> 80 -> 250 -> 800 (price x8 per tier, ~3 min of farming each). Sell 1 coin per bag unit x zone multiplier.
- Eggs: 250 / 3,000 / 40,000 coins. Odds per egg: Common 60%, Uncommon 28%, Rare 10%, Epic 2% (shown in the UI). Pet bonus +10% / +25% / +60% / +150%; equip 3 (5 after 1st rebirth).
- Rebirth at 1M lifetime coins, then x3 each; +50% coins per rebirth; resets coins, bag, zones; keeps pets.

### Performance budgets
<= 60 nodes per zone, nodes anchored with one shared respawn loop; pets: client-side follow (server stores only equipped ids), <= 5 pets per player rendered, <= 30 parts per pet; collect remote rate-limit 6/s per player; HUD updates on attribute change, no per-frame polling.
