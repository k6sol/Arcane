--!strict
-- Native asset adoption: the built-in Studio tools insert or generate an instance; this module
-- adopts exactly that one instance (strip scripts by default, fit, ground, pivot, anchor, parent)
-- under one undo recording and receipt, and clones script-free templates for scene.build.
local V = require(script.Parent.Validation)
local AssetPlacement = {}

AssetPlacement.LIMITS = table.freeze({descendants = 5000, templateDescendants = 2000, templates = 16, watches = 4,
	watchSeconds = 600, additions = 64, arrivalSeconds = 10, materialTargets = 64, removedNames = 20})
AssetPlacement.GENERATED_MATERIALS = table.freeze({"Plastic", "SmoothPlastic", "Wood", "WoodPlanks", "Marble", "Basalt", "Slate", "CrackedLava",
	"Concrete", "Limestone", "Granite", "Pavement", "Brick", "Pebble", "Cobblestone", "Rock", "Sandstone", "CorrodedMetal", "DiamondPlate", "Foil",
	"Metal", "Grass", "LeafyGrass", "Sand", "Fabric", "Snow", "Mud", "Ground", "Asphalt", "Salt", "Ice", "Glacier", "Cardboard", "Carpet",
	"CeramicTiles", "ClayRoofTiles", "RoofShingles", "Leather", "Plaster", "Rubber"})
local L = AssetPlacement.LIMITS

local function triple(value: any, low: number, high: number, label: string): {number}
	local list = V.list(value, 3, label)
	if #list ~= 3 then V.fail("INPUT", label .. " needs three numbers.") end
	for _, item in ipairs(list) do V.number(item, low, high, label) end
	return {list[1], list[2], list[3]}
end

-- Pure placement math (also exercised directly by the standalone tests).
-- components are CFrame:GetComponents(): x, y, z, R00, R01, R02, R10, R11, R12, R20, R21, R22.
function AssetPlacement.worldExtents(c: {number}, size: any): {number}
	local sx, sy, sz = size.X, size.Y, size.Z
	return {math.abs(c[4]) * sx + math.abs(c[5]) * sy + math.abs(c[6]) * sz,
		math.abs(c[7]) * sx + math.abs(c[8]) * sy + math.abs(c[9]) * sz,
		math.abs(c[10]) * sx + math.abs(c[11]) * sy + math.abs(c[12]) * sz}
end
-- Uniform scale that fits the world extents inside maxSize (the tightest axis wins).
function AssetPlacement.fitScale(extents: {number}, maxSize: {number}?): number
	if not maxSize then return 1 end
	local scale = math.huge
	for axis = 1, 3 do
		if extents[axis] > 1e-6 then scale = math.min(scale, maxSize[axis] / extents[axis]) end
	end
	if scale == math.huge then V.fail("ASSET", "The asset has no measurable size; nothing was adopted.") end
	if scale < 0.01 or scale > 100 then V.fail("ASSET", "Fitting the asset to maxSize needs a scale outside 0.01..100; choose a closer size or another asset.") end
	return scale
end
function AssetPlacement.bottomCenter(c: {number}, extents: {number}): {number}
	return {c[1], c[2] - extents[2] / 2, c[3]}
end

local function boxOf(root: any): ({number}, {number})
	local cframe, size = root:GetBoundingBox()
	local components = {cframe:GetComponents()}
	return components, AssetPlacement.worldExtents(components, size)
end

-- One-shot watch: records top-level instances added under Workspace after it is armed.
function AssetPlacement.watch(ops: any): any
	local workspace = ops.registry:root("Workspace")
	local watches = ops.assetWatches
	if not watches then watches = {}; ops.assetWatches = watches end
	local now = os.clock()
	local count, oldestId, oldestAt = 0, nil, math.huge
	for id, entry in pairs(watches) do
		if entry.expires <= now then entry.connection:Disconnect(); watches[id] = nil
		else
			count += 1
			if entry.started < oldestAt then oldestId, oldestAt = id, entry.started end
		end
	end
	if count >= L.watches and oldestId then watches[oldestId].connection:Disconnect(); watches[oldestId] = nil end
	local id = (string.gsub(ops.http:GenerateGUID(false), "[^%w_%-]", ""))
	local entry: any = {additions = {}, seen = {}, overflow = false, started = now, expires = now + L.watchSeconds}
	entry.connection = workspace.DescendantAdded:Connect(function(instance: any)
		local cursor = instance.Parent
		while cursor and cursor ~= workspace do
			if entry.seen[cursor] then return end
			cursor = cursor.Parent
		end
		if #entry.additions >= L.additions then entry.overflow = true; return end
		entry.seen[instance] = true
		table.insert(entry.additions, instance)
	end)
	watches[id] = entry
	return {watch = id, expiresInSeconds = L.watchSeconds}
end

local function release(ops: any, id: string): ()
	local entry = ops.assetWatches and ops.assetWatches[id]
	if entry then entry.connection:Disconnect(); ops.assetWatches[id] = nil end
end

local function candidates(ops: any, entry: any, workspace: any): {any}
	local tops: {any} = {}
	for _, instance in ipairs(entry.additions) do
		if instance.Parent ~= nil and instance:IsDescendantOf(workspace) and not ops.registry.owned[instance]
			and (instance:IsA("Model") or instance:IsA("BasePart") or instance:IsA("Folder")) then
			local nested, cursor = false, instance.Parent
			while cursor and cursor ~= workspace do
				if entry.seen[cursor] then nested = true; break end
				cursor = cursor.Parent
			end
			if not nested then table.insert(tops, instance) end
		end
	end
	return tops
end

-- Waits up to arrivalSeconds for exactly one inserted instance. Never adopts on ambiguity.
function AssetPlacement.arrival(ops: any, id: string, expectName: string?, workspace: any): any
	local entry = ops.assetWatches and ops.assetWatches[id]
	if not entry or entry.expires <= os.clock() then V.fail("WATCH", "The insertion watch is unknown or expired; start the insert again.") end
	local polls = L.arrivalSeconds * 4
	for attempt = 0, polls do
		if entry.overflow then V.fail("AMBIGUOUS", "Too many instances appeared in Workspace during the insertion; nothing was adopted. Inspect Workspace before trying again.") end
		local tops = candidates(ops, entry, workspace)
		local chosen: any = nil
		if expectName then
			local named: {any} = {}
			for _, instance in ipairs(tops) do if instance.Name == expectName then table.insert(named, instance) end end
			if #named > 1 then V.fail("AMBIGUOUS", "Several instances share the inserted asset name; nothing was adopted.") end
			chosen = named[1]
		end
		if not chosen and #tops > 1 then V.fail("AMBIGUOUS", "Several new instances appeared in Workspace during the insertion; nothing was adopted. Inspect Workspace and remove any unwanted insert.") end
		chosen = chosen or tops[1]
		if chosen then return chosen end
		if attempt < polls then task.wait(0.25) end
	end
	V.fail("NOT_FOUND", "No inserted instance appeared in Workspace within " .. L.arrivalSeconds .. " seconds; nothing was adopted.")
	return nil
end

function AssetPlacement.place(ops: any, command: any, args: any, guard: () -> ()): any
	V.fields(args, {"watch", "expectName", "parent", "name", "maxSize", "position", "yaw", "ground", "anchor", "allowScripts"}, "asset placement")
	local id = V.string(args.watch, "insertion watch", 128)
	local expectName = if args.expectName == nil then nil else V.string(args.expectName, "expected asset name", 100)
	local container = ops.registry:resolve(args.parent)
	local name = V.string(args.name, "asset name", 100)
	local maxSize = if args.maxSize == nil then nil else triple(args.maxSize, 0.2, 2048, "asset maxSize")
	local position = triple(args.position, -100000, 100000, "asset position")
	local yaw = V.number(args.yaw, -360, 360, "asset yaw")
	local ground, anchor, allowScripts = V.boolean(args.ground, "ground"), V.boolean(args.anchor, "anchor"), V.boolean(args.allowScripts, "allowScripts")
	local workspace = ops.registry:root("Workspace")
	if ops.registry.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
	local asset = AssetPlacement.arrival(ops, id, expectName, workspace)
	local descendants = asset:GetDescendants()
	if #descendants + 1 > L.descendants then V.fail("BODY_LIMIT", "The inserted asset has more than " .. L.descendants .. " instances; nothing was adopted. Remove it or choose a lighter asset.") end
	local physical = asset:IsA("BasePart")
	for _, item in ipairs(descendants) do if item:IsA("BasePart") then physical = true; break end end
	if not physical then V.fail("ASSET", "The inserted asset has no 3D parts; nothing was adopted. Remove it from Workspace if unwanted.") end
	return ops:record(command, guard, function(progress: any): any
		guard()
		ops.registry:resolve(args.parent)
		if asset.Parent == nil then V.fail("ASSET", "The inserted asset disappeared before adoption.") end
		progress.touched = true
		-- Free models can carry hostile scripts: remove every script unless explicitly allowed.
		local removed: number, kept: number, classes: {[string]: number}, names: any = 0, 0, {}, V.array({})
		for _, item in ipairs(asset:GetDescendants()) do
			if item.Parent ~= nil and item:IsA("LuaSourceContainer") then
				if allowScripts then kept += 1
				else
					removed += 1
					classes[item.ClassName] = (classes[item.ClassName] or 0) + 1
					if #names < L.removedNames then table.insert(names, string.sub(item.Name, 1, 100)) end
					item:Destroy()
				end
			end
		end
		local root = asset
		if asset:IsA("Model") then asset.Parent = nil
		else
			root = Instance.new("Model")
			asset.Parent = root
		end
		local anchored: number = 0
		if anchor then
			for _, item in ipairs(root:GetDescendants()) do
				if item:IsA("BasePart") then item.Anchored = true; anchored += 1 end
			end
		end
		local components, extents = boxOf(root)
		local scale = AssetPlacement.fitScale(extents, maxSize)
		if scale ~= 1 then
			root:ScaleTo(root:GetScale() * scale)
			components, extents = boxOf(root)
		end
		local bottom = AssetPlacement.bottomCenter(components, extents)
		root.WorldPivot = CFrame.new(bottom[1], bottom[2], bottom[3])
		local y, grounded = position[2], false
		if ground then
			-- The asset is detached, so the probe only sees existing terrain and parts.
			local hit = workspace:Raycast(Vector3.new(position[1], position[2] + 500, position[3]), Vector3.new(0, -1000, 0))
			if hit then y, grounded = hit.Position.Y, true end
		end
		root:PivotTo(CFrame.new(position[1], y, position[3]) * CFrame.Angles(0, math.rad(yaw), 0))
		root.Name = name
		root.Parent = container
		local ref = ops.registry:ref(root)
		progress.ref = ref
		local count = #root:GetDescendants()
		ops.registry.owned[root] = {parent = container, placed = {count = count, pivot = {root.WorldPivot:GetComponents()}}}
		release(ops, id)
		local rounded = math.floor(scale * 10000 + 0.5) / 10000
		return {ref = ref, adopted = {name = string.sub(asset.Name, 1, 100), className = asset.ClassName},
			removedScripts = {count = removed, classes = classes, names = names}, keptScripts = kept, anchored = anchored,
			scale = rounded, size = V.array({extents[1], extents[2], extents[3]}), grounded = grounded,
			mutation = {kind = "scene.place_asset", ref = ref, before = V.NULL,
				after = {descendants = count, removedScripts = removed, keptScripts = kept, scale = rounded}}}
	end)
end

-- Applies a generated MaterialVariant (under MaterialService) to bounded parts with a receipt.
function AssetPlacement.applyMaterial(ops: any, command: any, args: any, guard: () -> ()): any
	V.fields(args, {"refs", "material", "variant"}, "material arguments")
	local list = V.list(args.refs, L.materialTargets, "material targets")
	if #list == 0 then V.fail("INPUT", "Choose at least one part.") end
	local materialName = V.string(args.material, "material", 32)
	if not table.find(AssetPlacement.GENERATED_MATERIALS, materialName) then V.fail("PROPERTY", "Unsupported generated base material.") end
	local found, material = pcall(function(): any return (Enum.Material :: any)[materialName] end)
	if not found or material == nil then V.fail("PROPERTY", "This Studio build lacks the requested base material.") end
	local variantName = V.string(args.variant, "material variant", 100)
	if not string.match(variantName, "^[%w_]+$") then V.fail("INPUT", "Material variant names are [A-Za-z0-9_].") end
	local service = ops.registry.gameModel:GetService("MaterialService")
	local variant = service:FindFirstChild(variantName, true)
	if not variant or variant.ClassName ~= "MaterialVariant" then V.fail("MATERIAL", "The generated material variant was not found under MaterialService.") end
	if variant.BaseMaterial ~= material then V.fail("MATERIAL", "The generated variant's base material differs from the requested material.") end
	local parts: {any}, seen: {[any]: boolean} = {}, {}
	for _, raw in ipairs(list) do
		local part = ops.registry:resolve(raw)
		if not part:IsA("BasePart") then V.fail("CLASS", "Materials apply to BaseParts only.") end
		if seen[part] then V.fail("INPUT", "Material targets must be distinct.") end
		seen[part] = true
		table.insert(parts, part)
	end
	return ops:record(command, guard, function(progress: any): any
		guard()
		local items: any = V.array({})
		for _, part in ipairs(parts) do
			table.insert(items, {ref = ops.registry:ref(part), Material = part.Material.Name, MaterialVariant = part.MaterialVariant})
		end
		progress.touched = true
		for _, part in ipairs(parts) do
			part.Material = material
			part.MaterialVariant = variantName
			if part.Material ~= material or part.MaterialVariant ~= variantName then V.fail("VERIFY", "A part did not take the generated material.") end
		end
		local ref = items[1].ref
		progress.ref = ref
		return {ref = ref, applied = #parts, mutation = {kind = "scene.apply_material", ref = ref, before = {items = items},
			after = {material = materialName, variant = variantName, count = #parts}}}
	end)
end

local function samePivot(current: any, recorded: {number}): boolean
	local now = {current:GetComponents()}
	for index, value in ipairs(recorded) do if math.abs(now[index] - value) > 1e-3 then return false end end
	return true
end

function AssetPlacement.restore(ops: any, command: any, original: any, instance: any, guard: () -> ()): ()
	if original.kind == "scene.place_asset" then
		local owned = ops.registry.owned[instance]
		local placed = owned and owned.placed
		local function matches(): boolean
			return placed ~= nil and instance.Parent == owned.parent and #instance:GetDescendants() == placed.count and samePivot(instance.WorldPivot, placed.pivot)
		end
		if not matches() then V.fail("CONFLICT", "The placed asset changed, moved, or gained/lost instances; restoration refused.") end
		ops:record(command, guard, function(progress: any): any
			guard()
			ops.registry:resolve(original.ref)
			if not matches() then V.fail("CONFLICT", "The placed asset changed before restoration.") end
			progress.ref = original.ref
			progress.touched = true
			instance:Destroy()
			return {restored = true, ref = original.ref}
		end)
		return
	end
	local parts: {any} = {}
	for _, item in ipairs(original.before.items) do
		local part = ops.registry:resolve(item.ref)
		if part.Material.Name ~= original.after.material or part.MaterialVariant ~= original.after.variant then
			V.fail("CONFLICT", "A part's material changed after the generated material was applied; restoration refused.")
		end
		local ok, prior = pcall(function(): any return (Enum.Material :: any)[item.Material] end)
		if not ok or prior == nil then V.fail("RECEIPT", "The recorded prior material is unavailable.") end
		table.insert(parts, {part = part, material = prior, variant = item.MaterialVariant})
	end
	ops:record(command, guard, function(progress: any): any
		guard()
		progress.ref = original.ref
		progress.touched = true
		for _, entry in ipairs(parts) do
			entry.part.Material = entry.material
			entry.part.MaterialVariant = entry.variant
		end
		return {restored = true, ref = original.ref}
	end)
end

-- scene.build clone templates: script-free Model/BasePart instances inside the granted roots.
function AssetPlacement.buildTemplates(ops: any, raw: any): {any}
	local templates: {any} = {}
	for _, value in ipairs(V.list(raw, L.templates, "clone templates")) do
		local template = ops.registry:resolve(value)
		if not (template:IsA("Model") or template:IsA("BasePart")) then V.fail("CLASS", "Clone templates must be a Model or BasePart.") end
		local descendants = template:GetDescendants()
		if #descendants > L.templateDescendants then V.fail("BODY_LIMIT", "A clone template may hold at most " .. L.templateDescendants .. " instances.") end
		for _, item in ipairs(descendants) do
			if item:IsA("LuaSourceContainer") then V.fail("SCRIPT", "Clone templates must be script-free; adopt them with scripts stripped.") end
		end
		table.insert(templates, {instance = template, extra = #descendants})
	end
	return templates
end

function AssetPlacement.planClone(ops: any, item: any, name: string, into: number, templates: {any}): any
	V.fields(item, {"kind", "template", "name", "parent", "at", "yaw", "scale", "ground", "key"}, "clone item")
	local template = templates[V.integer(item.template, 1, math.max(1, #templates), "template index")]
	if not template then V.fail("INPUT", "Clone item names an unknown template.") end
	local at = triple(item.at, -100000, 100000, "clone position")
	if item.ground ~= nil and V.boolean(item.ground, "clone ground") then
		-- Read-only probe of existing terrain/parts; nothing from this build is parented yet.
		local hit = ops.registry:root("Workspace"):Raycast(Vector3.new(at[1], at[2] + 500, at[3]), Vector3.new(0, -1000, 0))
		if hit then at[2] = hit.Position.Y end
	end
	return {clone = template.instance, extra = template.extra, className = template.instance.ClassName, name = name, parent = into,
		at = at, yaw = V.number(item.yaw, -360, 360, "clone yaw"), scale = V.number(item.scale, 0.1, 20, "clone scale")}
end

function AssetPlacement.instantiate(entry: any): any
	local copy = entry.clone:Clone()
	if not copy then V.fail("VERIFY", "The clone template is not archivable.") end
	if entry.scale ~= 1 then
		if copy:IsA("Model") then copy:ScaleTo(copy:GetScale() * entry.scale)
		else copy.Size = Vector3.new(copy.Size.X * entry.scale, copy.Size.Y * entry.scale, copy.Size.Z * entry.scale) end
	end
	copy:PivotTo(CFrame.new(entry.at[1], entry.at[2], entry.at[3]) * CFrame.Angles(0, math.rad(entry.yaw), 0))
	return copy
end

return table.freeze(AssetPlacement)
