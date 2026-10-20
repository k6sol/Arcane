# Pets and followers code (--!strict, DataStore-safe)

All scripts created disabled; enable with `script_set_enabled` after `script_read`. Remote rules: `arcane-remote-security`. Saving: `arcane-datastore-safety:template` (`PlayerData`).

## PetService (ServerScriptService ModuleScript, DataStore-safe)
Profile fields (add defaults in `PlayerData` `migrate`, never rename): `pets = { [uid] = { kind = "Cat" } }`, `equipped = { uid }`. Templates: `ServerStorage.Pets.<Kind>` Models with a PrimaryPart. Only kinds and server uids are saved, never instances, positions or client values.
```lua
--!strict
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local PlayerData = require(script.Parent.PlayerData)

local KINDS: { [string]: { bonus: number } } = { Cat = { bonus = 0.10 }, Dog = { bonus = 0.25 } }
local MAX_OWNED, MAX_EQUIPPED = 60, 3
local folder = workspace:FindFirstChild("Pets") or Instance.new("Folder")
folder.Name = "Pets"
folder.Parent = workspace
local Equip = ReplicatedStorage.Remotes:FindFirstChild("EquipPet") or Instance.new("RemoteEvent")
Equip.Name = "EquipPet"
Equip.Parent = ReplicatedStorage.Remotes
local spawned: { [Player]: { Model } } = {}
local lastEquip: { [Player]: number } = {}

local PetService = {}

-- Loaded profile with pet fields, or nil: callers refuse work until the profile loads.
local function profile(player: Player): any
	local data = PlayerData.get(player) :: any
	if data then
		data.pets = data.pets or {}
		data.equipped = data.equipped or {}
	end
	return data
end

local function clear(player: Player)
	for _, model in spawned[player] or {} do model:Destroy() end
	spawned[player] = {}
end

-- Followers: physics constraints to an attachment behind the owner; no per-frame server script.
local function refresh(player: Player)
	clear(player)
	local data = profile(player)
	local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
	if not data or not (root and root:IsA("BasePart")) then return end
	for slot, uid in data.equipped do
		local pet = data.pets[uid]
		local template = pet and ServerStorage.Pets:FindFirstChild(pet.kind)
		if template and template:IsA("Model") and template.PrimaryPart then
			local model = template:Clone()
			local primary = model.PrimaryPart :: BasePart
			for _, part in model:GetDescendants() do
				if part:IsA("BasePart") then
					part.Anchored, part.CanCollide, part.CanQuery, part.Massless = false, false, false, true
					if part ~= primary then
						local weld = Instance.new("WeldConstraint")
						weld.Part0, weld.Part1, weld.Parent = primary, part, part
					end
				end
			end
			local a0, a1 = Instance.new("Attachment"), Instance.new("Attachment")
			a0.Parent = primary
			a1.Name, a1.Position, a1.Parent = "PetSlot", Vector3.new((slot - 2) * 3, 0.5, 4), root
			local align = Instance.new("AlignPosition")
			align.Attachment0, align.Attachment1, align.Responsiveness, align.MaxForce = a0, a1, 25, 1e5
			align.Parent = primary
			local turn = Instance.new("AlignOrientation")
			turn.Attachment0, turn.Attachment1, turn.Responsiveness = a0, a1, 20
			turn.Parent = primary
			model:PivotTo(root.CFrame * CFrame.new(a1.Position))
			model.Parent = folder
			pcall(primary.SetNetworkOwner, primary, player) -- cosmetic: smooth for the owner, no gameplay authority
			table.insert(spawned[player], model)
		end
	end
end

function PetService.grant(player: Player, kind: string): string? -- call from server reward/egg code only
	local data = profile(player)
	if not data or not KINDS[kind] then return nil end -- profile not loaded: refuse, never overwrite
	local count = 0
	for _ in data.pets do count += 1 end
	if count >= MAX_OWNED then return nil end
	local uid = HttpService:GenerateGUID(false)
	data.pets[uid] = { kind = kind }
	PlayerData.changed(player)
	return uid
end

function PetService.bonus(player: Player): number -- from saved data, never from the pet model
	local data = profile(player)
	local total = 0
	for _, uid in (data and data.equipped) or {} do
		local pet = data.pets[uid]
		local kind = pet and KINDS[pet.kind]
		if kind then total += kind.bonus end
	end
	return total
end

Equip.OnServerEvent:Connect(function(player, uid)
	local data = profile(player)
	local now = os.clock()
	if not data or typeof(uid) ~= "string" or #uid > 40 or not data.pets[uid] or now - (lastEquip[player] or 0) < 0.5 then return end
	lastEquip[player] = now
	local at = table.find(data.equipped, uid)
	if at then table.remove(data.equipped, at)
	elseif #data.equipped < MAX_EQUIPPED then table.insert(data.equipped, uid)
	else return end
	PlayerData.changed(player)
	refresh(player)
end)

Players.PlayerAdded:Connect(function(player)
	player.CharacterAdded:Connect(function() task.wait(1); refresh(player) end)
end)
Players.PlayerRemoving:Connect(function(player) clear(player); spawned[player] = nil; lastEquip[player] = nil end)

return PetService
```
- Walking companions (Humanoid followers) use `arcane-characters:npc-ai` Mover with goal = owner root + offset; server-owned.
- Trading/deleting pets: `arcane-trading`; deletion only on the player's explicit request, after a loaded profile.
