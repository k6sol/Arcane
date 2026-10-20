# RPG code patterns (--!strict, server-authoritative)

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
