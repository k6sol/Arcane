--!strict
local V = require(script.Parent.Validation)
local LegacyProperties = require(script.Parent.Properties)
local P = V.geometryProperties(LegacyProperties)
local Registry = require(script.Parent.Registry)
local AssetTransfer = require(script.Parent.AssetTransfer)
local AssetMaterials = require(script.Parent.AssetMaterials)
local AssetPlacement = require(script.Parent.AssetPlacement)
local TerrainGen = require(script.Parent.TerrainGen)
local AssetUpload = require(script.Parent.AssetUpload)
local Operations = {}
Operations.__index = Operations
type Operations = any
-- Engine objects never enter command data or public fields. This private owner
-- retains exact meshes until retirement; receiver ownership ends at reconstruct.
local assetOwners: {[any]: any} = setmetatable({}, {__mode = "k"})

local function cleanupFailure(): never
	error(table.freeze({code = "CLEANUP", message = "Owned editable resources may remain; reconnect cannot establish cleanup.",
		unsafe = true, recovery = table.freeze({partial = true, imported = false, engineVerification = "pending"})}), 0)
end

function Operations.new(pair: any, gameModel: any, http: any, assetProgress: (() -> ())?): Operations
	return setmetatable({registry = Registry.new(pair.sessionId, pair.allowedRoots, gameModel, http),
		gameModel = gameModel, assetTransfers = {}, assetProgress = assetProgress,
		http = http, editor = gameModel:GetService("ScriptEditorService"),
		history = gameModel:GetService("ChangeHistoryService"), selection = gameModel:GetService("Selection"),
		collection = gameModel:GetService("CollectionService"), mutations = {}, restored = {},
		sliceSeconds = Operations.SLICE_SECONDS, slices = 0}, Operations)
end

-- Cooperative slicing for long CPU/engine loops (detached scene.build construction, terrain
-- field and chunk preparation). Every SLICE_CHECK steps the clock is read; once SLICE_SECONDS of
-- work has run since the last resume (a step may weigh more, e.g. a terrain row), yield one
-- frame so Studio keeps drawing, then re-run the command guard (session, lease expiry, Edit mode) before doing anything else. Small commands
-- never yield. The guard after a yield is the only way work resumes, so a lost lease, a
-- disconnect or entering Play stops the command at the next slice boundary.
Operations.SLICE_SECONDS = 0.02
Operations.SLICE_CHECK = 32
function Operations:slicer(guard: () -> ()): (number?) -> ()
	local started, steps = os.clock(), 0
	-- weight 0 forces a yield now (a terrain chunk boundary) and restarts the budget.
	return function(weight: number?): ()
		if weight ~= 0 then
			steps += math.max(1, weight or 1)
			if steps < Operations.SLICE_CHECK then return end
			steps = 0
			if os.clock() - started < self.sliceSeconds then return end
		end
		task.wait()
		self.slices += 1
		guard()
		started = os.clock()
	end
end

-- Internal intake is also reached by the fixed host-owned asset.stage_packet
-- queue entry. Generic agent enqueue cannot mint that host admission.
-- No upload, parenting, undo record or engine baseline is created here.
function Operations:receiveAssetPacket(expected: any, packet: string, guard: () -> ()): any
	guard()
	V.fields(expected, {"digest", "payloadDigest", "manifestDigest"}, "asset transfer identity")
	local id = V.string(expected.digest, "transfer digest", 64)
	if #id ~= 64 or not string.match(id, "^[a-f0-9]+$") then V.fail("INPUT", "Expected transfer SHA-256.") end
	local owned = self.assetTransfers[id]
	if not owned then
		local count = 0
		for _ in pairs(self.assetTransfers) do count += 1 end
		if count >= 2 then V.fail("BUSY", "At most two internal asset transfers may be staged.") end
		owned = {guard = guard, expected = V.immutable(expected)}
		owned.receiver = AssetTransfer.new(owned.expected, function(json: string): any
			return self.http:JSONDecode(json)
		end, function(): () owned.guard() end, function(): ()
			task.wait()
			if self.assetProgress then self.assetProgress() end
		end)
		self.assetTransfers[id] = owned
	elseif owned.expected.payloadDigest ~= expected.payloadDigest or owned.expected.manifestDigest ~= expected.manifestDigest then
		V.fail("SCOPE", "Transfer identity changed.")
	end
	owned.guard = guard
	local ok, result = pcall(function(): any
		local output = owned.receiver:accept(packet)
		guard()
		return output
	end)
	if not ok then
		local cleaned = pcall(function() owned.receiver:cancel() end)
		self.assetTransfers[id] = nil
		if not cleaned then V.fail("CLEANUP", "Retired asset staging resources may remain.") end
		error(result, 0)
	end
	return result
end

function Operations:cancelAssetTransfers(): ()
	local failures = 0
	for id, owned in pairs(self.assetTransfers) do
		local ok = pcall(function() owned.receiver:cancel() end)
		self.assetTransfers[id] = nil
		if not ok then failures += 1 end
	end
	local owners = assetOwners[self]
	if owners then
		for id, owner in pairs(owners.resources) do
			owner.retired = true
			-- Templates and image objects stay alive while placed/scattered surfaces reference them.
			-- Detach each cache entry before engine callbacks can re-enter cancellation.
			for key, material in pairs(owner.materials or {}) do
				owner.materials[key] = nil
				for _, resource in ipairs({material.surfaceAppearance, material.editableImages.MetalnessMap, material.editableImages.RoughnessMap}) do
					if not pcall(function() resource:Destroy() end) then failures += 1 end
				end
			end
			for _, resource in ipairs(owner.meshes) do
				if not resource.disposed then
					resource.disposed = true -- Detach BEFORE a reentrant engine callback.
					local mesh = resource.mesh
					resource.mesh = nil
					if not pcall(function() mesh:Destroy() end) then failures += 1 end
				end
			end
			if owner.finished then owners.resources[id] = nil end
		end
	end
	if failures > 0 then self.assetCleanupFailed = true end
	if self.assetCleanupFailed then cleanupFailure() end
end

function Operations:retireAssetContinuity(proof: any): ()
	local retired = false
	local function check(owned: any): ()
		local c = owned.continuity
		if c and (type(proof) ~= "table" or proof.sessionId ~= owned.target.sessionId or proof.mode ~= "Edit"
			or proof.placeId ~= owned.target.placeId or proof.universeId ~= owned.target.universeId
			or proof.connected ~= true or proof.continuitySupported ~= true or proof.clientLifetimeId ~= c.clientLifetimeId
			or proof.pluginArtifactHash ~= c.pluginArtifactHash or proof.playEpoch ~= c.playEpoch) then retired = true end
	end
	for _, owned in pairs(self.assetTransfers) do check(owned) end
	-- Reconstructed meshes no longer hold a staging slot but keep their epoch.
	local owners = assetOwners[self]
	if owners then for _, owner in pairs(owners.resources) do if not owner.retired then check(owner) end end end
	if retired then self:cancelAssetTransfers() end
end

function Operations:assetTargetGuard(target: any, guard: () -> ()): () -> ()
	return function(): ()
		guard()
		if self.assetCleanupFailed then cleanupFailure() end
		local context = self:importContext({})
		local creator: any
		if context.creator.status == "available" then creator = {kind = context.creator.kind, id = tostring(context.creator.id)}
		elseif context.placeId == 0 and context.universeId == 0 and context.creator.id == 0 and context.studioUser.status == "available" then
			creator = {kind = "user", id = tostring(context.studioUser.id)}
		else V.fail("SCOPE", "Observed import creator is unavailable.") end
		local observed = {sessionId = context.sessionId, placeId = context.placeId, universeId = context.universeId,
			root = "Workspace", parentRef = context.parentRef.instanceId, creator = creator}
		if context.mode ~= "Edit" or not V.equal(observed, target) then V.fail("SCOPE", "Import target, creator or Workspace changed.") end
		guard()
	end
end

function Operations:stageAssetPacket(args: any, guard: () -> ()): any
	V.fields(args, {"expected", "packet", "target", "continuity"}, "asset staging arguments")
	local target = V.fields(args.target, {"sessionId", "placeId", "universeId", "root", "parentRef", "creator"}, "asset staging target")
	local current = self:assetTargetGuard(target, guard)
	current()
	local packet = V.string(args.packet, "asset packet", V.ARGUMENT_BYTES)
	local identity = V.fields(args.expected, {"digest", "payloadDigest", "manifestDigest"}, "asset transfer identity")
	local owned = self.assetTransfers[identity.digest]
	if owned then
		if not owned.target or not V.equal(owned.target, target) or not V.equal(owned.continuity, args.continuity) then V.fail("SCOPE", "Staging target or lifetime changed.") end
	else
		local prior = assetOwners[self]
		if prior and prior.resources[identity.digest] then V.fail("STATE", "Transfer was already reconstructed; inspect its original receipt.") end
		local first = V.object(self.http:JSONDecode(packet), "first asset packet")
		if first.kind ~= "begin" or first.ordinal ~= 0 or not V.equal(first.target, target) then V.fail("SCOPE", "Initial packet does not name the observed target.") end
	end
	local result = self:receiveAssetPacket(identity, packet, current)
	self.assetTransfers[identity.digest].target = V.immutable(target)
	self.assetTransfers[identity.digest].continuity = V.immutable(args.continuity)
	return {transferDigest = identity.digest, packetCount = result.packetCount, byteLength = result.byteLength,
		state = result.state, engineVerification = "pending"}
end

-- Fixed host-owned queue operation. It resolves the actual retained receiver;
-- neither the digest, source summary nor JSON runId grants engine ownership.
function Operations:reconstructAsset(args: any, guard: () -> ()): any
	V.fields(args, {"runId", "expected", "packetCount", "byteLength", "objects", "target", "continuity"}, "asset reconstruction")
	local runId = V.string(args.runId, "original stage run", 36)
	local identity = V.fields(args.expected, {"digest", "payloadDigest", "manifestDigest"}, "asset transfer identity")
	local owned = self.assetTransfers[identity.digest]
	local current = self:assetTargetGuard(args.target, guard)
	current()
	local prior = assetOwners[self]
	if not owned and prior and prior.resources[identity.digest] then V.fail("STATE", "Reconstruction was already consumed; inspect its original receipt.") end
	if not owned or not V.equal(owned.expected, identity) or not V.equal(owned.target, args.target)
		or not V.equal(owned.continuity, args.continuity) then V.fail("SCOPE", "Original staged buffers are absent or changed.") end
	local owners = assetOwners[self]
	if not owners then owners = {resources = {}, consumed = {}, count = 0}; assetOwners[self] = owners end
	if owners.consumed[runId] or owners.resources[identity.digest] then V.fail("STATE", "Reconstruction was already consumed; inspect its original receipt.") end
	if owners.count >= 64 then V.fail("CAPACITY", "Reconstruction history is full; no consumed attempt is evicted.") end
	owned.guard = current
	local status = owned.receiver:status()
	if status.state ~= "sealed" or status.packetCount ~= args.packetCount or status.byteLength ~= args.byteLength then V.fail("STATE", "Original sealed packet accounting changed.") end
	local plan = owned.receiver:reconstructionPlan()
	local expectedObjects = V.list(args.objects, 128, "reconstructed sources")
	if #expectedObjects ~= #plan then V.fail("SCOPE", "Reconstruction source count differs from the sealed transfer.") end
	for index, source in ipairs(plan) do
		if not V.equal(source, expectedObjects[index]) then V.fail("SCOPE", "Reconstruction sources differ from the sealed transfer.") end
	end
	current()
	owners.consumed[runId] = true; owners.count += 1 -- BEFORE resolving/allocating an engine service.
	local owner: any = {runId = runId, meshes = {}, retired = false, finished = false, materials = {}, target = owned.target, continuity = owned.continuity, service = nil}
	owners.resources[identity.digest] = owner
	owned.guard = function(): ()
		current()
		if owner.retired or self.assetTransfers[identity.digest] ~= owned then V.fail("SCOPE", "Reconstruction owner was retired.") end
	end
	local ok, output = pcall(function(): any
		if self.assetProgress then self.assetProgress() end -- Fresh authenticated progress BEFORE allocation.
		local service = self.gameModel:GetService("AssetService")
		owned.guard()
		local entries = owned.receiver:reconstruct(service)
		-- No guard/yield between receiving ownership and registering EVERY mesh.
		for _, entry in ipairs(entries) do owner.meshes[#owner.meshes + 1] = {mesh = entry.mesh.editableMesh, disposed = false, object = entry.object, material = entry.material} end
		owner.service = service -- Retained for materialization; never re-acquired elsewhere.
		owned.guard()
		local summary = {}
		for _, entry in ipairs(entries) do
			summary[#summary + 1] = {sourceObjectId = entry.object.sourceObjectId, meshExportSha256 = entry.object.meshExportSha256,
				vertexCount = entry.mesh.vertexCount, triangleCount = entry.mesh.triangleCount}
		end
		if owner.retired or not V.equal(summary, plan) then V.fail("SCOPE", "Reconstructed ownership or source accounting changed.") end
		owned.guard()
		owner.finished = true
		local receipt = {runId = runId, transferDigest = identity.digest, state = "reconstructed", objects = V.array(summary), imported = false, engineVerification = "pending"}
		if #V.encode(receipt, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Reconstruction receipt exceeds its bound.") end
		local frozen = V.immutable(receipt)
		owned.guard()
		return frozen
	end)
	if not ok then
		owner.finished = true
		if type(output) == "table" and (output.code == "CLEANUP" or output.cleanupFailed == true) then self.assetCleanupFailed = true end
		self:cancelAssetTransfers()
		error(output, 0)
	end
	-- The emptied receiver no longer owns buffers; release its staging slot so
	-- only in-progress transfers count toward the two-transfer bound.
	if self.assetTransfers[identity.digest] == owned then self.assetTransfers[identity.digest] = nil end
	return output
end

-- Materialization of ONE retained reconstruction into a detached Model of MeshParts.
-- Reached only through scene.place_asset with an "editable-<transfer digest>" source,
-- so the result is adopted by AssetPlacement (fit, ground, pivot, anchor, parent) under
-- one undo recording and receipt. No upload, publication or asset ID is created: the
-- MeshParts reference the in-memory EditableMeshes owned by this plugin lifetime.
-- API (create.roblox.com AssetService.CreateMeshPartAsync, checked 2026-10-18): meshContent = Content.fromObject(editableMesh).
local STUDS_PER_METER = 1 / 0.28
local function srgb(linear: number): number
	local c = math.clamp(if linear == linear then linear else 0, 0, 1)
	return if c <= 0.0031308 then c * 12.92 else 1.055 * c ^ (1 / 2.4) - 0.055
end
function Operations:materializeReconstruction(digest: string, guard: () -> ()): (any, () -> ())
	if #digest ~= 64 or not string.match(digest, "^[0-9a-f]+$") then V.fail("WATCH", "Expected an editable-<transfer digest> source.") end
	local owners = assetOwners[self]
	local owner = owners and owners.resources[digest]
	if not owner or not owner.finished or owner.retired or owner.service == nil or #owner.meshes == 0 then
		V.fail("WATCH", "No reconstructed meshes are retained for this transfer in this plugin session; run assets_reconstruct_studio_import first (same Studio session).")
	end
	if owner.materializing or (owner.placed and owner.placed.Parent ~= nil) then
		V.fail("STATE", "This reconstruction is already placed; clone it with scene_build templates or restore its receipt first.")
	end
	local targetCurrent = self:assetTargetGuard(owner.target, guard)
	local function current(): ()
		targetCurrent()
		if owner.retired then V.fail("SCOPE", "Materialization owner was retired.") end
	end
	current()
	-- Validate every material before allocating parts or image resources.
	for _, resource in ipairs(owner.meshes) do
		if resource.object.role ~= "collision" then
			local plan = AssetMaterials.plan(resource.material)
			if not plan.supported then V.fail("UNSUPPORTED_MATERIAL", "Nonzero emission cannot be mapped faithfully.") end
		end
	end
	current()
	owner.materializing = true
	local model: any = nil
	local parts, appearances = {}, {}
	local ok, err = pcall(function()
		model = Instance.new("Model")
		for index, resource in ipairs(owner.meshes) do
			current()
			if owner.retired or resource.disposed or resource.mesh == nil then V.fail("STATE", "Retained meshes were released before placement.") end
			local object = resource.object
			if type(object) ~= "table" or type(object.worldBounds) ~= "table" then V.fail("STATE", "Retained mesh metadata is incomplete.") end
			local collision = object.role == "collision"
			local part = owner.service:CreateMeshPartAsync(Content.fromObject(resource.mesh), {
				CollisionFidelity = if collision then Enum.CollisionFidelity.Hull else Enum.CollisionFidelity.Box,
				RenderFidelity = Enum.RenderFidelity.Precise})
			-- Own the returned part before a post-yield guard can refuse it.
			if part ~= nil then parts[index] = part end
			current()
			if part == nil or not part:IsA("MeshPart") then V.fail("ENGINE", "CreateMeshPartAsync did not return a MeshPart.") end
			part.Parent = model
			-- Keep this mesh swaps exactly these session parts (AssetPlacement.keep).
			local low, high = object.worldBounds.min, object.worldBounds.max
			local size = {}
			for axis = 1, 3 do size[axis] = math.max(0.05, (high[axis] - low[axis]) * STUDS_PER_METER) end
			part.Size = Vector3.new(size[1], size[2], size[3])
			part.CFrame = CFrame.new((low[1] + high[1]) / 2 * STUDS_PER_METER, (low[2] + high[2]) / 2 * STUDS_PER_METER, (low[3] + high[3]) / 2 * STUDS_PER_METER)
			local name = if type(object.name) == "string" then string.sub(object.name, 1, 100) else "Part" .. index
			part.Name = name
			if collision then
				part.Transparency, part.CanCollide, part.CastShadow, part.CanQuery = 1, true, false, false
			else
				part.CanCollide = false
				local key = if resource.material == nil then "default" else resource.material.sha256
				local material = owner.materials[key]
				if material == nil then
					material = AssetMaterials.create(resource.material, {
						createEditableImage = function(options: any): any return owner.service:CreateEditableImage(options) end,
						createSurfaceAppearanceAsync = function(maps: any): any return owner.service:CreateSurfaceAppearanceAsync(maps) end,
						contentFromObject = function(image: any): any return Content.fromObject(image) end,
						vector2 = function(x: number, y: number): any return Vector2.new(x, y) end,
						colorFromLinear = function(r: number, g: number, b: number): any return Color3.new(srgb(r), srgb(g), srgb(b)) end,
					}, current)
					owner.materials[key] = material -- Ownership before any further guard or engine call.
				end
				current()
				-- Neutral substrate: preserve authored PBR instead of guessing from filenames.
				part.Material = Enum.Material.SmoothPlastic
				part.Color, part.Transparency, part.DoubleSided = material.meshPartProperties.Color, material.meshPartProperties.Transparency, material.meshPartProperties.DoubleSided
				local appearance = material.surfaceAppearance:Clone()
				if appearance == nil then V.fail("ENGINE", "SurfaceAppearance could not be cloned.") end
				appearances[index] = appearance
				current()
				if not appearance:IsA("SurfaceAppearance") or appearance.Parent ~= nil then V.fail("ENGINE", "Expected a detached SurfaceAppearance clone.") end
				appearance.Parent = part
				current()
			end
		end
		current()
	end)
	owner.materializing = false
	if not ok then
		local failed = type(err) == "table" and err.field == "cleanup"
		if model ~= nil and not pcall(function() model:Destroy() end) then failed = true end
		for _, appearance in pairs(appearances) do if not pcall(function() appearance:Destroy() end) then failed = true end end
		for _, part in pairs(parts) do if not pcall(function() part:Destroy() end) then failed = true end end
		if failed then self.assetCleanupFailed = true; cleanupFailure() end
		error(err, 0)
	end
	-- No yielding callbacks between final validation and the part ownership update.
	for index, resource in ipairs(owner.meshes) do resource.part, resource.appearance, resource.keptAssetId = parts[index], appearances[index], nil end
	model.Name = "ArcaneProcedural"
	-- AssetPlacement calls this once the adopted Model is parented.
	return model, function() owner.placed = model end
end

-- asset.keep_mesh: host-only (the daemon admits it solely after the person's trusted-dialog consent). Resolves the
-- retained owner of ONE placed reconstruction in THIS plugin session and hands it to AssetPlacement.keep.
-- No final guard after uploads: a lease or scope change must never discard the asset IDs Roblox already returned.
function Operations:keepReconstruction(args: any, guard: () -> ()): any
	V.fields(args, {"source", "attemptId", "name", "description", "creatorId", "continuity", "finish", "assetIds"}, "keep-mesh arguments")
	local digest = string.match(V.string(args.source, "keep source", 80), "^editable%-([0-9a-f]+)$")
	if not digest or #digest ~= 64 then V.fail("INPUT", "Expected an editable-<transfer digest> source.") end
	local owners = assetOwners[self]
	local owner = owners and owners.resources[digest]
	if not owner or not owner.finished or owner.retired or owner.service == nil or #owner.meshes == 0 then
		V.fail("STATE", "This mesh is no longer held by this Studio session (reconnected, Play or reopened). Nothing was uploaded; generate and place it again.")
	end
	if owner.keeping then V.fail("STATE", "This mesh is already being kept.") end
	-- keepEngineDouble is set only by the standalone VM tests; production always probes and binds the real engine.
	local double = self.keepEngineDouble
	if not double and not AssetPlacement.keepSupported(self.gameModel) then V.fail("CAPABILITY", "This Studio does not let plugins upload meshes. Nothing was uploaded.") end
	owner.keeping = true
	local ok, result = pcall(AssetPlacement.keep, self, owner, digest, args, guard, double or AssetPlacement.keepEngine(self, AssetUpload))
	owner.keeping = false
	if not ok then error(result, 0) end
	if #V.encode(result, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Keep receipt exceeds its bound.") end
	return V.immutable(result)
end
function Operations.meshKeepSupported(gameModel: any): boolean return AssetPlacement.keepSupported(gameModel) end

function Operations:source(instance: any): string
	if not instance:IsA("LuaSourceContainer") then V.fail("CLASS", "Reference is not a script.") end
	return V.string(self.editor:GetEditorSource(instance), "script source", V.SOURCE_BYTES, true)
end

function Operations:record(command: any, guard: () -> (), action: (any) -> any): any
	guard()
	local recording = self.history:TryBeginRecording("Arcane." .. command.id, "Arcane " .. command.method)
	if not recording then V.fail("HISTORY", "Cannot begin an undo recording; no change was attempted.") end
	local progress: any = {touched = false}
	local ok, result = pcall(function()
		guard()
		local output = action(progress)
		guard()
		if #V.encode(output, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Mutation receipt exceeds 512 KiB.") end
		return output
	end)
	if ok then
		local committed = pcall(function() self.history:FinishRecording(recording, Enum.FinishRecordingOperation.Commit) end)
		if committed then return result end
		progress.touched = true
		result = {code = "HISTORY", message = "Change applied but its undo recording could not be committed."}
	else
		-- Cancel only an untouched recording. A yielding editor write or partial
		-- property assignment is ambiguous; a broad undo could erase a later edit.
		local finish = if progress.touched then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		local finished = pcall(function() self.history:FinishRecording(recording, finish) end)
		if not finished then progress.touched = true end
	end
	if progress.touched then
		local recovery: any = {partial = true, needsReconciliation = true, rollbackVerified = false, commandId = command.id}
		if progress.ref then recovery.ref = progress.ref end
		error({code = "PARTIAL", message = V.safeError(result), recovery = recovery, unsafe = true}, 0)
	end
	error(result, 0)
end

function Operations:children(args: any): any
	V.fields(args, {"root", "ref", "limit"}, "children arguments")
	local root = self.registry:root(args.root)
	local parent = if args.ref then self.registry:resolve(args.ref) else root
	if self.registry:rootOf(parent) ~= args.root then V.fail("GRANT", "Parent is outside the requested root.") end
	local limit = if args.limit == nil then 100 else V.integer(args.limit, 1, 200, "limit")
	local children = parent:GetChildren()
	local items = V.array({})
	for index = 1, math.min(limit, #children) do table.insert(items, self.registry:node(children[index])) end
	return {parentRef = self.registry:ref(parent), items = items, truncated = #children > limit}
end

-- Primary API docs verified 2026-10-14:
-- https://create.roblox.com/docs/reference/engine/classes/DataModel (CreatorType/CreatorId/PlaceId/GameId)
-- https://create.roblox.com/docs/reference/engine/enums/CreatorType
-- https://create.roblox.com/docs/reference/engine/classes/StudioService#GetUserId (anonymous = 0)
-- https://create.roblox.com/docs/reference/engine/classes/StudioTestService#EditModeActive
-- Registry owns the actual granted service and GUID; no caller path or inferred ID.
function Operations:importContext(args: any): any
	V.fields(args, {}, "import-context arguments")
	local workspace = self.registry:root("Workspace")
	local gameModel = self.registry.gameModel
	local function snapshot(): any
		local ok, value = pcall(function(): any
			local creatorType = gameModel.CreatorType
			return {placeId = V.integer(gameModel.PlaceId, 0, 9007199254740991, "place ID"),
				universeId = V.integer(gameModel.GameId, 0, 9007199254740991, "universe ID"),
				creatorId = V.integer(gameModel.CreatorId, 0, 9007199254740991, "creator ID"),
				creatorKind = if creatorType == Enum.CreatorType.User then "user"
					else if creatorType == Enum.CreatorType.Group then "group" else V.NULL,
				edit = V.boolean(gameModel:GetService("StudioTestService").EditModeActive, "Studio edit state")}
		end)
		if not ok then V.fail("CONTEXT_UNAVAILABLE", "Studio import identity or mode could not be observed exactly.") end
		return value
	end
	local before = snapshot()
	local creator: any = {status = "unavailable", kind = V.NULL, id = before.creatorId, provenance = "game.CreatorType/CreatorId"}
	if before.creatorId > 0 and before.creatorKind ~= V.NULL then
		creator.status, creator.kind = "available", before.creatorKind
	end
	local studioUser: any = {status = "not_applicable", id = V.NULL, provenance = "StudioService:GetUserId"}
	-- Even a template/nonzero partial identity must never use the Studio user.
	if before.placeId == 0 and before.universeId == 0 and before.creatorId == 0 then
		studioUser.status = "unavailable"
		local ok, userId = pcall(function(): number
			return V.integer(gameModel:GetService("StudioService"):GetUserId(), 1, 9007199254740991, "Studio user ID")
		end)
		if ok then studioUser.status, studioUser.id = "available", userId end
	end
	local after = snapshot()
	if not V.equal(before, after) then V.fail("CONTEXT_CHANGED", "Studio identity or mode changed during observation; request fresh context.") end
	if workspace.Parent ~= gameModel or workspace.ClassName ~= "Workspace" then V.fail("REF", "The granted Workspace is unavailable.") end
	return {sessionId = self.registry.sessionId, root = "Workspace", parentRef = self.registry:ref(workspace),
		placeId = after.placeId, universeId = after.universeId, mode = if after.edit then "Edit" else "Play",
		modeProvenance = "StudioTestService.EditModeActive", creator = creator, studioUser = studioUser}
end

-- Separate uploader read: published place owner/group is NOT the active Studio
-- account. This observes identity only and never certifies upload permissions.
function Operations:uploadContext(args: any): any
	V.fields(args, {}, "upload-context arguments")
	local before = self:importContext({})
	local function uploader(): any
		local ok, userId = pcall(function(): number
			return V.integer(self.gameModel:GetService("StudioService"):GetUserId(), 1, 9007199254740991, "Studio uploader ID")
		end)
		return if ok then {status = "available", id = userId, provenance = "StudioService:GetUserId"}
			else {status = "unavailable", id = V.NULL, provenance = "StudioService:GetUserId"}
	end
	local first = uploader()
	local after = self:importContext({})
	local second = uploader()
	if not V.equal(before, after) or not V.equal(first, second) then V.fail("CONTEXT_CHANGED", "Place or uploader changed during upload context observation.") end
	after.uploader = second
	return after
end

function Operations:search(args: any): any
	V.fields(args, {"root", "query", "limit"}, "search arguments")
	local root = self.registry:root(args.root)
	local query = string.lower(V.string(args.query, "query", 100))
	local limit = if args.limit == nil then 100 else V.integer(args.limit, 1, 200, "limit")
	local queue: {any} = {root}
	local items = V.array({})
	local head, visited, omitted = 1, 0, false
	while head <= #queue and visited < 5000 do
		local instance = queue[head]
		head += 1
		visited += 1
		if string.find(string.lower(instance.Name), query, 1, true) then
			if #items == limit then return {items = items, truncated = true} end
			table.insert(items, self.registry:node(instance))
		end
		for _, child in ipairs(instance:GetChildren()) do
			if #queue < 5000 then table.insert(queue, child) else omitted = true; break end
		end
	end
	return {items = items, truncated = omitted or head <= #queue}
end

-- Content discovery reads editor text. Matches never authorize an update:
-- script.read must supply its exact current baseline before editing.
function Operations:searchScripts(args: any, guard: () -> ()): any
	V.fields(args, {"root", "ref", "query", "limit", "caseSensitive"}, "script search arguments")
	local root = self.registry:root(args.root)
	local parent = if args.ref ~= nil then self.registry:resolve(args.ref) else root
	local function scope(instance: any): ()
		guard()
		if self.registry:rootOf(parent) ~= args.root or self.registry:rootOf(instance) ~= args.root
			or (instance ~= parent and not instance:IsDescendantOf(parent)) then V.fail("GRANT", "Search scope changed.") end
	end
	scope(parent)
	local query = V.string(args.query, "query", 256)
	if string.find(query, "[%c]") then V.fail("INPUT", "Use a literal single-line query.") end
	if args.caseSensitive ~= nil and type(args.caseSensitive) ~= "boolean" then V.fail("INPUT", "caseSensitive must be a boolean.") end
	local sensitive = args.caseSensitive ~= false
	local needle = if sensitive then query else string.lower(query)
	local limit = if args.limit == nil then 50 else V.integer(args.limit, 1, 100, "limit")
	local items, reasons = V.array({}), V.array({})
	local queue: {any} = {parent}
	local head, nodes, scripts, sourceBytes, skipped, resultBytes = 1, 0, 0, 0, 0, 0
	local function incomplete(reason: string): ()
		if not table.find(reasons, reason) then table.insert(reasons, reason) end
	end
	local stopped = false
	while head <= #queue and not stopped do
		local instance = queue[head]
		head += 1
		scope(instance)
		if nodes == 5000 then incomplete("nodes"); break end
		nodes += 1
		if instance:IsA("LuaSourceContainer") then
			if scripts == 128 then incomplete("scripts"); break end
			scripts += 1
			local ok, source = pcall(function(): string return self:source(instance) end)
			scope(instance) -- Grant loss or reparenting is not an unreadable-source skip.
			if not ok then skipped += 1; incomplete("unreadable-source")
			elseif sourceBytes + #source > 2 * 1024 * 1024 then incomplete("source-bytes"); break
			else
				sourceBytes += #source
				local start, lineNumber = 1, 1
				while start <= #source do
					local newline = string.find(source, "\n", start, true)
					local last = if newline then newline - 1 else #source
					if string.sub(source, last, last) == "\r" then last -= 1 end
					local line = string.sub(source, start, last)
					local column = string.find(if sensitive then line else string.lower(line), needle, 1, true)
					if column then
						if #items == limit then incomplete("matches"); stopped = true; break end
						local first = utf8.offset(line, 0, math.max(1, column - 64)) :: number
						local finish = utf8.offset(line, 0, math.min(#line + 1, first + 512)) :: number
						local item = self.registry:node(instance)
						item.line, item.column = lineNumber, column
						item.excerpt, item.excerptStartColumn = string.sub(line, first, finish - 1), first
						item.excerptTruncated = first > 1 or finish <= #line
						local size = #V.encode(item, self.http)
						if resultBytes + size > 256 * 1024 then incomplete("result-bytes"); stopped = true; break end
						resultBytes += size
						table.insert(items, item)
					end
					if not newline then break end
					start, lineNumber = newline + 1, lineNumber + 1
				end
			end
		end
		if not stopped then
			for _, child in ipairs(instance:GetChildren()) do
				if #queue < 5000 then table.insert(queue, child) else incomplete("nodes"); break end
			end
		end
	end
	scope(parent)
	return {parentRef = self.registry:ref(parent), items = items, truncated = #reasons > 0, reasons = reasons,
		nodesVisited = nodes, scriptsRead = scripts - skipped, skippedScripts = skipped, sourceBytes = sourceBytes,
		literal = true, caseSensitive = sensitive, sourceKind = "editor", columnEncoding = "utf8-bytes", atomicSnapshot = false}
end


-- Expand a constraint's maximum before moving its minimum, then contract to the requested maximum.
-- This also handles mixed-axis changes that neither simple min-first nor max-first ordering permits.
local function assignGui(instance: any, decoded: any): ()
	local vectorBounds = instance.ClassName == "UISizeConstraint" and decoded.MinSize ~= nil
	local textBounds = instance.ClassName == "UITextSizeConstraint" and decoded.MinTextSize ~= nil
	if vectorBounds then
		instance.MaxSize = Vector2.new(math.max(instance.MaxSize.X, decoded.MaxSize.X), math.max(instance.MaxSize.Y, decoded.MaxSize.Y))
		instance.MinSize, instance.MaxSize = decoded.MinSize, decoded.MaxSize
	elseif textBounds then
		instance.MaxTextSize = math.max(instance.MaxTextSize, decoded.MaxTextSize)
		instance.MinTextSize, instance.MaxTextSize = decoded.MinTextSize, decoded.MaxTextSize
	end
	local names = {}; for name in pairs(decoded) do table.insert(names, name) end; table.sort(names)
	for _, name in ipairs(names) do
		if not (vectorBounds and (name == "MinSize" or name == "MaxSize")) and not (textBounds and (name == "MinTextSize" or name == "MaxTextSize")) then instance[name] = decoded[name] end
	end
end

function Operations:updateGuiProperties(command: any, args: any, instance: any, guard: () -> (), restoring: boolean?): any
	local className = instance.ClassName
	V.object(args.properties, "GUI properties"); V.object(args.expected, "GUI baseline")
	local names, gui, decoded = {}, {}, {}
	for name, value in pairs(args.properties) do
		if #names >= V.MAX_PROPERTIES then V.fail("INPUT", "Too many GUI properties.") end
		if name ~= "Name" and LegacyProperties.GUI_SPECS[className][name] == nil then V.fail("PROPERTY", "Property is not writable for this GUI class.") end
		table.insert(names, name)
		if restoring then
			if name ~= "Font" or args.properties.FontFace == nil then decoded[name] = LegacyProperties.restoreGuiValue(className, name, value) end
		elseif name == "Name" then decoded.Name = V.string(value, "name", 100)
		else gui[name] = value end
	end
	if #names == 0 then V.fail("INPUT", "Choose at least one GUI property to update.") end
	table.sort(names)
	if not restoring then
		for name, value in pairs(LegacyProperties.decodeEffects(className, gui, function(): any return V.fail("PROPERTY", "GUI properties take no references.") end)) do decoded[name] = value end
	end
	local baselineSet = {}; for _, name in ipairs(names) do baselineSet[name] = true end
	if args.properties.Font ~= nil or args.properties.FontFace ~= nil then baselineSet.Font, baselineSet.FontFace = true, true end
	if className == "UISizeConstraint" and (args.properties.MinSize ~= nil or args.properties.MaxSize ~= nil) then baselineSet.MinSize, baselineSet.MaxSize = true, true end
	if className == "UITextSizeConstraint" and (args.properties.MinTextSize ~= nil or args.properties.MaxTextSize ~= nil) then baselineSet.MinTextSize, baselineSet.MaxTextSize = true, true end
	local baselineNames = {}; for name in pairs(baselineSet) do table.insert(baselineNames, name) end; table.sort(baselineNames)
	local count = 0
	for name in pairs(args.expected) do
		if not baselineSet[name] then V.fail("INPUT", "Expected properties must cover changed and linked GUI values.") end
		count += 1
	end
	if count ~= #baselineNames then V.fail("INPUT", "Expected properties must cover changed and linked GUI values.") end
	if not V.equal(LegacyProperties.snapshotGui(instance, baselineNames), args.expected) then V.fail("CONFLICT", "GUI properties differ from the observed baseline.") end
	local retained, allowed = {}, {}
	for _, name in ipairs(names) do
		allowed[name] = true
		retained[name] = true
	end
	if decoded.Font ~= nil or decoded.FontFace ~= nil then retained.Font, retained.FontFace, allowed.Font, allowed.FontFace = true, true, true, true end
	if className == "UISizeConstraint" and (decoded.MinSize ~= nil or decoded.MaxSize ~= nil) then
		decoded.MinSize, decoded.MaxSize = decoded.MinSize or instance.MinSize, decoded.MaxSize or instance.MaxSize
		retained.MinSize, retained.MaxSize, allowed.MinSize, allowed.MaxSize = true, true, true, true
	elseif className == "UITextSizeConstraint" and (decoded.MinTextSize ~= nil or decoded.MaxTextSize ~= nil) then
		decoded.MinTextSize, decoded.MaxTextSize = decoded.MinTextSize or instance.MinTextSize, decoded.MaxTextSize or instance.MaxTextSize
		retained.MinTextSize, retained.MaxTextSize, allowed.MinTextSize, allowed.MaxTextSize = true, true, true, true
	end
	LegacyProperties.crossCheck(className, decoded)
	local receiptNames = {}; for name in pairs(retained) do table.insert(receiptNames, name) end; table.sort(receiptNames)
	local ref, ownership = self.registry:ref(instance), P.captureOwnership(instance, self.collection)
	local before = V.immutable(LegacyProperties.snapshotGui(instance, receiptNames))
	local unchanged = {}; for name, value in pairs(ownership.properties) do if not allowed[name] then unchanged[name] = value end end
	local collateral = {properties = unchanged, attributes = ownership.attributes, tags = ownership.tags}
	return self:record(command, guard, function(progress: any): any
		guard(); self.registry:resolve(ref)
		if not P.ownershipMatches(instance, self.collection, ownership) then V.fail("CONFLICT", "GUI properties changed before the write.") end
		progress.ref = ref
		local applied, applyError = pcall(function()
			progress.touched = true
			assignGui(instance, decoded)
			for name, value in pairs(decoded) do
				if name == "Name" then
					if instance.Name ~= value then V.fail("VERIFY", "GUI name differs after assignment.") end
				elseif not LegacyProperties.effectMatches(instance, className, name, value) then V.fail("VERIFY", "GUI property differs after assignment.") end
			end
			if not P.ownershipMatches(instance, self.collection, collateral) then V.fail("VERIFY", "An unrelated managed GUI value changed during assignment.") end
		end)
		if not applied then
			local original = {}; for name, value in pairs(before) do
				if name ~= "Font" or before.FontFace == nil then original[name] = LegacyProperties.restoreGuiValue(className, name, value) end
			end
			pcall(function() assignGui(instance, original) end)
			if P.ownershipMatches(instance, self.collection, ownership) then progress.touched = false end
			V.fail("VERIFY", "GUI assignment could not be verified: " .. V.safeError(applyError))
		end
		return {ref = self.registry:ref(instance), mutation = {kind = "scene.update", ref = ref,
			before = {properties = before}, after = {properties = LegacyProperties.snapshotGui(instance, receiptNames)}}}
	end)
end

function Operations:updateProperties(command: any, args: any, guard: () -> (), restoring: boolean?): any
	V.fields(args, {"ref", "expected", "properties"}, "update arguments")
	local instance = self.registry:resolve(args.ref)
	if LegacyProperties.GUI_SPECS[instance.ClassName] then return self:updateGuiProperties(command, args, instance, guard, restoring) end
	local decoded, names = P.validate(instance, args.properties, self.registry:isService(instance))
	if #names == 0 then V.fail("INPUT", "Choose at least one property to update.") end
	P.validate(instance, args.expected, self.registry:isService(instance))
	for key in pairs(args.expected) do if not table.find(names, key) then V.fail("INPUT", "Expected properties must exactly cover the changed properties.") end end
	if not P.compare(instance, args.expected, names) then V.fail("CONFLICT", "Properties differ from the expected baseline.") end
	local ref = self.registry:ref(instance)
	local before = V.immutable(P.snapshot(instance, names))
	return self:record(command, guard, function(progress: any): any
		guard()
		self.registry:resolve(ref)
		if not P.compare(instance, args.expected, names) then V.fail("CONFLICT", "Properties changed before the write.") end
		progress.ref = ref
		local original, observable = {}, P.snapshot(instance)
		for _, name in ipairs(names) do original[name] = instance[name] end
		for _, name in ipairs(names) do
			progress.touched = true
			instance[name] = decoded[name]
		end
		for _, name in ipairs(names) do
			if not P.assignedMatches(instance, name, decoded[name]) then
				-- The engine coerced a value. Synchronously restore the exact engine
				-- baseline; only a fully verified revert is a clean, untouched failure.
				local reverted = pcall(function()
					for _, restoring in ipairs(names) do instance[restoring] = original[restoring] end
				end)
				if reverted then
					local matches = true
					for _, restoring in ipairs(names) do if instance[restoring] ~= original[restoring] then matches = false end end
					if matches and V.equal(P.snapshot(instance), observable) then progress.touched = false end
				end
				V.fail("VERIFY", "Property write did not match the requested value.")
			end
		end
		return {ref = self.registry:ref(instance), mutation = {kind = "scene.update", ref = ref,
			before = {properties = before}, after = {properties = P.snapshot(instance, names)}}}
	end)
end

function Operations:updateSource(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"ref", "expectedSource", "source"}, "source arguments")
	local instance = self.registry:resolve(args.ref)
	local expected = V.string(args.expectedSource, "expected source", V.SOURCE_BYTES, true)
	local source = V.string(args.source, "source", V.SOURCE_BYTES, true)
	if self:source(instance) ~= expected then V.fail("CONFLICT", "Editor source differs from the expected baseline.") end
	local ref = self.registry:ref(instance)
	local proposed = {ref = ref, mutation = {kind = "script.update", ref = ref, before = {source = expected}, after = {source = source}}}
	if #V.encode(proposed, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Source receipt would exceed 512 KiB; no change attempted.") end
	return self:record(command, guard, function(progress: any): any
		local conflict = false
		self.editor:UpdateSourceAsync(instance, function(current: string): string?
			-- Roblox may invoke this callback again. Every invocation fences the
			-- session and compares the exact editor baseline; never yield here.
			guard()
			self.registry:resolve(ref)
			if current ~= expected then conflict = true end
			if conflict then return nil end
			progress.ref = ref
			progress.touched = true
			return source
		end)
		local observed = self:source(instance)
		if conflict then
			-- Once a callback proposed a write, keep the uncertainty flag sticky.
			V.fail("CONFLICT", "Editor changed during the source update.")
		end
		if observed ~= source then V.fail("VERIFY", "Editor source did not match after the update.") end
		return {ref = self.registry:ref(instance), mutation = {kind = "script.update", ref = ref,
			before = {source = expected}, after = {source = observed}}}
	end)
end

function Operations:setEnabled(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"ref", "expectedSource", "expectedEnabled", "enabled"}, "execution-state arguments")
	local instance = self.registry:resolve(args.ref)
	if not instance:IsA("BaseScript") then V.fail("CLASS", "Only Script and LocalScript have an execution state.") end
	local expected = V.string(args.expectedSource, "expected source", V.SOURCE_BYTES, true)
	if type(args.expectedEnabled) ~= "boolean" or type(args.enabled) ~= "boolean" then V.fail("INPUT", "Execution state and baseline must be booleans.") end
	if args.enabled and not string.find(expected, "%S") then V.fail("SOURCE_EMPTY", "An empty placeholder cannot be activated.") end
	local ref = self.registry:ref(instance)
	local function matches(): boolean
		return self:source(instance) == expected and not instance.Disabled == args.expectedEnabled
	end
	if not matches() then V.fail("CONFLICT", "Source or execution state differs from the exact baseline.") end
	-- The host compiles this exact source before delivery. A dirty editor buffer
	-- must not activate a different persisted implementation in the engine.
	if args.enabled and instance.Source ~= expected then V.fail("UNSAVED_SOURCE", "Persisted source differs from the verified editor source. Save the script first.") end
	local proposed = {ref = ref, mutation = {kind = "script.set_enabled", ref = ref,
		before = {source = expected, enabled = args.expectedEnabled}, after = {source = expected, enabled = args.enabled}}}
	if #V.encode(proposed, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Execution-state receipt would exceed 512 KiB; no change attempted.") end
	return self:record(command, guard, function(progress: any): any
		guard()
		self.registry:resolve(ref)
		if not matches() then V.fail("CONFLICT", "Source or execution state changed before activation.") end
		if args.enabled and instance.Source ~= expected then V.fail("UNSAVED_SOURCE", "Persisted source changed before activation.") end
		progress.ref = ref
		progress.touched = true
		instance.Disabled = not args.enabled
		if not instance.Disabled ~= args.enabled or self:source(instance) ~= expected or (args.enabled and instance.Source ~= expected) then V.fail("VERIFY", "Script execution state/source did not match after assignment.") end
		return {ref = self.registry:ref(instance), mutation = {kind = "script.set_enabled", ref = ref,
			before = {source = expected, enabled = args.expectedEnabled}, after = {source = expected, enabled = not instance.Disabled}}}
	end)
end

-- Effects classes: decode everything (including Attachment refs resolved by the Registry), allocate
-- detached, assign and verify every value, then parent once inside one undo recording.
function Operations:createEffect(command: any, args: any, guard: () -> ()): any
	local parent = self.registry:resolve(args.parent)
	local className = args.className
	local name = V.string(args.name, "name", 100)
	local host = LegacyProperties.hostKind(parent)
	if not host or not table.find(LegacyProperties.hostsOf(className), host) then V.fail("CLASS", className .. " must be created inside a " .. table.concat(LegacyProperties.hostsOf(className), " or ") .. ".") end
	if self.registry.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
	local decoded = LegacyProperties.decodeEffects(className, if args.properties == nil then {} else args.properties, function(tag: any, label: string, kind: string): any
		V.fields(tag, {"type", "ref"}, label)
		local target = self.registry:resolve(tag.ref)
		local wanted = LegacyProperties.REF_CLASSES[kind]
		if not target:IsA(wanted) then V.fail("PROPERTY", label .. " must name a " .. wanted .. ".") end
		return target
	end)
	return self:record(command, guard, function(progress: any): any
		guard()
		self.registry:resolve(args.parent)
		local instance = Instance.new(className)
		local prepared, prepareError = pcall(function()
			instance.Name = name
			LegacyProperties.applyEffect(instance, className, decoded)
			guard()
		end)
		if not prepared then instance:Destroy(); error(prepareError, 0) end
		progress.touched = true
		instance.Parent = parent
		local ref = self.registry:ref(instance)
		progress.ref = ref
		local snapshot = P.snapshot(instance)
		self.registry.owned[instance] = {parent = parent, properties = V.immutable(snapshot),
			attributes = V.immutable(instance:GetAttributes()), tags = V.immutable(self.collection:GetTags(instance)),
			typedOwnership = P.captureOwnership(instance, self.collection)}
		return {ref = ref, mutation = {kind = "scene.create", ref = ref, before = V.NULL, after = {properties = snapshot}}}
	end)
end

function Operations:create(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"parent", "className", "name", "properties"}, "create arguments")
	if LegacyProperties.specsOf(args.className) then return self:createEffect(command, args, guard) end
	local parent = self.registry:resolve(args.parent)
	if type(args.className) ~= "string" or not table.find(P.CLASSES, args.className) then V.fail("CLASS", "Class is not creatable.") end
	local name = V.string(args.name, "name", 100)
	local properties = if args.properties == nil then {} else args.properties
	if self.registry.count >= V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
	-- Decode the complete payload before allocating or parenting an Instance.
	V.object(properties, "properties")
	local decoded: {[string]: any} = {}
	local propertyCount = 0
	for key, value in pairs(properties) do
		propertyCount += 1
		if propertyCount > V.MAX_PROPERTIES then V.fail("INPUT", "Too many properties.") end
		if key == "Name" then V.fail("PROPERTY", "Use the create name field.") end
		decoded[key] = P.decode(key, value, table.find(V.BASE_PART_CLASSES, args.className) ~= nil,
			table.find(V.PART_SHAPE_CLASSES, args.className) ~= nil)
	end
	local instance: any = nil
	local result = self:record(command, guard, function(progress: any): any
		guard()
		self.registry:resolve(args.parent)
		instance = Instance.new(args.className)
		local prepared, prepareError = pcall(function()
			instance.Name = name
			if instance:IsA("BaseScript") then instance.Disabled = true end
			for key, value in pairs(decoded) do instance[key] = value end
			for key, value in pairs(decoded) do if not P.assignedMatches(instance, key, value) then V.fail("VERIFY", "Created property differs from the requested value.") end end
			guard()
		end)
		if not prepared then instance:Destroy(); error(prepareError, 0) end
		progress.touched = true
		instance.Parent = parent
		local ref = self.registry:ref(instance)
		progress.ref = ref
		local snapshot = P.snapshot(instance)
		local source = if instance:IsA("LuaSourceContainer") then self:source(instance) else nil
		self.registry.owned[instance] = {parent = parent, properties = V.immutable(snapshot), source = source,
			enabled = if instance:IsA("BaseScript") then not instance.Disabled else nil,
			attributes = V.immutable(instance:GetAttributes()), tags = V.immutable(self.collection:GetTags(instance))}
		return {ref = ref, mutation = {kind = "scene.create", ref = ref, before = V.NULL, after = {properties = snapshot}}}
	end)
	return result
end

-- Fixed assignment order: Shape before Size (a Ball constrains Size), rotation before position.
local BUILD_ORDER = table.freeze({"Shape", "Material", "Size", "Orientation", "Position", "Color", "Transparency", "Reflectance", "Anchored", "CanCollide", "CastShadow"})

function Operations:buildProperties(className: string, properties: any): {[string]: any}
	local values = if properties == nil then {} else properties
	V.object(values, "properties")
	local decoded: {[string]: any} = {}
	local count = 0
	for key, value in pairs(values) do
		count += 1
		if count > V.MAX_PROPERTIES then V.fail("INPUT", "Too many properties.") end
		if key == "Name" then V.fail("PROPERTY", "Use the item name field.") end
		decoded[key] = P.decode(key, value, true, table.find(V.PART_SHAPE_CLASSES, className) ~= nil)
	end
	return decoded
end

-- One scene.build effect item. Attachment refs become plan markers that must name an EARLIER
-- Attachment item of this build; they bind to the detached Instances before the root is parented.
function Operations:planEffect(item: any, index: number, name: string, into: number, host: string, effectHosts: {[number]: any}): any
	V.fields(item, {"kind", "className", "name", "parent", "properties", "key"}, "effect item")
	local className = item.className
	if type(className) ~= "string" or not LegacyProperties.EFFECT_SPECS[className] then V.fail("CLASS", "Unsupported effect class.") end
	if not table.find(LegacyProperties.EFFECT_HOSTS[className], host) then V.fail("INPUT", className .. " must be inside a " .. table.concat(LegacyProperties.EFFECT_HOSTS[className], " or ") .. " item.") end
	local decoded = LegacyProperties.decodeEffects(className, if item.properties == nil then {} else item.properties, function(tag: any, label: string, kind: string): any
		V.fields(tag, {"type", "item"}, label)
		local target = effectHosts[V.integer(tag.item, 1, math.max(1, index - 1), label)]
		if not target or target.kind ~= kind then V.fail("INPUT", LegacyProperties.REF_CLASSES[kind] .. " refs must name an earlier " .. LegacyProperties.REF_CLASSES[kind] .. " item of this build.") end
		return table.freeze({planIndex = target.plan})
	end)
	return {className = className, name = name, parent = into, effect = decoded}
end

local function buildTriple(value: any, low: number, high: number, label: string): {number}
	local list = V.list(value, 3, label)
	if #list ~= 3 then V.fail("INPUT", label .. " needs three numbers.") end
	for _, item in ipairs(list) do V.number(item, low, high, label) end
	return list
end

-- One atomic hierarchy: decode and plan everything, allocate detached, verify every
-- property, then parent the root once inside a single undo recording.
function Operations:build(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"parent", "container", "prototypes", "items", "templates"}, "build arguments")
	local L = V.BUILD_LIMITS
	local parent = self.registry:resolve(args.parent)
	local templates = if args.templates == nil then {} else AssetPlacement.buildTemplates(self, args.templates)
	local cloneExtra = 0 -- template descendants copied by clone items
	local rootSpec = V.fields(args.container, {"className", "name", "properties"}, "build container")
	-- A ScreenGui root builds a whole screen UI atomically under StarterGui (or a Model/Folder template holder).
	local guiRoot = rootSpec.className == "ScreenGui"
	if not guiRoot and rootSpec.className ~= "Model" and rootSpec.className ~= "Folder" then V.fail("CLASS", "The build root must be a Model, Folder or ScreenGui.") end
	local GUI_HOSTS = LegacyProperties.GUI_HOSTS
	local function noRefs(): any return V.fail("PROPERTY", "GUI classes take no references.") end
	local function guiProperties(className: string, values: any): {[string]: any}
		return LegacyProperties.decodeEffects(className, if values == nil then {} else values, noRefs)
	end
	local rootEffect: any = nil
	if guiRoot then
		local host = LegacyProperties.hostKind(parent)
		if not host or not table.find(GUI_HOSTS.ScreenGui, host) then V.fail("CLASS", "A ScreenGui build root must be built in StarterGui or a Model/Folder.") end
		rootEffect = guiProperties("ScreenGui", rootSpec.properties)
	elseif rootSpec.properties ~= nil then
		V.fail("INPUT", "Only a ScreenGui build root takes properties.")
	end
	local plan: {any} = {{className = rootSpec.className, name = V.string(rootSpec.name, "name", 100), parent = 0, effect = rootEffect}}
	local function add(entry: any): number
		table.insert(plan, entry)
		if #plan > L.instances then V.fail("BODY_LIMIT", "A build may create at most " .. L.instances .. " instances.") end
		return #plan
	end
	local prototypes: {any} = {}
	local rawPrototypes = if args.prototypes == nil then V.array({}) else args.prototypes
	for _, raw in ipairs(V.list(rawPrototypes, L.prototypes, "prototypes")) do
		if V.object(raw, "prototype").gui ~= nil then
			-- GUI prototype: element 1 is the root (parent 0); later elements name an earlier hosting element.
			local guiProto = V.fields(raw, {"name", "gui"}, "GUI prototype")
			V.string(guiProto.name, "prototype name", 100)
			local elements: {any} = {}
			for index, rawElement in ipairs(V.list(guiProto.gui, L.prototypeParts, "GUI prototype elements")) do
				local element = V.fields(rawElement, {"className", "name", "parent", "properties"}, "prototype element")
				local className = element.className
				if type(className) ~= "string" or not LegacyProperties.GUI_SPECS[className] then V.fail("CLASS", "Unsupported GUI prototype class.") end
				local parentIndex = if element.parent == nil then 0 else V.integer(element.parent, 0, index - 1, "element parent")
				if (index == 1) ~= (parentIndex == 0) then V.fail("INPUT", "The first element is the prototype root (parent 0); later elements name an earlier element.") end
				if index > 1 then
					local host = LegacyProperties.GUI_HOST_CLASSES[elements[parentIndex].className]
					if not host or not table.find(GUI_HOSTS[className], host) then V.fail("INPUT", className .. " cannot be inside " .. elements[parentIndex].className .. ".") end
				end
				table.insert(elements, {className = className, name = V.string(element.name, "element name", 100), parent = parentIndex,
					effect = guiProperties(className, element.properties)})
			end
			if #elements == 0 then V.fail("INPUT", "A GUI prototype needs at least one element.") end
			table.insert(prototypes, {gui = elements})
			continue
		end
		local proto = V.fields(raw, {"name", "weld", "parts"}, "prototype")
		V.string(proto.name, "prototype name", 100)
		local parts: {any} = {}
		for _, rawPart in ipairs(V.list(proto.parts, L.prototypeParts, "prototype parts")) do
			local part = V.fields(rawPart, {"className", "name", "properties", "tint"}, "prototype part")
			if type(part.className) ~= "string" or not table.find(V.BUILD_PART_CLASSES, part.className) then V.fail("CLASS", "Unsupported build part class.") end
			table.insert(parts, {className = part.className, name = V.string(part.name, "part name", 100),
				properties = self:buildProperties(part.className, part.properties), tint = V.boolean(part.tint, "tint")})
		end
		if #parts == 0 then V.fail("INPUT", "A prototype needs at least one part.") end
		table.insert(prototypes, {weld = V.boolean(proto.weld, "weld"), parts = parts})
	end
	local items = V.list(args.items, L.items, "build items")
	if #items == 0 then V.fail("INPUT", "A build needs at least one item.") end
	local containers: {[number]: number} = {}
	local effectHosts: {[number]: any} = {} -- part items and Attachment effect items: {plan, kind}
	local keyed: {any} = {}
	local keys: {[string]: boolean} = {}
	for index, raw in ipairs(items) do
		local item = V.object(raw, "build item")
		local parentIndex = V.integer(item.parent, 0, index - 1, "item parent")
		local into = if parentIndex == 0 then 1 else containers[parentIndex]
		local nested = item.kind == "effect" or item.kind == "gui" or item.kind == "stamp"
		if not into and nested and effectHosts[parentIndex] then into = effectHosts[parentIndex].plan end
		if not into then V.fail("INPUT", "Only group items can contain other items.") end
		if guiRoot and parentIndex == 0 and item.kind ~= "gui" and item.kind ~= "stamp" then V.fail("INPUT", "A ScreenGui build root holds only gui and stamp items.") end
		local hostOf = if parentIndex == 0 then (if guiRoot then "layer" else "group") elseif containers[parentIndex] then "group" else effectHosts[parentIndex].kind
		local name = V.string(item.name, "item name", 100)
		local created: number
		if item.kind == "gui" then
			V.fields(item, {"kind", "className", "name", "parent", "properties", "key"}, "gui item")
			local className = item.className
			if type(className) ~= "string" or not LegacyProperties.GUI_SPECS[className] then V.fail("CLASS", "Unsupported GUI class.") end
			if not table.find(GUI_HOSTS[className], hostOf) then V.fail("INPUT", className .. " must be inside a " .. table.concat(GUI_HOSTS[className], " or ") .. " item.") end
			created = add({className = className, name = name, parent = into, effect = guiProperties(className, item.properties)})
			local provides = LegacyProperties.GUI_HOST_CLASSES[className]
			if provides then effectHosts[index] = {plan = created, kind = provides} end
		elseif item.kind == "stamp" then
			-- One copy of a GUI prototype; properties override the prototype root's own properties.
			V.fields(item, {"kind", "template", "name", "parent", "properties", "key"}, "stamp item")
			local proto = prototypes[V.integer(item.template, 1, math.max(1, #prototypes), "prototype index")]
			if not proto or not proto.gui then V.fail("INPUT", "A stamp names an unknown GUI prototype.") end
			local root = proto.gui[1]
			if not table.find(GUI_HOSTS[root.className], hostOf) then V.fail("INPUT", root.className .. " must be inside a " .. table.concat(GUI_HOSTS[root.className], " or ") .. " item.") end
			local merged, count = table.clone(root.effect), 0
			for key, value in pairs(guiProperties(root.className, item.properties)) do merged[key] = value end
			for _ in pairs(merged) do count += 1 end
			if count > LegacyProperties.EFFECT_LIMITS.properties then V.fail("INPUT", "Too many properties on the stamped prototype root.") end
			LegacyProperties.crossCheck(root.className, merged)
			local planned: {number} = {}
			for elementIndex, element in ipairs(proto.gui) do
				local first = elementIndex == 1
				planned[elementIndex] = add({className = element.className, name = if first then name else element.name,
					parent = if first then into else planned[element.parent], effect = if first then merged else element.effect})
			end
			created = planned[1]
			local provides = LegacyProperties.GUI_HOST_CLASSES[root.className]
			if provides then effectHosts[index] = {plan = created, kind = provides} end
		elseif item.kind == "group" then
			V.fields(item, {"kind", "className", "name", "parent", "key"}, "group item")
			if item.className ~= "Model" and item.className ~= "Folder" then V.fail("CLASS", "Group items must be Model or Folder.") end
			created = add({className = item.className, name = name, parent = into})
			containers[index] = created
		elseif item.kind == "part" then
			V.fields(item, {"kind", "className", "name", "parent", "properties", "key"}, "part item")
			if type(item.className) ~= "string" or not table.find(V.BUILD_PART_CLASSES, item.className) then V.fail("CLASS", "Unsupported build part class.") end
			created = add({className = item.className, name = name, parent = into, properties = self:buildProperties(item.className, item.properties)})
			effectHosts[index] = {plan = created, kind = "part"}
		elseif item.kind == "effect" then
			created = add(self:planEffect(item, index, name, into, hostOf, effectHosts))
			local provides = LegacyProperties.EFFECT_HOST_CLASSES[item.className]
			if provides then effectHosts[index] = {plan = created, kind = provides} end
		elseif item.kind == "place" then
			V.fields(item, {"kind", "template", "name", "parent", "at", "yaw", "scale", "tint", "ground", "key"}, "placement")
			local proto = prototypes[V.integer(item.template, 1, math.max(1, #prototypes), "prototype index")]
			if not proto then V.fail("INPUT", "Placement names an unknown prototype.") end
			if proto.gui then V.fail("INPUT", "GUI prototypes are stamped (kind stamp), not placed.") end
			local at = table.clone(buildTriple(item.at, -100000, 100000, "placement position"))
			if item.ground ~= nil and V.boolean(item.ground, "placement ground") then
				-- Read-only probe of existing terrain/parts; nothing from this build is parented yet.
				local hit = self.registry:root("Workspace"):Raycast(Vector3.new(at[1], at[2] + 500, at[3]), Vector3.new(0, -1000, 0))
				if hit then at[2] = hit.Position.Y end
			end
			local yaw = V.number(item.yaw, -360, 360, "placement yaw")
			local scale = V.number(item.scale, 0.1, 20, "placement scale")
			local tint = if item.tint == nil or item.tint == V.NULL then nil else buildTriple(item.tint, 0, 2, "placement tint")
			local radians = math.rad(yaw)
			local c, s = math.cos(radians), math.sin(radians)
			local single = #proto.parts == 1
			local holder = into
			if not single then created = add({className = "Model", name = name, parent = into}); holder = created end
			local first: number? = nil
			for _, part in ipairs(proto.parts) do
				local properties = table.clone(part.properties)
				local size = properties.Size
				if size then
					local x, y, z = size.X * scale, size.Y * scale, size.Z * scale
					if math.min(x, y, z) < 0.05 or math.max(x, y, z) > 2048 then V.fail("PROPERTY", "A scaled prototype part must stay 0.05..2048 studs.") end
					properties.Size = Vector3.new(x, y, z)
				end
				local rel = properties.Position or Vector3.new(0, 0, 0)
				local rx, ry, rz = rel.X * scale, rel.Y * scale, rel.Z * scale
				local px, py, pz = at[1] + rx * c + rz * s, at[2] + ry, at[3] - rx * s + rz * c
				if math.max(math.abs(px), math.abs(py), math.abs(pz)) > 100000 then V.fail("PROPERTY", "A placed part must stay within 100000 studs.") end
				properties.Position = Vector3.new(px, py, pz)
				local o = properties.Orientation or Vector3.new(0, 0, 0)
				properties.Orientation = Vector3.new(o.X, (o.Y + yaw + 180) % 360 - 180, o.Z)
				local color = properties.Color
				if tint and part.tint and color then
					properties.Color = Color3.new(math.clamp(color.R * tint[1], 0, 1), math.clamp(color.G * tint[2], 0, 1), math.clamp(color.B * tint[3], 0, 1))
				end
				local partIndex = add({className = part.className, name = if single then name else part.name, parent = holder, properties = properties})
				if single then created = partIndex end
				if not first then first = partIndex
				elseif proto.weld then add({className = "WeldConstraint", name = "Weld", parent = partIndex, part0 = first, part1 = partIndex}) end
			end
			if not single then plan[created].primary = first end
		elseif item.kind == "clone" then
			created = add(AssetPlacement.planClone(self, item, name, into, templates))
			cloneExtra += plan[created].extra
			if #plan + cloneExtra > L.instances then V.fail("BODY_LIMIT", "A build may create at most " .. L.instances .. " instances, counting cloned template contents.") end
		else
			V.fail("INPUT", "Item kind must be group, part, effect, gui, stamp, place or clone.")
		end
		if item.key ~= nil then
			local key = V.string(item.key, "item key", 64)
			if not string.match(key, "^[%w_%-]+$") or keys[key] then V.fail("INPUT", "Item keys must be unique [A-Za-z0-9_-].") end
			keys[key] = true
			table.insert(keyed, {key = key, index = created})
			if #keyed > L.keys then V.fail("INPUT", "Too many keyed items.") end
		end
	end
	if self.registry.count + #keyed + 1 > V.MAX_REFS then V.fail("CAPACITY", "Reference capacity reached; pair a new session.") end
	-- Detached construction runs BEFORE the undo recording opens: nothing here is in the place,
	-- so cooperative yields cannot leak a concurrent user edit into Arcane's undo step, and a
	-- guard after every yield re-checks session, lease and Edit mode before any further work.
	guard()
	local instances: {any} = table.create(#plan)
	local snapshots: {any} = table.create(#plan)
	local fieldsByClass: {[string]: {string}} = {}
	local slice = self:slicer(guard)
	local function resolveMarker(marker: any): any return instances[marker.planIndex] end
	local prepared, prepareError = pcall(function()
		for index, entry in ipairs(plan) do
			local instance = if entry.clone then AssetPlacement.instantiate(entry) else Instance.new(entry.className)
			instances[index] = instance
			instance.Name = entry.name
			local properties = entry.properties
			if properties then
				for _, key in ipairs(BUILD_ORDER) do
					local value = properties[key]
					if value ~= nil then instance[key] = value end
				end
			end
			if entry.effect then LegacyProperties.applyEffect(instance, entry.className, entry.effect, resolveMarker) end
			if entry.part0 then
				local part0, part1 = instances[entry.part0], instances[entry.part1]
				instance.Part0, instance.Part1 = part0, part1
				if instance.Part0 ~= part0 or instance.Part1 ~= part1 then V.fail("VERIFY", "Weld did not bind its parts.") end
			end
			if index > 1 then instance.Parent = instances[entry.parent] end
			-- One read per snapshot field. Every requested property is verified from that same
			-- read (exactly as P.assignedMatches would), and the reads become the restore snapshot.
			local fields = fieldsByClass[entry.className]
			if not fields then fields = P.snapshotFields(instance); fieldsByClass[entry.className] = fields end
			local snapshot: {[string]: any} = {}
			for _, field in ipairs(fields) do
				local value = instance[field]
				snapshot[field] = if value == nil then V.NULL else value
			end
			if properties then
				for _, key in ipairs(BUILD_ORDER) do
					local value = properties[key]
					if value ~= nil then
						local actual = snapshot[key]
						if actual == nil then actual = instance[key] end
						if not P.readMatches(instance, key, value, actual) then
							V.fail("VERIFY", "Built property differs from the requested value: " .. entry.name .. "." .. key)
						end
					end
				end
			end
			snapshots[index] = P.captureOwnership(instance, self.collection, table.freeze(snapshot))
			slice()
		end
		for index, entry in ipairs(plan) do
			if entry.primary then instances[index].PrimaryPart = instances[entry.primary] end
		end
		guard()
	end)
	local function discard(): ()
		-- Nothing was parented into the place; discard every detached allocation.
		for index = #instances, 1, -1 do pcall(function() instances[index]:Destroy() end) end
	end
	if not prepared then discard(); error(prepareError, 0) end
	local root, parented = instances[1], false
	-- The recording covers exactly one place change: parenting the verified root. No yield inside.
	local recorded, receipt = pcall(function(): any
		return self:record(command, guard, function(progress: any): any
			guard()
			if self.registry:resolve(args.parent) ~= parent then V.fail("CONFLICT", "The build parent changed during construction.") end
			progress.touched = true
			root.Parent = parent
			parented = true
			local ref = self.registry:ref(root)
			progress.ref = ref
			local parents, children, classes = table.create(#instances), table.create(#instances), {}
			for index, instance in ipairs(instances) do
				local entry = plan[index]
				parents[index] = if index == 1 then parent else instances[entry.parent]
				children[index] = #instance:GetChildren()
				classes[entry.className] = (classes[entry.className] or 0) + 1
			end
			self.registry.owned[root] = {parent = parent, build = {instances = instances, parents = parents, snapshots = snapshots, children = children}}
			local refs = {}
			for _, entry in ipairs(keyed) do refs[entry.key] = self.registry:ref(instances[entry.index]) end
			return {ref = ref, refs = refs, created = {count = #instances + cloneExtra, classes = classes},
				mutation = {kind = "scene.build", ref = ref, before = V.NULL, after = {count = #instances + cloneExtra, classes = classes}}}
		end)
	end)
	if not recorded then
		if not parented then discard() end
		error(receipt, 0)
	end
	return receipt
end

local TERRAIN_MATERIALS = table.freeze({"Air", "Grass", "LeafyGrass", "Ground", "Mud", "Rock", "Slate", "Sand", "Sandstone", "Limestone", "Basalt", "Granite", "Pebble",
	"Snow", "Ice", "Glacier", "Salt", "Cobblestone", "Asphalt", "Concrete", "Brick", "WoodPlanks", "CrackedLava", "Water"})
local ENVIRONMENT_SECTIONS = table.freeze({
	{key = "lighting", props = {ClockTime = {0, 24}, Brightness = {0, 10}, ExposureCompensation = {-3, 3}, EnvironmentDiffuseScale = {0, 1}, EnvironmentSpecularScale = {0, 1},
		ShadowSoftness = {0, 1}, FogStart = {0, 100000}, FogEnd = {0, 100000}, Ambient = "color", OutdoorAmbient = "color", ColorShift_Top = "color", FogColor = "color", GlobalShadows = "boolean"}},
	{key = "atmosphere", className = "Atmosphere", props = {Density = {0, 1}, Offset = {0, 1}, Haze = {0, 10}, Glare = {0, 10}, Color = "color", Decay = "color"}},
	{key = "bloom", className = "BloomEffect", props = {Intensity = {0, 2}, Size = {0, 56}, Threshold = {0, 4}}},
	{key = "colorCorrection", className = "ColorCorrectionEffect", props = {Brightness = {-1, 1}, Contrast = {-1, 1}, Saturation = {-1, 1}, TintColor = "color"}},
	{key = "sunRays", className = "SunRaysEffect", props = {Intensity = {0, 1}, Spread = {0, 1}}},
})

local function environmentValue(value: any, kind: any, label: string): any
	if kind == "boolean" then return V.boolean(value, label) end
	if kind == "color" then
		local rgb = buildTriple(value, 0, 1, label)
		return Color3.new(rgb[1], rgb[2], rgb[3])
	end
	return V.number(value, kind[1], kind[2], label)
end
local function environmentEncode(value: any): any
	if type(value) == "number" or type(value) == "boolean" then return value end
	return V.array({value.R, value.G, value.B})
end
local function environmentMatches(actual: any, expected: any): boolean
	if type(expected) == "boolean" then return actual == expected end
	if type(expected) == "number" then return type(actual) == "number" and math.abs(actual - expected) <= 0.001 end
	return math.abs(actual.R - expected.R) <= 0.002 and math.abs(actual.G - expected.G) <= 0.002 and math.abs(actual.B - expected.B) <= 0.002
end

-- Bounded terrain fills plus fixed Lighting/effect settings in one undo recording.
-- Lighting changes are verified and reverted on failure before any terrain write.
local TECHNOLOGIES = table.freeze({"Future", "ShadowMap", "Voxel", "Compatibility"})
local VARIANT_MAPS = table.freeze({"ColorMap", "NormalMap", "RoughnessMap", "MetalnessMap"})
local function setVerified(target: any, property: string, value: any): boolean
	local ok, matches = pcall(function(): boolean
		target[property] = value
		local actual = target[property]
		if type(value) == "number" then return type(actual) == "number" and math.abs(actual - value) <= 0.001 end
		return actual == value
	end)
	return ok and matches
end

-- SoundService world-audio settings (environment.apply soundService); mirrored in studio-policy.ts SOUND_SERVICE_PROPERTIES.
local SOUND_SERVICE_PROPERTIES = table.freeze({
	AmbientReverb = {"enum", "ReverbType", {"NoReverb", "GenericReverb", "PaddedCell", "Room", "Bathroom", "LivingRoom", "StoneRoom", "Auditorium", "ConcertHall",
		"Cave", "Arena", "Hangar", "CarpetedHallway", "Hallway", "StoneCorridor", "Alley", "Forest", "City", "Mountains", "Quarry", "Plain", "ParkingLot", "SewerPipe", "UnderWater"}},
	DistanceFactor = {0.1, 100}, DopplerScale = {0, 10}, RolloffScale = {0, 10},
})

-- Effects-capability environment extras: Lighting.Technology, Terrain.Decoration, MaterialVariants and SoundService settings.
-- Everything is decoded before the recording; Studio settings it refuses fail with a precise manual step.
function Operations:environmentExtras(args: any): any
	local extras: any = {any = false}
	if args.technology ~= nil then
		extras.lighting = self.registry:root("Lighting")
		extras.technology = V.enum(args.technology, TECHNOLOGIES, Enum.Technology, "Lighting.Technology")
		extras.any, extras.subject = true, extras.lighting
	end
	if args.terrainDecoration ~= nil then
		local workspace = self.registry:root("Workspace")
		for _, child in ipairs(workspace:GetChildren()) do if child.ClassName == "Terrain" then extras.terrain = child end end
		if not extras.terrain then V.fail("TERRAIN", "Workspace has no Terrain object.") end
		extras.decoration = V.boolean(args.terrainDecoration, "terrainDecoration")
		extras.any, extras.subject = true, extras.subject or extras.terrain
	end
	if args.materials ~= nil then
		extras.subject = extras.subject or self.registry:root("Workspace")
		local service = self.gameModel:GetService("MaterialService")
		local names: {[string]: boolean} = {}
		extras.materialService, extras.materials, extras.any = service, {}, true
		for _, raw in ipairs(V.list(args.materials, 8, "material variants")) do
			local spec = V.fields(raw, {"name", "baseMaterial", "studsPerTile", "override", "ColorMap", "NormalMap", "RoughnessMap", "MetalnessMap"}, "material variant")
			local name = V.string(spec.name, "material variant name", 50)
			if not string.match(name, "^[%w_ %-]+$") or names[name] then V.fail("INPUT", "Material variant names are unique [A-Za-z0-9_ -].") end
			names[name] = true
			for _, child in ipairs(service:GetChildren()) do
				if child.Name == name then V.fail("CONFLICT", "MaterialService already has " .. name .. "; choose another variant name.") end
			end
			local values: {[string]: any} = {BaseMaterial = V.enum(spec.baseMaterial, LegacyProperties.MATERIALS, Enum.Material, "baseMaterial")}
			if spec.studsPerTile ~= nil then values.StudsPerTile = V.number(spec.studsPerTile, 0.1, 1000, "studsPerTile") end
			for _, map in ipairs(VARIANT_MAPS) do
				if spec[map] ~= nil then values[map] = LegacyProperties.contentId(spec[map], "MaterialVariant." .. map) end
			end
			table.insert(extras.materials, {name = name, values = values, override = spec.override ~= nil and V.boolean(spec.override, "override")})
		end
		if #extras.materials == 0 then V.fail("INPUT", "Choose at least one material variant.") end
	end
	if args.soundService ~= nil then
		extras.subject = extras.subject or self.registry:root("Workspace")
		local names: {string} = {}
		for name in pairs(SOUND_SERVICE_PROPERTIES) do table.insert(names, name) end
		local values = V.fields(args.soundService, names, "soundService")
		local decoded: {[string]: any} = {}
		local count = 0
		for name, value in pairs(values) do
			local spec = SOUND_SERVICE_PROPERTIES[name]
			decoded[name] = if spec[1] == "enum" then V.enum(value, spec[3], Enum[spec[2]], "SoundService." .. name) else V.number(value, spec[1], spec[2], "SoundService." .. name)
			count += 1
		end
		if count == 0 then V.fail("INPUT", "Set at least one soundService property.") end
		extras.soundService, extras.soundValues, extras.any = self.gameModel:GetService("SoundService"), decoded, true
	end
	return extras
end

-- Runs inside environment()'s rollback pcall: every successful write registers its revert first.
function Operations:applyEnvironmentExtras(extras: any, reverts: {any}, before: any, after: any): ()
	local function setting(target: any, property: string, value: any, manual: string): ()
		local readable, prior = pcall(function(): any return target[property] end)
		if not readable then V.fail("STUDIO_SETTING", "Studio did not let the plugin read " .. manual) end
		-- A refused write changed nothing; only a performed write registers its revert.
		if not pcall(function() target[property] = value end) then V.fail("STUDIO_SETTING", "Studio did not let the plugin set " .. manual) end
		table.insert(reverts, {target = target, name = property, value = prior})
		local readback, actual = pcall(function(): any return target[property] end)
		if not readback or actual ~= value then V.fail("STUDIO_SETTING", "Studio did not keep the plugin's value for " .. manual) end
		before[property == "Technology" and "technology" or "terrainDecoration"] = if typeof(prior) == "EnumItem" then prior.Name else prior
	end
	if extras.technology then
		setting(extras.lighting, "Technology", extras.technology, "Lighting.Technology. In Studio select Lighting in the Explorer and set Technology to "
			.. extras.technology.Name .. " in the Properties window. No environment change was kept.")
		after.technology = extras.technology.Name
	end
	if extras.decoration ~= nil then
		setting(extras.terrain, "Decoration", extras.decoration, "Terrain.Decoration. In Studio select Workspace > Terrain and set Decoration in the Properties window. No environment change was kept.")
		after.terrainDecoration = extras.decoration
	end
	if extras.materials then
		local service, names = extras.materialService, V.array({})
		for _, spec in ipairs(extras.materials) do
			local variant = Instance.new("MaterialVariant")
			table.insert(reverts, {fn = function() variant:Destroy() end})
			variant.Name = spec.name
			for _, property in ipairs({"BaseMaterial", "StudsPerTile", "ColorMap", "NormalMap", "RoughnessMap", "MetalnessMap"}) do
				local value = spec.values[property]
				if value ~= nil and not setVerified(variant, property, value) then
					V.fail("STUDIO_SETTING", "Studio did not let the plugin set MaterialVariant." .. property .. ". Create the variant under MaterialService in Studio instead. No environment change was kept.")
				end
			end
			variant.Parent = service
			if spec.override then
				local base = spec.values.BaseMaterial
				local prior = service:GetBaseMaterialOverride(base)
				table.insert(reverts, {fn = function() service:SetBaseMaterialOverride(base, prior) end})
				service:SetBaseMaterialOverride(base, spec.name)
				if service:GetBaseMaterialOverride(base) ~= spec.name then V.fail("VERIFY", "MaterialService did not take the " .. spec.name .. " override.") end
			end
			table.insert(names, spec.name)
		end
		before.materials, after.materials = "created", names
	end
	if extras.soundValues then
		local service, prior, applied = extras.soundService, {}, {}
		local names: {string} = {}
		for name in pairs(extras.soundValues) do table.insert(names, name) end
		table.sort(names)
		for _, name in ipairs(names) do
			local value = extras.soundValues[name]
			local readable, old = pcall(function(): any return service[name] end)
			if not readable then V.fail("STUDIO_SETTING", "Studio did not let the plugin read SoundService." .. name .. ". No environment change was kept.") end
			if not pcall(function() service[name] = value end) then
				V.fail("STUDIO_SETTING", "Studio did not let the plugin set SoundService." .. name .. ". In Studio select SoundService in the Explorer and set it in the Properties window. No environment change was kept.")
			end
			table.insert(reverts, {target = service, name = name, value = old})
			local readback, actual = pcall(function(): any return service[name] end)
			local matches = readback and (if type(value) == "number" then type(actual) == "number" and math.abs(actual - value) <= 0.001 else actual == value)
			if not matches then V.fail("VERIFY", "SoundService." .. name .. " did not take the requested value.") end
			prior[name] = if typeof(old) == "EnumItem" then old.Name else old
			applied[name] = if typeof(value) == "EnumItem" then value.Name else value
		end
		before.soundService, after.soundService = prior, applied
	end
end

function Operations:environment(command: any, args: any, guard: () -> ()): any
	local allowed = {"terrain", "technology", "terrainDecoration", "materials", "soundService"}
	for _, section in ipairs(ENVIRONMENT_SECTIONS) do table.insert(allowed, section.key) end
	V.fields(args, allowed, "environment arguments")
	local fills: {any} = {}
	local terrain: any = nil
	if args.terrain ~= nil then
		local workspace = self.registry:root("Workspace")
		for _, child in ipairs(workspace:GetChildren()) do if child.ClassName == "Terrain" then terrain = child end end
		if not terrain then V.fail("TERRAIN", "Workspace has no Terrain object.") end
		local volume = 0
		for _, raw in ipairs(V.list(args.terrain, 128, "terrain shapes")) do
			local shape = V.object(raw, "terrain shape")
			local center = buildTriple(shape.center, -100000, 100000, "terrain center")
			local material = V.enum(shape.material, TERRAIN_MATERIALS, Enum.Material, "terrain material")
			local fill: any = {shape = shape.shape, material = material, center = center}
			if shape.shape == "Ball" then
				V.fields(shape, {"shape", "material", "center", "radius"}, "terrain ball")
				fill.radius = V.number(shape.radius, 1, 1024, "terrain radius")
				volume += 4 / 3 * math.pi * fill.radius ^ 3
			elseif shape.shape == "Cylinder" then
				V.fields(shape, {"shape", "material", "center", "radius", "height", "orientation"}, "terrain cylinder")
				fill.radius = V.number(shape.radius, 1, 1024, "terrain radius")
				fill.height = V.number(shape.height, 1, 2048, "terrain height")
				fill.orientation = if shape.orientation == nil then nil else buildTriple(shape.orientation, -360, 360, "terrain orientation")
				volume += math.pi * fill.radius ^ 2 * fill.height
			elseif shape.shape == "Block" or shape.shape == "Wedge" then
				V.fields(shape, {"shape", "material", "center", "size", "orientation"}, "terrain block")
				fill.size = buildTriple(shape.size, 1, 2048, "terrain size")
				fill.orientation = if shape.orientation == nil then nil else buildTriple(shape.orientation, -360, 360, "terrain orientation")
				volume += fill.size[1] * fill.size[2] * fill.size[3]
			else
				V.fail("INPUT", "Terrain shape must be Block, Ball, Cylinder or Wedge.")
			end
			table.insert(fills, fill)
		end
		if #fills == 0 then V.fail("INPUT", "Choose at least one terrain shape.") end
		if volume > 400000000 then V.fail("BODY_LIMIT", "Terrain fills exceed the bounded volume.") end
	end
	local lighting: any = nil
	local changes: {any} = {}
	for _, section in ipairs(ENVIRONMENT_SECTIONS) do
		local values = args[section.key]
		if values ~= nil then
			lighting = lighting or self.registry:root("Lighting")
			local names: {string} = {}
			for name in pairs(section.props) do table.insert(names, name) end
			V.fields(values, names, section.key)
			local decoded: {[string]: any} = {}
			local count = 0
			for name, value in pairs(values) do
				decoded[name] = environmentValue(value, section.props[name], section.key .. "." .. name)
				count += 1
			end
			if count == 0 then V.fail("INPUT", "Set at least one " .. section.key .. " property.") end
			local target: any = if section.className then nil else lighting
			if section.className then
				for _, child in ipairs(lighting:GetChildren()) do if child.ClassName == section.className then target = child; break end end
			end
			table.insert(changes, {key = section.key, className = section.className, target = target, values = decoded})
		end
	end
	local extras = self:environmentExtras(args)
	if #fills == 0 and #changes == 0 and not extras.any then V.fail("INPUT", "Choose terrain shapes or lighting/effect settings.") end
	local subject = lighting or terrain or extras.subject
	return self:record(command, guard, function(progress: any): any
		guard()
		local created: {any} = {}
		local reverts: {any} = {}
		local before: {[string]: any} = {}
		local after: {[string]: any} = {}
		local ok, failure = pcall(function()
			for _, change in ipairs(changes) do
				local snapshot: {[string]: any} = {}
				if change.target then
					for name in pairs(change.values) do snapshot[name] = environmentEncode(change.target[name]) end
					before[change.key] = snapshot
				else
					change.target = Instance.new(change.className)
					change.target.Name = change.className
					change.created = true
					table.insert(created, change.target)
					before[change.key] = "created"
				end
				local applied: {[string]: any} = {}
				for name, value in pairs(change.values) do
					if not change.created then table.insert(reverts, {target = change.target, name = name, value = change.target[name]}) end
					change.target[name] = value
					if not environmentMatches(change.target[name], value) then V.fail("VERIFY", change.key .. "." .. name .. " did not take the requested value.") end
					applied[name] = environmentEncode(value)
				end
				after[change.key] = applied
			end
			if extras.any then self:applyEnvironmentExtras(extras, reverts, before, after) end
			guard()
		end)
		if not ok then
			local reverted = pcall(function()
				for index = #reverts, 1, -1 do
					local revert = reverts[index]
					if revert.fn then revert.fn() else revert.target[revert.name] = revert.value end
				end
			end)
			for _, instance in ipairs(created) do pcall(function() instance:Destroy() end) end
			if not reverted then progress.touched = true end
			error(failure, 0)
		end
		progress.touched = true
		for _, fill in ipairs(fills) do
			local center = Vector3.new(fill.center[1], fill.center[2], fill.center[3])
			local o = fill.orientation or {0, 0, 0}
			local cframe = CFrame.new(center.X, center.Y, center.Z) * CFrame.fromOrientation(math.rad(o[1]), math.rad(o[2]), math.rad(o[3]))
			if fill.shape == "Ball" then terrain:FillBall(center, fill.radius, fill.material)
			elseif fill.shape == "Cylinder" then terrain:FillCylinder(cframe, fill.height, fill.radius, fill.material)
			elseif fill.shape == "Wedge" then terrain:FillWedge(cframe, Vector3.new(fill.size[1], fill.size[2], fill.size[3]), fill.material)
			else terrain:FillBlock(cframe, Vector3.new(fill.size[1], fill.size[2], fill.size[3]), fill.material) end
		end
		for _, instance in ipairs(created) do instance.Parent = lighting end
		local ref = self.registry:ref(subject)
		progress.ref = ref
		after.terrainShapes = #fills
		return {ref = ref, mutation = {kind = "environment.apply", ref = ref, before = before, after = after}}
	end)
end

-- terrain.generate: validate and compute the whole field before recording, then WriteVoxels in
-- bounded chunks, yielding between chunks. One undo recording; reverted with Studio Undo.
function Operations:terrainGenerate(command: any, args: any, guard: () -> ()): any
	local plan = TerrainGen.plan(args)
	local terrain: any = nil
	for _, child in ipairs(self.registry:root("Workspace"):GetChildren()) do if child.ClassName == "Terrain" then terrain = child end end
	if not terrain then V.fail("TERRAIN", "Workspace has no Terrain object.") end
	local names = table.clone(TerrainGen.MATERIALS)
	table.insert(names, "Air"); table.insert(names, "Water")
	local enums: {[string]: any} = {}
	local function resolve(name: string): any
		local item = enums[name]
		if item == nil then item = V.enum(name, names, Enum.Material, "terrain material"); enums[name] = item end
		return item
	end
	resolve("Air"); resolve("Water"); resolve(plan.deep)
	-- Field synthesis is pure CPU before the recording opens; it yields between rows when long.
	guard()
	local slice = self:slicer(guard)
	local field = TerrainGen.field(plan, slice)
	for _, name in ipairs(field.materials) do if enums[name] == nil then resolve(name) end end
	return self:record(command, guard, function(progress: any): any
		guard()
		local chunks = TerrainGen.write(plan, field, {resolve = resolve,
			write = function(low: {number}, high: {number}, materials: any, occupancies: any): ()
				progress.touched = true
				terrain:WriteVoxels(Region3.new(Vector3.new(low[1], low[2], low[3]), Vector3.new(high[1], high[2], high[3])), 4, materials, occupancies)
			end,
			yield = function(): () slice(0) end, slice = slice})
		local ref = self.registry:ref(terrain)
		progress.ref = ref
		return {ref = ref, mutation = {kind = "terrain.generate", ref = ref, before = V.NULL, after = TerrainGen.summary(plan, field, chunks)}}
	end)
end

-- Read-only world-space axis-aligned bounds for viewport framing. Oriented part boxes are
-- expanded through their rotation; folders/services visit at most 5000 descendants.
function Operations:bounds(instance: any): any
	local low, high = {math.huge, math.huge, math.huge}, {-math.huge, -math.huge, -math.huge}
	local function box(cframe: any, size: any): ()
		local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cframe:GetComponents()
		local hx, hy, hz = size.X / 2, size.Y / 2, size.Z / 2
		local center = {x, y, z}
		local extent = {math.abs(r00) * hx + math.abs(r01) * hy + math.abs(r02) * hz,
			math.abs(r10) * hx + math.abs(r11) * hy + math.abs(r12) * hz, math.abs(r20) * hx + math.abs(r21) * hy + math.abs(r22) * hz}
		for axis = 1, 3 do
			low[axis] = math.min(low[axis], center[axis] - extent[axis])
			high[axis] = math.max(high[axis], center[axis] + extent[axis])
		end
	end
	if instance:IsA("Attachment") then
		local p = instance.WorldPosition
		box(CFrame.new(p.X, p.Y, p.Z), Vector3.new(1, 1, 1))
	elseif instance:IsA("BasePart") then
		box(instance.CFrame, instance.Size)
	elseif instance:IsA("Model") then
		local ok, cframe, size = pcall(function(): (any, any) return instance:GetBoundingBox() end)
		if not ok then V.fail("BOUNDS", "The Model has no physical parts to frame.") end
		box(cframe, size)
	else
		local queue, head = {instance}, 1
		while head <= #queue and head <= 5000 do
			local item = queue[head]
			head += 1
			if item ~= instance and item:IsA("BasePart") then box(item.CFrame, item.Size) end
			for _, child in ipairs(item:GetChildren()) do if #queue < 5000 then table.insert(queue, child) end end
		end
	end
	if low[1] == math.huge then V.fail("BOUNDS", "The instance has no physical parts to frame.") end
	for axis = 1, 3 do V.number(low[axis], -100000, 100000, "bounds"); V.number(high[axis], -100000, 100000, "bounds") end
	return {center = V.array({(low[1] + high[1]) / 2, (low[2] + high[2]) / 2, (low[3] + high[3]) / 2}),
		size = V.array({high[1] - low[1], high[2] - low[2], high[3] - low[3]}), space = "world-aabb"}
end

-- Remove exact instances or reset Workspace through one Studio Undo recording.
-- No arbitrary code, root destruction, uploads or automatic broad undo.
function Operations:remove(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"mode", "refs"}, "scene removal")
	if args.mode ~= "refs" and args.mode ~= "workspace" then V.fail("INPUT", "Choose refs or workspace removal.") end
	local workspace = self.registry.services.Workspace
	if args.mode == "workspace" then workspace = self.registry:root("Workspace") end
	local camera = if workspace then workspace.CurrentCamera else nil
	local terrain: any = nil
	local targets, parents = {}, {}
	if args.mode == "workspace" then
		if args.refs ~= nil then V.fail("INPUT", "Workspace reset does not take refs.") end
		terrain = workspace:FindFirstChildOfClass("Terrain")
		if terrain == nil or type(terrain.Clear) ~= "function" then V.fail("CAPABILITY", "Workspace Terrain.Clear is unavailable.") end
		for _, instance in ipairs(workspace:GetChildren()) do
			if instance ~= terrain and instance ~= camera then targets[#targets + 1] = instance end
		end
		if #targets > V.REMOVE_LIMITS.topLevel then V.fail("BODY_LIMIT", "Workspace reset exceeds the top-level instance limit.") end
	else
		local refs = V.list(args.refs, V.REMOVE_LIMITS.targets, "removal refs")
		if #refs == 0 then V.fail("INPUT", "Choose at least one removal target.") end
		for _, ref in ipairs(refs) do targets[#targets + 1] = self.registry:resolve(ref) end
	end
	local seen, count = {}, 0
	local slice = self:slicer(guard)
	local function protected(instance: any): boolean
		local root = self.registry:rootOf(instance)
		return (workspace ~= nil and instance == workspace.CurrentCamera) or instance:IsA("Terrain") or root == nil or instance == self.registry:root(root)
			or (instance.ClassName == "Folder" and string.sub(instance.Name, 1, 16) == "ArcaneTestProof_")
	end
	for index, instance in ipairs(targets) do
		guard()
		if seen[instance] then V.fail("INPUT", "Removal targets must be distinct.") end
		seen[instance] = true
		if protected(instance) then V.fail("PROTECTED", "A removal target is an engine root, active camera, Terrain or connection witness.") end
		local children = instance:GetDescendants()
		count += #children + 1
		if count > V.REMOVE_LIMITS.descendants then V.fail("BODY_LIMIT", "Removal exceeds the instance limit.") end
		for _, child in ipairs(children) do
			if protected(child) then V.fail("PROTECTED", "A removal target contains protected connection or engine state.") end
			slice(1)
		end
		parents[index] = instance.Parent
		slice(#children + 1)
	end
	if args.mode == "refs" then for index, instance in ipairs(targets) do
		for other = index + 1, #targets do
			if instance:IsDescendantOf(targets[other]) or targets[other]:IsDescendantOf(instance) then V.fail("INPUT", "Remove an ancestor once; do not repeat its descendants.") end
		end
	end
	end
	local anchor = if args.mode == "workspace" then workspace else self.registry:root(self.registry:rootOf(targets[1]))
	local ref = self.registry:ref(anchor)
	local result = {ref = ref, removed = #targets, descendants = count, terrainCleared = terrain ~= nil, undo = "studio",
		mutation = {kind = "scene.remove", ref = ref, before = {targetCount = #targets, descendants = count},
			after = {removed = #targets, descendants = count, terrainCleared = terrain ~= nil, undo = "studio"}}}
	if #V.encode(result, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Removal receipt exceeds its bound.") end
	return self:record(command, guard, function(progress: any): any
		for index, instance in ipairs(targets) do
			guard()
			if instance.Parent ~= parents[index] or protected(instance) then V.fail("CONFLICT", "A removal target moved or became protected before the change.") end
			for _, child in ipairs(instance:GetDescendants()) do
				if protected(child) then V.fail("CONFLICT", "A removal target gained protected state before the change.") end
			end
			progress.touched = true
			instance:Destroy()
			if instance.Parent ~= nil then V.fail("VERIFY", "A removal target remained parented.") end
			slice(1)
		end
		if terrain then guard(); progress.touched = true; terrain:Clear(); guard() end
		return result
	end)
end

function Operations:restore(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"receiptCommandId", "mutation"}, "restore arguments")
	local receiptId = V.string(args.receiptCommandId, "receipt command ID", 256)
	local original = self.mutations[receiptId]
	if not original or self.restored[receiptId] then V.fail("RECEIPT", "Receipt is unknown or already restored in this session.") end
	-- Do not trust a caller-supplied inverse, even on the paired daemon route.
	if not V.equal(original, args.mutation) then V.fail("RECEIPT", "Restoration payload differs from the immutable local receipt.") end
	if original.kind == "scene.remove" then V.fail("RESTORE", "Use Studio Undo to restore deleted instances and terrain.") end
	local instance = self.registry:resolve(original.ref)
	if self.registry:isService(instance) then V.fail("SERVICE", "Services cannot be restored by mutation.") end
	if original.kind == "scene.create" then
		local owned = self.registry.owned[instance]
		local function matches(): boolean
			return owned ~= nil and instance.Parent == owned.parent and #instance:GetChildren() == 0
				and V.equal(P.snapshot(instance), original.after.properties)
				and (owned.typedOwnership == nil or P.ownershipMatches(instance, self.collection, owned.typedOwnership))
				and V.equal(instance:GetAttributes(), owned.attributes)
				and V.equal(self.collection:GetTags(instance), owned.tags)
				and (owned.source == nil or self:source(instance) == owned.source)
				and (owned.enabled == nil or not instance.Disabled == owned.enabled)
		end
		if not matches() then V.fail("CONFLICT", "Created instance has changed, moved, or gained children; restoration refused.") end
		self:record(command, guard, function(progress: any): any
			guard()
			self.registry:resolve(original.ref)
			if not matches() then V.fail("CONFLICT", "Created instance changed before restoration.") end
			progress.ref = original.ref
			progress.touched = true
			instance:Destroy()
			return {restored = true, ref = original.ref}
		end)
	elseif original.kind == "scene.build" then
		local owned = self.registry.owned[instance]
		local build = owned and owned.build
		local function matches(): boolean
			if not build or instance.Parent ~= owned.parent then return false end
			for index, item in ipairs(build.instances) do
				if item.Parent ~= build.parents[index] or #item:GetChildren() ~= build.children[index] then return false end
				if not P.ownershipMatches(item, self.collection, build.snapshots[index]) then return false end
			end
			return true
		end
		if not matches() then V.fail("CONFLICT", "The built hierarchy changed, moved, or gained children; restoration refused.") end
		self:record(command, guard, function(progress: any): any
			guard()
			self.registry:resolve(original.ref)
			if not matches() then V.fail("CONFLICT", "The built hierarchy changed before restoration.") end
			progress.ref = original.ref
			progress.touched = true
			instance:Destroy()
			return {restored = true, ref = original.ref}
		end)
	elseif original.kind == "scene.update" then
		self:updateProperties(command, {ref = original.ref, expected = original.after.properties, properties = original.before.properties}, guard, true)
	elseif original.kind == "script.update" then
		self:updateSource(command, {ref = original.ref, expectedSource = original.after.source, source = original.before.source}, guard)
	elseif original.kind == "script.set_enabled" then
		self:setEnabled(command, {ref = original.ref, expectedSource = original.after.source, expectedEnabled = original.after.enabled, enabled = original.before.enabled}, guard)
	elseif original.kind == "scene.place_asset" or original.kind == "scene.apply_material" then
		AssetPlacement.restore(self, command, original, instance, guard)
	else V.fail("RECEIPT", "Unsupported mutation receipt.") end
	self.restored[receiptId] = true
	return {restored = true, ref = original.ref}
end

function Operations:execute(command: any, guard: () -> ()): any
	guard()
	local args = V.object(command.args, "arguments")
	local method = command.method
	local result: any
	if method == "scene.children" then result = self:children(args)
	elseif method == "asset.stage_packet" then result = self:stageAssetPacket(args, guard)
	elseif method == "asset.reconstruct" then return self:reconstructAsset(args, guard)
	elseif method == "asset.keep_mesh" then return self:keepReconstruction(args, guard)
	elseif method == "scene.import_context" then result = self:importContext(args)
	elseif method == "scene.upload_context" then result = self:uploadContext(args)
	elseif method == "scene.search" then result = self:search(args)
	elseif method == "script.search" then result = self:searchScripts(args, guard)
	elseif method == "scene.inspect" then
		V.fields(args, {"ref", "bounds"}, "inspect arguments")
		local instance = self.registry:resolve(args.ref)
		local node = self.registry:node(instance)
		node.properties = if LegacyProperties.GUI_SPECS[instance.ClassName] then LegacyProperties.snapshotGui(instance) else P.snapshot(instance)
		if args.bounds ~= nil then
			if args.bounds ~= true then V.fail("INPUT", "bounds must be true when present.") end
			node.bounds = self:bounds(instance)
		end
		result = node
	elseif method == "selection.read" then
		V.fields(args, {}, "selection arguments")
		local items = V.array({})
		for _, instance in ipairs(self.selection:Get()) do
			if self.registry:rootOf(instance) then
				if #items >= 200 then V.fail("BODY_LIMIT", "Selection exceeds 200 granted instances.") end
				table.insert(items, self.registry:node(instance))
			end
		end
		result = {items = items}
	elseif method == "script.read" then
		V.fields(args, {"ref"}, "read arguments")
		local instance = self.registry:resolve(args.ref)
		result = {ref = self.registry:ref(instance), source = self:source(instance)}
		if instance:IsA("BaseScript") then result.enabled = not instance.Disabled end
	elseif method == "scene.create" then result = self:create(command, args, guard)
	elseif method == "scene.remove" then result = self:remove(command, args, guard)
	elseif method == "scene.build" then result = self:build(command, args, guard)
	elseif method == "environment.apply" then result = self:environment(command, args, guard)
	elseif method == "terrain.generate" then result = self:terrainGenerate(command, args, guard)
	elseif method == "scene.update" then result = self:updateProperties(command, args, guard)
	elseif method == "script.update" then result = self:updateSource(command, args, guard)
	elseif method == "script.set_enabled" then result = self:setEnabled(command, args, guard)
	elseif method == "scene.restore" then result = self:restore(command, args, guard)
	elseif method == "scene.asset_watch" then V.fields(args, {}, "watch arguments"); result = AssetPlacement.watch(self)
	elseif method == "scene.place_asset" then result = AssetPlacement.place(self, command, args, guard)
	elseif method == "scene.apply_material" then result = AssetPlacement.applyMaterial(self, command, args, guard)
	else V.fail("METHOD", "Unsupported Studio method.") end
	if not table.find(V.WRITE_METHODS, method) then guard() end
	if #V.encode(result, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Result exceeds 512 KiB.") end
	result = V.immutable(result)
	if result.mutation then self.mutations[command.id] = result.mutation end
	return result
end

return Operations
