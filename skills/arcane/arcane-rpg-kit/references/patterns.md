# RPG code patterns (--!strict, server-authoritative)

## Integration boundary: quest completion is not just a Done flag

The retained fragments assume actual data modules, helpers and owned profiles. They illustrate event flow rather than a complete secure RPG. Plan a connected quest/location/character graph with useful rewards and varied decisions; the initial talk/collect/kill sample is not a mandatory story or the whole journey.

The turn-in and inventory fragments do not implement one durable reward/capacity transaction. In particular, an inventory-full return must not follow an irrevocable Done mark that silently loses rewards. Before enabling, resolve capacity, reserve/deliver the intended reward and define duplicate-safe requested persistence/recovery. A session state change is not crash-safe claim settlement. Protect failed loads and migrate stable quest/item IDs deliberately.

Dialogue binds current NPC, node, distance and eligible choice; game events must originate in actual authoritative combat/pickup/reach systems, not client progress claims. Define shared kill credit, missing quest objects, interrupted dialogue, death/retry and old callback cleanup. Combat helpers still need actual queries, occlusion, interruption and media timing; illustrative cooldown numbers do not prove encounter fairness.

Compose readable dialogue/quest/inventory/equipment GUI with actual original characters, places, animation, ambient cues and useful reward feedback. Use real authorized assets and keep unsupported rig/import behavior explicit. Play introduction through reward use and later content, including full inventory, duplicate turn-in, out-of-range choices, simultaneous credit and requested rejoin. A known first dialogue scenario does not exercise combat, alternate branches or a complete adventure; retain those acceptance gaps.

Scripts start disabled (`scene_create` + `script_update`), then `script_read` + `script_set_enabled`. NPC rigs, pathfinding and states: `arcane-characters`.

## Content data (ReplicatedStorage.Shared)
```lua
--!strict
-- Quests
return {
	Q01 = { giver = "Elder", requires = { level = 1 },
		steps = { { kind = "talk", target = "Smith" }, { kind = "collect", target = "Herb", count = 5 }, { kind = "kill", target = "Wolf", count = 3 } },
		reward = { xp = 150, gold = 40, items = { { id = "IronSword", qty = 1 } } } },
}
-- Dialogue: nodes[id] = { speaker, text, choices = { { label, next?, action? } } }
-- action = { kind = "startQuest", quest = "Q01" } | { kind = "openShop" } | { kind = "turnIn", quest = "Q01" }
```

## QuestService (event-driven progress)
```lua
local QuestService = {}
local Quests = require(game.ReplicatedStorage.Shared.Quests)
function QuestService.start(player: Player, data, questId: string)
	local q = Quests[questId]
	if not q or data.quests[questId] or data.level < q.requires.level then return false end
	data.quests[questId] = { state = "Active", step = 1, progress = 0 }
	player:SetAttribute("ActiveQuest", questId); player:SetAttribute("QuestStep", 1)
	QuestUpdate:FireClient(player, questId, 1, 0)
	return true
end
function QuestService.event(player: Player, data, kind: string, target: string)
	for questId, state in data.quests do
		if state.state ~= "Active" then continue end
		local step = Quests[questId].steps[state.step]
		if step.kind ~= kind or step.target ~= target then continue end
		state.progress += 1
		if state.progress >= (step.count or 1) then
			state.step += 1; state.progress = 0
			if state.step > #Quests[questId].steps then state.state = "ReadyToTurnIn" end
		end
		player:SetAttribute("QuestStep", state.step)
		QuestUpdate:FireClient(player, questId, state.step, state.progress)
	end
end
function QuestService.turnIn(player: Player, data, questId: string)
	local state = data.quests[questId]
	if not state or state.state ~= "ReadyToTurnIn" then return end -- grants once
	state.state = "Done"
	local reward = Quests[questId].reward
	ProgressionService.addXp(player, data, reward.xp)
	data.gold += reward.gold
	for _, item in reward.items do InventoryService.add(player, data, item.id, item.qty) end
end
return QuestService
```
Callers: CombatService on enemy death (`"kill"`, enemy kind) credits players who dealt >= 20% damage; collectible prompts (`"collect"`); NPC talk (`"talk"`); zone parts (`"reach"`).

## DialogueService (server walks the tree)
```lua
local current: { [Player]: { npc: Model, node: string } } = {}
game:GetService("Players").PlayerRemoving:Connect(function(player) current[player] = nil end)
local function open(player: Player, npc: Model, node: string)
	current[player] = { npc = npc, node = node }
	ShowDialogue:FireClient(player, npc.Name, node) -- client renders text/choices from Shared.Dialogue
end
DialogueChoice.OnServerEvent:Connect(function(player, nodeId, index)
	local session = current[player]
	if not session or session.node ~= nodeId or type(index) ~= "number" then return end
	local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not root or (root.Position - session.npc:GetPivot().Position).Magnitude > 12 then current[player] = nil return end
	local choice = Dialogue[nodeId].choices[index]
	if not choice then return end
	if choice.action then runAction(player, choice.action) end -- server-only effects
	if choice.next then open(player, session.npc, choice.next) else current[player] = nil end
end)
```

## InventoryService (validated)
```lua
function InventoryService.add(player: Player, data, id: string, qty: number)
	local def = Items[id]; assert(def and qty > 0 and qty == math.floor(qty))
	for _, slot in data.inventory do
		if slot.id == id and def.stack and slot.qty + qty <= def.stack then slot.qty += qty; return sync(player, data) end
	end
	if #data.inventory >= 40 then Notify:FireClient(player, "Inventory full"); return end
	table.insert(data.inventory, { id = id, qty = qty }); sync(player, data)
end
Equip.OnServerInvoke = function(player, slotIndex)
	local data = profiles[player]; local slot = data and type(slotIndex) == "number" and data.inventory[slotIndex]
	if not slot or not Items[slot.id].equip then return false end
	data.equipped[Items[slot.id].equip] = slot.id
	return true
end
```

## Combat (intent + server hit check)
`Attack` intent: cooldown 0.5 s, alive, weapon equipped; server `GetPartBoundsInBox` in front of the root (5 x 5 x 6), damage = weapon base x (1 + 0.05 x level), each enemy once per swing. Enemies: server-owned (`SetNetworkOwner(nil)`), states Idle -> Aggro (player within 30) -> Attack (windup 0.4 s, telegraph) -> Leash (beyond 60 from camp, heal and return).

## Progression
```lua
local function xpToNext(level: number): number return math.floor(100 * level ^ 1.5) end
function ProgressionService.addXp(player: Player, data, amount: number)
	data.xp += amount
	while data.xp >= xpToNext(data.level) do
		data.xp -= xpToNext(data.level); data.level += 1
		player:SetAttribute("Level", data.level) -- HP max = 100 + 20 * (level - 1)
	end
	player:SetAttribute("XP", data.xp)
end
```

## Data record
`{ version = 1, lock = { jobId, time }, data = { level, xp, gold, inventory, equipped, quests, flags, position } }` through session-locked UpdateAsync with budget-checked retries; never save after a failed load; BindToClose saves all.

## Conditional tuning examples from the original kit

These inherited figures describe one starting configuration, not universal limits, verified performance or required mechanics. Choose relevant values for the actual brief, bind total resources to the intended audience/device and measure them in real play. Vehicle/platform motion, threat readability and commerce/persistence still require the integration checks above. Do not weaken supported-tool or production bounds to fit an example.

### Combat and progression numbers
| Level | XP to next | HP | Base damage |
|---|---|---|---|
| 1 | 100 | 100 | 10 |
| 5 | 100 * 5^1.5 ~ 1,118 | 180 | 22 |
| 10 | ~ 3,162 | 280 | 40 |
- XP to next = `100 * level^1.5`; HP = `100 + 20 * (level - 1)`. Enemy XP = `10 * enemyLevel`; a same-level enemy takes 3-5 hits and deals 8-12% of player HP per hit. Attack cooldown 0.5 s, enemy windup telegraph 0.4 s.
- Respawn at the hub, lose 10% gold (never items). Enemies respawn 20-40 s.

### Performance budgets
<= 25 active enemies per server (camps sleep with no player within 150 studs), enemy AI tick 4-5 Hz, pathfinding per `arcane-characters`; <= 40 inventory slots; NPCs anchored when stationary; StreamingEnabled for > 20k parts.
