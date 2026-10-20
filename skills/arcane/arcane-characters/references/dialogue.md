# Dialogue code (--!strict, server-authoritative)

All scripts created disabled; enable with `script_set_enabled` after `script_read`. Remote rules: `arcane-remote-security`. Saving: `arcane-datastore-safety:template` (`PlayerData`).

## Shared/Dialogue (ReplicatedStorage ModuleScript)
```lua
--!strict
export type Choice = { label: string, next: string?, action: string? }
export type Node = { text: string, choices: { Choice } }
-- Tag an NPC model "Talker" and set attribute Tree = "Shopkeeper". Every tree starts at "start".
local trees: { [string]: { [string]: Node } } = {
	Shopkeeper = {
		start = { text = "Welcome, traveller. Need supplies?", choices = {
			{ label = "Show me your wares", action = "openShop" },
			{ label = "Any work for me?", next = "quest" },
			{ label = "Goodbye" },
		} },
		quest = { text = "Wolves took my lantern. Bring it back?", choices = {
			{ label = "I'll find it", action = "startQuest" },
			{ label = "Not now", next = "start" },
		} },
	},
}
return trees
```

## DialogueServer (ServerScriptService Script)
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local trees = require(ReplicatedStorage.Shared.Dialogue)

local remotes = ReplicatedStorage:FindFirstChild("Remotes") or Instance.new("Folder")
remotes.Name = "Remotes"
remotes.Parent = ReplicatedStorage
local function remote(name: string): RemoteEvent
	local r = remotes:FindFirstChild(name) or Instance.new("RemoteEvent")
	r.Name = name
	r.Parent = remotes
	return r :: RemoteEvent
end
local Show, Choose, OpenShop = remote("DialogueShow"), remote("DialogueChoose"), remote("OpenShop")

type Session = { npc: Model, tree: string, node: string, at: number }
local sessions: { [Player]: Session } = {}
local MAX_DISTANCE = 14

-- Outcomes run here, never on the client. Real quest state belongs in PlayerData.
local ACTIONS: { [string]: (Player, Model) -> () } = {
	openShop = function(player) OpenShop:FireClient(player) end,
	startQuest = function(player) player:SetAttribute("Quest", "Lantern") end,
}

local function rootOf(model: Model?): BasePart?
	local root = model and model:FindFirstChild("HumanoidRootPart")
	return if root and root:IsA("BasePart") then root else nil
end

local function near(player: Player, npc: Model): boolean
	local a, b = rootOf(player.Character), rootOf(npc)
	return a ~= nil and b ~= nil and (a.Position - b.Position).Magnitude <= MAX_DISTANCE
end

local function send(player: Player, s: Session?)
	if not s then Show:FireClient(player, nil); return end
	local node = trees[s.tree][s.node]
	local labels = {}
	for i, choice in node.choices do labels[i] = choice.label end
	local hum = s.npc:FindFirstChildOfClass("Humanoid")
	Show:FireClient(player, { speaker = if hum and hum.DisplayName ~= "" then hum.DisplayName else s.npc.Name, text = node.text, choices = labels })
end

local function attach(npc: Instance)
	local root = npc:IsA("Model") and rootOf(npc)
	local tree = npc:GetAttribute("Tree")
	if not root or typeof(tree) ~= "string" or not trees[tree] then return end
	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText, prompt.ObjectText = "Talk", npc.Name
	prompt.MaxActivationDistance, prompt.HoldDuration, prompt.RequiresLineOfSight = 10, 0, false
	prompt.Parent = root
	prompt.Triggered:Connect(function(player)
		local model = npc :: Model
		local s = { npc = model, tree = tree, node = "start", at = 0 }
		sessions[player] = s
		player:SetAttribute("TalkedTo", model.Name) -- playtest assertion hook
		local pr = rootOf(player.Character)
		if pr and root.Anchored then -- stationary NPC turns to face the player (flattened Y)
			model:PivotTo(CFrame.lookAt(root.Position, Vector3.new(pr.Position.X, root.Position.Y, pr.Position.Z)))
		end
		send(player, s)
	end)
end

Choose.OnServerEvent:Connect(function(player, index)
	local s = sessions[player]
	if not s or typeof(index) ~= "number" or index % 1 ~= 0 then return end
	local now = os.clock()
	if now - s.at < 0.25 then return end -- rate limit
	s.at = now
	local choice = trees[s.tree][s.node].choices[index]
	if not choice or not near(player, s.npc) then sessions[player] = nil; send(player, nil); return end
	local action = choice.action and ACTIONS[choice.action]
	if action then action(player, s.npc) end
	if choice.next then s.node = choice.next; send(player, s) else sessions[player] = nil; send(player, nil) end
end)

-- Close conversations when the player walks away or leaves.
task.spawn(function()
	while true do
		task.wait(0.5)
		for player, s in sessions do
			if not s.npc.Parent or not near(player, s.npc) then sessions[player] = nil; send(player, nil) end
		end
	end
end)
Players.PlayerRemoving:Connect(function(player) sessions[player] = nil end)
CollectionService:GetInstanceAddedSignal("Talker"):Connect(attach)
for _, npc in CollectionService:GetTagged("Talker") do attach(npc) end
```

## DialogueClient (StarterPlayerScripts LocalScript)
UI from `scene_build` (`arcane-interface` tokens): StarterGui ScreenGui `Dialogue` (Enabled false, ResetOnSpawn false) > Frame `Panel` > TextLabel `Speaker`, TextLabel `Body`, Frame `Choices` (UIListLayout) > TextButton `ChoiceTemplate` (Visible false, 44 px tall).
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local remotes = ReplicatedStorage:WaitForChild("Remotes")
local Show = remotes:WaitForChild("DialogueShow") :: RemoteEvent
local Choose = remotes:WaitForChild("DialogueChoose") :: RemoteEvent
local gui = Players.LocalPlayer:WaitForChild("PlayerGui"):WaitForChild("Dialogue") :: ScreenGui
local panel = gui:WaitForChild("Panel")
local speaker = panel:WaitForChild("Speaker") :: TextLabel
local body = panel:WaitForChild("Body") :: TextLabel
local list = panel:WaitForChild("Choices") :: Frame
local template = list:WaitForChild("ChoiceTemplate") :: TextButton
local typing: thread? = nil

Show.OnClientEvent:Connect(function(node)
	if typing then task.cancel(typing); typing = nil end
	for _, child in list:GetChildren() do
		if child:IsA("TextButton") and child ~= template then child:Destroy() end
	end
	if typeof(node) ~= "table" then gui.Enabled = false; return end
	speaker.Text, body.Text = tostring(node.speaker), tostring(node.text)
	body.MaxVisibleGraphemes = 0
	typing = task.spawn(function() -- typewriter, about 40 characters per second
		for i = 1, utf8.len(body.Text) or 0 do body.MaxVisibleGraphemes = i; task.wait(0.025) end
		body.MaxVisibleGraphemes = -1
	end)
	for i, label in node.choices do
		local button = template:Clone()
		button.Name, button.Text, button.LayoutOrder, button.Visible = "Choice" .. i, tostring(label), i, true
		button.Activated:Connect(function() Choose:FireServer(i) end)
		button.Parent = list
	end
	gui.Enabled = true
end)
```
