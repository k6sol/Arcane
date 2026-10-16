--!strict
local V = require(script.Parent.Validation)
local LegacyProperties = require(script.Parent.Properties)
local P = V.geometryProperties(LegacyProperties)
local Registry = require(script.Parent.Registry)
local AssetTransfer = require(script.Parent.AssetTransfer)
local Operations = {}
Operations.__index = Operations
type Operations = any
-- Engine objects never enter command data or public fields. This private owner
-- retains exact meshes until retirement; receiver ownership ends at reconstruct.
local assetOwners: {[any]: any} = setmetatable({}, {__mode = "k"})

local function cleanupFailure(): never
	error(table.freeze({code = "CLEANUP", message = "Owned editable meshes may remain; reconnect cannot establish cleanup.",
		unsafe = true, recovery = table.freeze({partial = true, imported = false, engineVerification = "pending"})}), 0)
end

function Operations.new(pair: any, gameModel: any, http: any, assetProgress: (() -> ())?): Operations
	return setmetatable({registry = Registry.new(pair.sessionId, pair.allowedRoots, gameModel, http),
		gameModel = gameModel, assetTransfers = {}, assetProgress = assetProgress,
		http = http, editor = gameModel:GetService("ScriptEditorService"),
		history = gameModel:GetService("ChangeHistoryService"), selection = gameModel:GetService("Selection"),
		collection = gameModel:GetService("CollectionService"), mutations = {}, restored = {}}, Operations)
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
	local owner: any = {runId = runId, meshes = {}, retired = false, finished = false, target = owned.target, continuity = owned.continuity}
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
		for _, entry in ipairs(entries) do owner.meshes[#owner.meshes + 1] = {mesh = entry.mesh.editableMesh, disposed = false} end
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

function Operations:updateProperties(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"ref", "expected", "properties"}, "update arguments")
	local instance = self.registry:resolve(args.ref)
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

function Operations:create(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"parent", "className", "name", "properties"}, "create arguments")
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

function Operations:restore(command: any, args: any, guard: () -> ()): any
	V.fields(args, {"receiptCommandId", "mutation"}, "restore arguments")
	local receiptId = V.string(args.receiptCommandId, "receipt command ID", 256)
	local original = self.mutations[receiptId]
	if not original or self.restored[receiptId] then V.fail("RECEIPT", "Receipt is unknown or already restored in this session.") end
	-- Do not trust a caller-supplied inverse, even on the paired daemon route.
	if not V.equal(original, args.mutation) then V.fail("RECEIPT", "Restoration payload differs from the immutable local receipt.") end
	local instance = self.registry:resolve(original.ref)
	if self.registry:isService(instance) then V.fail("SERVICE", "Services cannot be restored by mutation.") end
	if original.kind == "scene.create" then
		local owned = self.registry.owned[instance]
		local function matches(): boolean
			return owned ~= nil and instance.Parent == owned.parent and #instance:GetChildren() == 0
				and V.equal(P.snapshot(instance), original.after.properties)
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
	elseif original.kind == "scene.update" then
		self:updateProperties(command, {ref = original.ref, expected = original.after.properties, properties = original.before.properties}, guard)
	elseif original.kind == "script.update" then
		self:updateSource(command, {ref = original.ref, expectedSource = original.after.source, source = original.before.source}, guard)
	elseif original.kind == "script.set_enabled" then
		self:setEnabled(command, {ref = original.ref, expectedSource = original.after.source, expectedEnabled = original.after.enabled, enabled = original.before.enabled}, guard)
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
	elseif method == "scene.import_context" then result = self:importContext(args)
	elseif method == "scene.upload_context" then result = self:uploadContext(args)
	elseif method == "scene.search" then result = self:search(args)
	elseif method == "script.search" then result = self:searchScripts(args, guard)
	elseif method == "scene.inspect" then
		V.fields(args, {"ref"}, "inspect arguments")
		local instance = self.registry:resolve(args.ref)
		local node = self.registry:node(instance)
		node.properties = P.snapshot(instance)
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
	elseif method == "scene.update" then result = self:updateProperties(command, args, guard)
	elseif method == "script.update" then result = self:updateSource(command, args, guard)
	elseif method == "script.set_enabled" then result = self:setEnabled(command, args, guard)
	elseif method == "scene.restore" then result = self:restore(command, args, guard)
	else V.fail("METHOD", "Unsupported Studio method.") end
	if not table.find(V.WRITE_METHODS, method) then guard() end
	if #V.encode(result, self.http) > V.RESULT_BYTES then V.fail("BODY_LIMIT", "Result exceeds 512 KiB.") end
	result = V.immutable(result)
	if result.mutation then self.mutations[command.id] = result.mutation end
	return result
end

return Operations
