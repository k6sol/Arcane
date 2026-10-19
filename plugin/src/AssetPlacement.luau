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

-- Exact extents of the same oriented box after the requested world Y rotation.
function AssetPlacement.worldExtentsAtYaw(c: {number}, size: any, yaw: number): {number}
	local angle = math.rad(yaw)
	local cosine, sine = math.cos(angle), math.sin(angle)
	return AssetPlacement.worldExtents({c[1], c[2], c[3],
		cosine * c[4] + sine * c[10], cosine * c[5] + sine * c[11], cosine * c[6] + sine * c[12],
		c[7], c[8], c[9],
		-sine * c[4] + cosine * c[10], -sine * c[5] + cosine * c[11], -sine * c[6] + cosine * c[12]}, size)
end

local function boxOf(root: any, yaw: number): ({number}, {number}, {number})
	local cframe, size = root:GetBoundingBox()
	local components = {cframe:GetComponents()}
	return components, AssetPlacement.worldExtents(components, size), AssetPlacement.worldExtentsAtYaw(components, size, yaw)
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
		if chosen then
			-- A script dropped next to the asset (not inside it) would escape the strip below: refuse instead.
			for _, instance in ipairs(entry.additions) do
				if instance ~= chosen and instance.Parent ~= nil and instance:IsDescendantOf(workspace) and not ops.registry.owned[instance]
					and not instance:IsDescendantOf(chosen) and not chosen:IsDescendantOf(instance) then
					local scripted = instance:IsA("LuaSourceContainer")
					if not scripted then for _, item in ipairs(instance:GetDescendants()) do if item:IsA("LuaSourceContainer") then scripted = true; break end end end
					if scripted then V.fail("AMBIGUOUS", "Scripts appeared in Workspace next to the inserted asset; nothing was adopted.") end
				end
			end
			return chosen
		end
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
	-- "editable-<digest>" adopts this plugin's retained reconstruction (procedural/Blender
	-- meshes) as new MeshParts instead of waiting for a native insertion.
	local editable = string.match(id, "^editable%-([0-9a-f]+)$")
	local placed: (() -> ())? = nil
	local asset: any
	local watched = if editable then nil else ops.assetWatches and ops.assetWatches[id]
	-- A refused native insert stays in Workspace for the person to inspect, but never with its scripts or package links.
	local function scrub(): ()
		if allowScripts or not watched then return end
		for _, instance in ipairs(watched.additions) do
			if instance.Parent ~= nil and instance:IsDescendantOf(workspace) and not ops.registry.owned[instance] then
				local items = instance:GetDescendants()
				table.insert(items, instance)
				for _, item in ipairs(items) do
					if item.Parent ~= nil and (item:IsA("LuaSourceContainer") or item.ClassName == "PackageLink") then pcall(function() item:Destroy() end) end
				end
			end
		end
	end
	if editable then
		if type(ops.materializeReconstruction) ~= "function" then V.fail("WATCH", "This plugin cannot place reconstructed meshes.") end
		asset, placed = ops:materializeReconstruction(editable, guard)
	else
		local arrived, value = pcall(AssetPlacement.arrival, ops, id, expectName, workspace)
		if not arrived then scrub(); error(value, 0) end
		asset = value
	end
	local ok, result = pcall(AssetPlacement.adopt, ops, command, args, guard, asset, container, name, maxSize, position, yaw, ground, anchor, allowScripts, editable ~= nil, id)
	if not ok then
		-- A detached materialized model never reached the scene: release it, no receipt.
		if editable and asset.Parent == nil then pcall(function() asset:Destroy() end) end
		scrub()
		error(result, 0)
	end
	if placed then placed() end
	return result
end

function AssetPlacement.adopt(ops: any, command: any, args: any, guard: () -> (), asset: any, container: any, name: string, maxSize: {number}?,
	position: {number}, yaw: number, ground: boolean, anchor: boolean, allowScripts: boolean, detached: boolean, id: string): any
	local workspace = ops.registry:root("Workspace")
	local descendants = asset:GetDescendants()
	if #descendants + 1 > L.descendants then V.fail("BODY_LIMIT", "The inserted asset has more than " .. L.descendants .. " instances; nothing was adopted. Remove it or choose a lighter asset.") end
	local physical = asset:IsA("BasePart")
	for _, item in ipairs(descendants) do if item:IsA("BasePart") then physical = true; break end end
	if not physical then V.fail("ASSET", "The inserted asset has no 3D parts; nothing was adopted. Remove it from Workspace if unwanted.") end
	return ops:record(command, guard, function(progress: any): any
		guard()
		ops.registry:resolve(args.parent)
		if asset.Parent == nil and not detached then V.fail("ASSET", "The inserted asset disappeared before adoption.") end
		progress.touched = true
		-- Free models can carry hostile scripts: remove every script unless explicitly allowed.
		local removed: number, kept: number, classes: {[string]: number}, names: any = 0, 0, {}, V.array({})
		for _, item in ipairs(asset:GetDescendants()) do
			if item.Parent ~= nil and item.ClassName == "PackageLink" then
				-- An auto-updating package could bring scripts back after adoption.
				item:Destroy()
			elseif item.Parent ~= nil and item:IsA("LuaSourceContainer") then
				if allowScripts then
					kept += 1
					-- Kept scripts land disabled; turning one on is a separate, reviewed script.set_enabled.
					if item:IsA("BaseScript") then item.Disabled = true end
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
		local components, extents, placedExtents = boxOf(root, yaw)
		local scale = AssetPlacement.fitScale(placedExtents, maxSize)
		if scale ~= 1 then
			root:ScaleTo(root:GetScale() * scale)
			components, extents, placedExtents = boxOf(root, yaw)
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
			scale = rounded, size = V.array({placedExtents[1], placedExtents[2], placedExtents[3]}), grounded = grounded,
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
			if item:IsA("LuaSourceContainer") or item.ClassName == "PackageLink" then V.fail("SCRIPT", "Clone templates must be script-free; adopt them with scripts stripped.") end
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
	-- The template was checked when the build was planned; it may have changed since, so check the copy itself.
	for _, item in ipairs(copy:GetDescendants()) do
		if item:IsA("LuaSourceContainer") or item.ClassName == "PackageLink" then
			copy:Destroy()
			V.fail("SCRIPT", "Clone templates must be script-free; adopt them with scripts stripped.")
		end
	end
	if entry.scale ~= 1 then
		if copy:IsA("Model") then copy:ScaleTo(copy:GetScale() * entry.scale)
		else copy.Size = Vector3.new(copy.Size.X * entry.scale, copy.Size.Y * entry.scale, copy.Size.Z * entry.scale) end
	end
	copy:PivotTo(CFrame.new(entry.at[1], entry.at[2], entry.at[3]) * CFrame.Angles(0, math.rad(entry.yaw), 0))
	return copy
end

-- "Keep this mesh" (docs/build/MESH_KEEP.md). Uploads each retained EditableMesh of ONE placed procedural reconstruction to
-- the signed-in Studio user's own Roblox account through AssetUpload (AssetService.CreateAssetAsync), then swaps every
-- session MeshPart for a persistent MeshPart made from its new asset ID (AssetService.CreateMeshPartAsync) in one undo
-- recording. Only the host mesh-keep service can queue it, after the person confirmed the Arcane dialog; the host records
-- the intent durably before queueing, which is what recordIntent acknowledges. Nothing is retried. Asset IDs are always
-- returned, even when a later upload or the swap fails, so an upload is never lost from the receipt.
-- APIs (create.roblox.com, checked 2026-10-18): AssetService.CreateAssetAsync(object, Enum.AssetType, {CreatorId,
-- CreatorType, Name, Description}) -> (Enum.CreateAssetResult, assetId or error); AssetService.CreateMeshPartAsync(Content,
-- options) -> MeshPart; Content.fromAssetId(id), with Content.fromUri("rbxassetid://" .. id) as the fallback.
-- keepSupported probes every one of them; when any is missing the capability is not advertised (fails closed).
AssetPlacement.KEEP_LIMITS = table.freeze({meshes = 16, nameCodepoints = 50})
local KL = AssetPlacement.KEEP_LIMITS

function AssetPlacement.keepSupported(gameModel: any): boolean
	local ok, supported = pcall(function(): boolean
		local service = gameModel:GetService("AssetService")
		local enums: any, content: any = Enum, Content
		return type(service.CreateAssetAsync) == "function" and type(service.CreateMeshPartAsync) == "function"
			and typeof(enums.AssetType.Mesh) == "EnumItem" and typeof(enums.AssetCreatorType.User) == "EnumItem"
			and typeof(enums.CreateAssetResult.Success) == "EnumItem"
			and (type(content.fromAssetId) == "function" or type(content.fromUri) == "function")
	end)
	return ok and supported == true
end

-- Production engine bindings; the standalone tests inject doubles with the same shape.
function AssetPlacement.keepEngine(ops: any, assetUpload: any): any
	local content: any = Content
	return {service = ops.gameModel:GetService("AssetService"), AssetUpload = assetUpload,
		enums = {AssetType = Enum.AssetType, AssetCreatorType = Enum.AssetCreatorType, CreateAssetResult = Enum.CreateAssetResult},
		content = function(id: number): any
			if type(content.fromAssetId) == "function" then return content.fromAssetId(id) end
			return content.fromUri("rbxassetid://" .. string.format("%d", id))
		end,
		userId = function(): number return ops.gameModel:GetService("StudioService"):GetUserId() end}
end

local function clipName(name: string, suffix: string): string
	local room = KL.nameCodepoints - utf8.len(suffix)
	if (utf8.len(name) or 0) > room then name = string.sub(name, 1, (utf8.offset(name, room + 1) or (#name + 1)) - 1) end
	return name .. suffix
end

local SWAP_FIELDS = table.freeze({"Name", "Size", "CFrame", "Anchored", "CanCollide", "CanQuery", "CanTouch", "CastShadow", "Transparency", "Material", "Color", "DoubleSided"})

function AssetPlacement.keep(ops: any, owner: any, digest: string, args: any, guard: () -> (), engine: any): any
	V.fields(args, {"source", "attemptId", "name", "description", "creatorId", "continuity", "finish", "assetIds"}, "keep-mesh arguments")
	local attemptId = V.string(args.attemptId, "attempt ID", 36)
	if not string.match(attemptId, "^%x+%-%x+%-%x+%-%x+%-%x+$") then V.fail("INPUT", "Expected a host upload attempt ID.") end
	local name = V.string(args.name, "asset name", 200)
	if (utf8.len(name) or 0) > KL.nameCodepoints or not string.find(name, "%S") then V.fail("INPUT", "Invalid asset name.") end
	local description = V.string(args.description, "asset description", 4096, true)
	local creatorId = V.integer(args.creatorId, 1, 9007199254740991, "creator ID")
	local continuity = V.fields(args.continuity, {"clientLifetimeId", "pluginArtifactHash", "playEpoch"}, "keep-mesh continuity")
	local finish = V.boolean(args.finish, "finish")
	local reuse: {number}? = nil
	if finish then
		reuse = {}
		for index, value in ipairs(V.list(args.assetIds, KL.meshes, "asset IDs")) do (reuse :: any)[index] = V.integer(value, 1, 9007199254740991, "asset ID") end
	elseif args.assetIds ~= nil then V.fail("INPUT", "A new keep never carries asset IDs.") end
	local meshes = owner.meshes
	if #meshes == 0 or #meshes > KL.meshes then V.fail("CAPACITY", "Keep this mesh supports 1.." .. KL.meshes .. " meshes per model; nothing was uploaded.") end
	if reuse and #reuse ~= #meshes then V.fail("SCOPE", "The recorded asset IDs do not match this model's meshes.") end
	local model = owner.placed
	if model == nil or model.Parent == nil then V.fail("STATE", "The placed model was removed or undone; nothing was uploaded. Place it again first.") end
	for _, resource in ipairs(meshes) do
		if resource.disposed or resource.mesh == nil then V.fail("STATE", "The session meshes were released; nothing was uploaded.") end
	end
	-- The account the person confirmed in Arcane must still be the signed-in Studio user, right before any upload.
	local function signedIn(): boolean
		local ok, id = pcall(engine.userId)
		return ok and id == creatorId
	end
	if not signedIn() then V.fail("ACCOUNT", "The Roblox account signed in to Studio changed since you confirmed. Nothing was uploaded.") end
	guard()
	local entries: {any} = {}
	local started = 0
	if reuse then
		for index, resource in ipairs(meshes) do
			local object = resource.object
			entries[index] = {index = index, name = if type(object) == "table" and type(object.name) == "string" then string.sub(object.name, 1, 100) else "Mesh" .. index,
				assetId = reuse[index], upload = "reused", reason = V.NULL, swapped = false}
		end
	else
		local lastResult: string? = nil
		-- Pass-through that only remembers the engine's own CreateAssetResult name for the receipt (quota, moderation...).
		local recorder = {CreateAssetAsync = function(_self: any, resource: any, assetType: any, parameters: any): (any, any)
			local result, idOrError = engine.service:CreateAssetAsync(resource, assetType, parameters)
			lastResult = if typeof(result) == "EnumItem" and type(result.Name) == "string" and string.match(result.Name, "^%a+$") then string.sub(result.Name, 1, 40) else nil
			return result, idOrError
		end}
		local function current(resource: any): boolean
			for _, item in ipairs(meshes) do if item.mesh == resource and not item.disposed then return true end end
			return false
		end
		local uploader = engine.AssetUpload.new(recorder, engine.enums, {
			assertAdmission = function(_ticket: any, resource: any): ()
				if owner.retired or not current(resource) or not signedIn() then error("admission", 0) end
			end,
			liveGuard = function(_ticket: any, _resource: any): () guard() end,
			-- The host wrote this attempt's intent receipt before the command existed; the command is that acknowledgement.
			recordIntent = function(ticket: any): any return table.freeze({phase = "intent", ticket = ticket}) end,
			recordResult = function(ticket: any, observation: any): any
				return table.freeze({phase = "result", ticket = ticket, assetId = observation.assetId})
			end,
		})
		local identity = {sessionId = ops.registry.sessionId, clientLifetimeId = V.string(continuity.clientLifetimeId, "client lifetime", 128),
			pluginArtifactHash = V.string(continuity.pluginArtifactHash, "plugin artifact hash", 64), playEpoch = V.integer(continuity.playEpoch, 0, 9007199254740991, "play epoch"),
			placeId = ops.gameModel.PlaceId, universeId = ops.gameModel.GameId}
		local stop: string? = nil
		for index, resource in ipairs(meshes) do
			local object = resource.object
			local label = if type(object) == "table" and type(object.name) == "string" then string.sub(object.name, 1, 100) else "Mesh" .. index
			local entry: any = {index = index, name = label, assetId = V.NULL, upload = "skipped", reason = V.NULL, swapped = false}
			entries[index] = entry
			if stop then entry.reason = stop; continue end
			local sha = if type(object) == "table" then object.meshExportSha256 else nil
			if type(sha) ~= "string" or not string.match(sha, "^[0-9a-f]+$") or #sha ~= 64 then entry.upload, entry.reason, stop = "failed", "SOURCE_METADATA", "STOPPED"; continue end
			lastResult = nil
			local ticket = table.freeze({attemptId = attemptId .. "." .. index, assetType = "Mesh",
				creator = table.freeze({kind = "user", id = creatorId}),
				source = table.freeze({jobId = "transfer-" .. string.sub(digest, 1, 32), resourceId = "mesh-" .. index, sha256 = sha}),
				uploader = table.freeze({status = "available", id = creatorId, provenance = "StudioService:GetUserId"}),
				continuity = table.freeze(table.clone(identity)),
				name = if #meshes == 1 then name else clipName(name, " " .. index), description = description})
			local called, outcome = pcall(uploader.upload, uploader, ticket, resource.mesh)
			if not called then
				entry.upload, entry.reason, stop = "failed", if type(outcome) == "table" and type(outcome.code) == "string" and string.match(outcome.code, "^[%u_]+$") then outcome.code else "INPUT", "STOPPED"
				continue
			end
			if outcome.uploadStarted then started += 1 end
			if outcome.state == "succeeded" then entry.assetId, entry.upload = outcome.assetId, "succeeded"
			elseif outcome.assetId ~= nil then
				-- Roblox created the asset but continuing scope was lost: keep the ID, stop further uploads.
				entry.assetId, entry.upload, entry.reason, stop = outcome.assetId, "succeeded", outcome.reason, "STOPPED"
			elseif outcome.state == "failed" then
				entry.upload, entry.reason, stop = "failed", "ENGINE_REJECTED" .. (if lastResult then ":" .. lastResult else ""), "STOPPED"
			else
				entry.upload, entry.reason, stop = if outcome.uploadStarted then "reconciliation" else "failed", outcome.reason or "UNKNOWN", "STOPPED"
			end
		end
	end
	-- Swap only when every mesh has an asset ID: a model is never left half persistent by a partial upload.
	local complete = true
	for _, entry in ipairs(entries) do if entry.assetId == V.NULL then complete = false end end
	local swapped = 0
	if complete then
		local fresh: {any}, copies: {any} = {}, {}
		pcall(function()
			guard()
			if model.Parent == nil then V.fail("STATE", "The placed model was removed.") end
			for index, resource in ipairs(meshes) do
				local old, id = resource.part, entries[index].assetId
				if resource.keptAssetId == id and old ~= nil and old.Parent ~= nil then fresh[index] = false -- already persistent (earlier finish)
				else
					if old == nil or old.Parent == nil or not old:IsDescendantOf(model) then V.fail("STATE", "A session part was removed from the model.") end
					local part = engine.service:CreateMeshPartAsync(engine.content(id), {CollisionFidelity = old.CollisionFidelity, RenderFidelity = old.RenderFidelity})
					if part ~= nil then fresh[index] = part end -- Own late allocations before the guard.
					guard()
					if part == nil or not part:IsA("MeshPart") then V.fail("ENGINE", "CreateMeshPartAsync did not return a MeshPart.") end
					fresh[index] = part
				end
			end
			local recording = ops.history:TryBeginRecording("Arcane.keep." .. attemptId, "Arcane keep mesh")
			if not recording then V.fail("HISTORY", "Cannot begin an undo recording.") end
			local done = pcall(function()
				for index, resource in ipairs(meshes) do
					local part = fresh[index]
					if part then
						local old = resource.part
						for _, field in ipairs(SWAP_FIELDS) do (part :: any)[field] = old[field] end
						local appearance = resource.appearance
						if appearance ~= nil and appearance.Parent == old then
							local copy = appearance:Clone()
							if copy == nil then V.fail("ENGINE", "SurfaceAppearance could not be copied to the kept mesh.") end
							copies[index] = copy
							copy.Parent = part
						end
						part.Parent = old.Parent
						old.Parent = nil
						resource.part, resource.keptAssetId = part, entries[index].assetId
						if copies[index] then resource.appearance = copies[index] end
					end
					entries[index].swapped = true
				end
			end)
			pcall(function() ops.history:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end)
			if not done then V.fail("ENGINE", "The part swap stopped part-way.") end
		end)
		-- Preserve uploaded IDs while retiring only unswapped detached replacements.
		for index, part in pairs(fresh) do
			if part and meshes[index].part ~= part and part.Parent == nil then
				if not pcall(function() part:Destroy() end) then ops.assetCleanupFailed = true end
			end
		end
		for index, copy in pairs(copies) do
			if meshes[index].appearance ~= copy and copy.Parent == nil then
				if not pcall(function() copy:Destroy() end) then ops.assetCleanupFailed = true end
			end
		end
		for _, entry in ipairs(entries) do if entry.swapped then swapped += 1 end end
		-- The placement receipt stays restorable: same model, same instance count after a 1:1 swap.
		local owned = if swapped == #entries then ops.registry.owned[model] else nil
		if owned and owned.placed then owned.placed.count = #model:GetDescendants() end
	end
	local ids = 0
	for _, entry in ipairs(entries) do if entry.assetId ~= V.NULL then ids += 1 end end
	local state = if ids == 0 then "failed" elseif ids < #entries then "partial" elseif swapped == #entries then "kept" else "uploaded"
	local refOk, ref = pcall(function(): any return ops.registry:ref(model) end)
	return {state = state, meshes = V.array(entries), uploadsStarted = started, swapped = swapped,
		persistence = if state == "kept" then "saved-asset" else "studio-session-only", creatorId = creatorId, ref = if refOk then ref else V.NULL}
end

return table.freeze(AssetPlacement)
