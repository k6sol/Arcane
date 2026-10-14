--!strict
-- Host composition only; deliberately not registered as a plugin command.
-- API checked 2026-10-14:
-- https://create.roblox.com/docs/reference/engine/classes/AssetService#CreateAssetAsync
-- https://create.roblox.com/docs/reference/engine/classes/Object#IsA
-- CreateAssetAsync returns (Enum.CreateAssetResult, assetIdOrError), not a bool.
--
-- Contract for the durable host controller:
--   new(injectedAssetService, injectedEnum, trustedCallbacks): Uploader
--   uploader:upload(frozenTicket, callerOwnedEditableResource): Outcome
--   uploader:status(attemptId): Outcome? -- inspection only, never resumes work
-- Ticket and all nested records must be plain, frozen records with exactly the
-- fields below. They are metadata, NOT native actor identity, consent, ownership
-- or rights. JSON, hashes, creator IDs and booleans cannot establish admission.
-- The host closes over its actual actor/consent/job/session/continuity authority;
-- assertAdmission must check that authority AND the exact borrowed resource.
-- liveGuard must synchronously recheck its continuing validity. Both assertions
-- return NOTHING on admission and throw otherwise; boolean substitutes fail.
-- Assertions must not yield. Journal callbacks may yield. All input metadata,
-- callback references, enum items and the engine method are snapshotted first.
-- The resource reference is borrowed, not copied: the caller must hold its
-- contents stable and retain exclusive lifetime ownership across these yields.
-- This module never destroys, parents, allocates, edits or takes that resource.
--
-- recordIntent(ticket) must durably consume the complete exact ticket before
-- acknowledging {phase="intent", ticket=exactFrozenTicket}. recordResult(ticket,
-- observation) must durably record the observed ID before acknowledging
-- {phase="result", ticket=exactFrozenTicket, assetId=observation.assetId}.
-- ACK matching includes attemptId/source/assetType/creator/uploader/continuity
-- AND name/description. An echo or an ACK alone never establishes admission.
-- Both ACKs are plain frozen records. Their provenance is the trusted callback,
-- not their data shape; this module cannot verify actual durable storage.
-- Result journaling runs BEFORE the final guard after observed success:
-- facts about an already-created asset must survive retirement of admission.
-- Unknown engine outcomes/ACK loss/late scope changes return reconciliation.
-- A known successful asset ID is retained even when its result journal is
-- unknown (resultJournalState="unknown"). Only state="succeeded" allows host continuation, with a fresh guard
-- again at any later import boundary; reconciliation must never continue.
-- Never retry an upload, even after a definitive rejection. An attempt is
-- latched before callbacks run, shared across uploader instances, never evicted.
-- The latch is MODULE-LIFETIME ONLY. The host must enforce durable non-replay
-- across reload/restart and must reconcile incomplete intents, not reissue them
-- under the same or a replacement attempt ID for that logical upload.

export type Creator = {read kind: "user" | "group", read id: number}
-- source.resourceId identifies the particular reconstructed mesh/image, not
-- its display name. The host binds these correlation fields to admitted data.
export type Source = {read jobId: string, read resourceId: string, read sha256: string}
-- This is the separate observed uploader, never inferred from place ownership.
-- Its presence/provenance string is metadata, not verified native identity.
export type UploaderObservation = {read status: "available", read id: number, read provenance: "StudioService:GetUserId"}
export type Continuity = {
	read sessionId: string, read clientLifetimeId: string, read pluginArtifactHash: string,
	read playEpoch: number, read placeId: number, read universeId: number,
}
export type Ticket = {
	read attemptId: string, read assetType: "Mesh" | "Image", read creator: Creator,
	read source: Source, read uploader: UploaderObservation, read continuity: Continuity,
	read name: string, read description: string,
}
export type IntentAck = {read phase: "intent", read ticket: Ticket}
export type ResultAck = {read phase: "result", read ticket: Ticket, read assetId: number}
export type Observation = {read attemptId: string, read assetId: number}
export type Outcome = {
	read attemptId: string, read state: "running" | "succeeded" | "failed" | "reconciliation",
	read phase: string, read reason: string?, read assetId: number?,
	read uploadStarted: boolean, read intentAcknowledged: boolean, read resultAcknowledged: boolean,
	read intentJournalState: "not_started" | "unknown" | "acknowledged",
	read resultJournalState: "not_started" | "unknown" | "acknowledged",
	read scopeLost: boolean, read retryable: false,
}
export type Callbacks = {
	assertAdmission: (Ticket, EditableMesh | EditableImage) -> (),
	liveGuard: (Ticket, EditableMesh | EditableImage) -> (),
	recordIntent: (Ticket) -> IntentAck,
	recordResult: (Ticket, Observation) -> ResultAck,
}
export type EngineEnums = {
	AssetType: any, AssetCreatorType: any, CreateAssetResult: any,
}
export type Uploader = {
	upload: (self: Uploader, Ticket, EditableMesh | EditableImage) -> Outcome,
	status: (self: Uploader, string) -> Outcome?,
}

-- Module bounds, not a statement of Roblox's metadata limits or upload quotas.
local LIMITS = table.freeze({attempts = 256, attemptIdBytes = 128,
	nameBytes = 200, nameCodepoints = 50, descriptionBytes = 4096, descriptionCodepoints = 1000,
	maximumId = 9007199254740991})
local AssetUpload = {LIMITS = LIMITS}
local TICKET_FIELDS = table.freeze({attemptId = true, assetType = true, creator = true, source = true,
	uploader = true, continuity = true, name = true, description = true})
local CREATOR_FIELDS = table.freeze({kind = true, id = true})
local SOURCE_FIELDS = table.freeze({jobId = true, resourceId = true, sha256 = true})
local UPLOADER_FIELDS = table.freeze({status = true, id = true, provenance = true})
local CONTINUITY_FIELDS = table.freeze({sessionId = true, clientLifetimeId = true, pluginArtifactHash = true,
	playEpoch = true, placeId = true, universeId = true})
local CALLBACK_FIELDS = table.freeze({assertAdmission = true, liveGuard = true, recordIntent = true, recordResult = true})
local ENUM_FIELDS = table.freeze({AssetType = true, AssetCreatorType = true, CreateAssetResult = true})
local attempts: {[string]: any} = {}
local attemptCount = 0

local function fail(code: string, message: string): never
	error(table.freeze({code = code, message = message}), 0)
end

local function record(value: any, fields: {[string]: boolean}, frozen: boolean): any
	if type(value) ~= "table" or getmetatable(value) ~= nil or (frozen and not table.isfrozen(value)) then
		fail("INPUT", "Expected a plain host record with the required immutability.")
	end
	for key in pairs(value) do
		if type(key) ~= "string" or not fields[key] then fail("INPUT", "Unsupported host record field.") end
	end
	return value
end

local function validId(value: any): boolean
	return type(value) == "number" and value == value and value >= 1 and value <= LIMITS.maximumId and value % 1 == 0
end

local function identifier(value: any): string
	if type(value) ~= "string" or #value > LIMITS.attemptIdBytes or not string.match(value, "^[A-Za-z0-9][A-Za-z0-9_.:%-]*$") then
		fail("INPUT", "Expected a bounded host correlation identifier.")
	end
	return value
end

local function digest(value: any): string
	if type(value) ~= "string" or #value ~= 64 or not string.match(value, "^[a-f0-9]+$") then fail("INPUT", "Invalid correlation digest.") end
	return value
end

local function natural(value: any): number
	if type(value) ~= "number" or value ~= value or value < 0 or value > LIMITS.maximumId or value % 1 ~= 0 then
		fail("INPUT", "Invalid continuity metadata number.")
	end
	return value
end

local function text(value: any, name: boolean): string
	local bytes = if name then LIMITS.nameBytes else LIMITS.descriptionBytes
	local characters = if name then LIMITS.nameCodepoints else LIMITS.descriptionCodepoints
	if type(value) ~= "string" or #value > bytes then fail("INPUT", "Invalid upload metadata text.") end
	local length = utf8.len(value)
	if not length or length > characters or (name and (length == 0 or not string.find(value, "%S"))) then
		fail("INPUT", "Invalid upload metadata text.")
	end
	for index = 1, #value do
		local byte = string.byte(value, index)
		if byte == 127 or (byte < 32 and (name or (byte ~= 9 and byte ~= 10 and byte ~= 13))) then
			fail("INPUT", "Invalid upload metadata control character.")
		end
	end
	return value
end

local function snapshot(value: any): Ticket
	value = record(value, TICKET_FIELDS, true)
	local id = identifier(value.attemptId)
	if value.assetType ~= "Mesh" and value.assetType ~= "Image" then fail("INPUT", "Only Mesh and Image uploads are supported.") end
	local creator = record(value.creator, CREATOR_FIELDS, true)
	if (creator.kind ~= "user" and creator.kind ~= "group") or not validId(creator.id) then fail("INPUT", "Invalid upload creator metadata.") end
	local source = record(value.source, SOURCE_FIELDS, true)
	local uploader = record(value.uploader, UPLOADER_FIELDS, true)
	if uploader.status ~= "available" or uploader.provenance ~= "StudioService:GetUserId" or not validId(uploader.id) then
		fail("INPUT", "An available separate uploader observation is required as metadata.")
	end
	local continuity = record(value.continuity, CONTINUITY_FIELDS, true)
	return table.freeze({attemptId = id, assetType = value.assetType,
		creator = table.freeze({kind = creator.kind, id = creator.id}),
		source = table.freeze({jobId = identifier(source.jobId), resourceId = identifier(source.resourceId), sha256 = digest(source.sha256)}),
		uploader = table.freeze({status = "available", id = uploader.id, provenance = "StudioService:GetUserId"}),
		continuity = table.freeze({sessionId = identifier(continuity.sessionId), clientLifetimeId = identifier(continuity.clientLifetimeId),
			pluginArtifactHash = digest(continuity.pluginArtifactHash), playEpoch = natural(continuity.playEpoch),
			placeId = natural(continuity.placeId), universeId = natural(continuity.universeId)}),
		name = text(value.name, true), description = text(value.description, false)})
end

local function enumItem(category: any, family: string, name: string): any
	local ok, item = pcall(function(): any return category[name] end)
	if not ok or typeof(item) ~= "EnumItem" or item.Name ~= name or item.EnumType ~= category
		or tostring(item.EnumType) ~= "Enum." .. family then fail("INPUT", "Expected the exact injected engine enum item.") end
	return item
end

local function resourceMatches(resource: any, assetType: string): boolean
	local class = if assetType == "Mesh" then "EditableMesh" else "EditableImage"
	local ok, matches = pcall(function(): boolean return resource.ClassName == class and resource:IsA(class) == true end)
	return ok and matches == true
end

local function acknowledge(value: any, ticket: Ticket, phase: string, assetId: number?): boolean
	if type(value) ~= "table" or getmetatable(value) ~= nil or not table.isfrozen(value) then return false end
	for key in pairs(value) do if key ~= "ticket" and key ~= "phase" and not (phase == "result" and key == "assetId") then return false end end
	if value.phase ~= phase or (phase == "result" and value.assetId ~= assetId) then return false end
	local ok, copy = pcall(snapshot, value.ticket)
	if not ok then return false end
	return copy.attemptId == ticket.attemptId and copy.assetType == ticket.assetType and copy.name == ticket.name and copy.description == ticket.description
		and copy.creator.kind == ticket.creator.kind and copy.creator.id == ticket.creator.id
		and copy.source.jobId == ticket.source.jobId and copy.source.resourceId == ticket.source.resourceId and copy.source.sha256 == ticket.source.sha256
		and copy.uploader.status == ticket.uploader.status and copy.uploader.id == ticket.uploader.id and copy.uploader.provenance == ticket.uploader.provenance
		and copy.continuity.sessionId == ticket.continuity.sessionId and copy.continuity.clientLifetimeId == ticket.continuity.clientLifetimeId
		and copy.continuity.pluginArtifactHash == ticket.continuity.pluginArtifactHash and copy.continuity.playEpoch == ticket.continuity.playEpoch
		and copy.continuity.placeId == ticket.continuity.placeId and copy.continuity.universeId == ticket.continuity.universeId
end

local function outcome(entry: any): Outcome
	return table.freeze({attemptId = entry.attemptId, state = entry.state, phase = entry.phase, reason = entry.reason,
		assetId = entry.assetId, uploadStarted = entry.uploadStarted, intentAcknowledged = entry.intentAcknowledged,
		resultAcknowledged = entry.resultAcknowledged, intentJournalState = entry.intentJournalState,
		resultJournalState = entry.resultJournalState, scopeLost = entry.scopeLost, retryable = false})
end

local function finish(entry: any, state: string, reason: string?): Outcome
	entry.state, entry.reason = state, reason
	if state == "succeeded" then entry.phase = "complete" end
	return outcome(entry)
end

local function assertion(callback: any, ticket: Ticket, resource: any): boolean
	local ok, result = pcall(callback, ticket, resource)
	return ok and result == nil
end

function AssetUpload.new(assetService: any, enums: EngineEnums, callbacks: Callbacks): Uploader
	enums = record(enums, ENUM_FIELDS, false)
	callbacks = record(callbacks, CALLBACK_FIELDS, false)
	for name in pairs(CALLBACK_FIELDS) do
		if type((callbacks :: any)[name]) ~= "function" then fail("INPUT", "Trusted host callbacks are required.") end
	end
	local meshes = enumItem(enums.AssetType, "AssetType", "Mesh")
	local images = enumItem(enums.AssetType, "AssetType", "Image")
	local users = enumItem(enums.AssetCreatorType, "AssetCreatorType", "User")
	local groups = enumItem(enums.AssetCreatorType, "AssetCreatorType", "Group")
	local success = enumItem(enums.CreateAssetResult, "CreateAssetResult", "Success")
	local ok, create = pcall(function(): any return assetService.CreateAssetAsync end)
	if not ok or type(create) ~= "function" then fail("INPUT", "An injected CreateAssetAsync service is required.") end
	local admit, guard, intentJournal, resultJournal = callbacks.assertAdmission, callbacks.liveGuard, callbacks.recordIntent, callbacks.recordResult
	local uploader = {}
	function uploader:status(attemptId: string): Outcome?
		local entry = attempts[attemptId]
		return if entry then outcome(entry) else nil
	end
	function uploader:upload(input: Ticket, resource: EditableMesh | EditableImage): Outcome
		local ticket = snapshot(input) -- No callback or engine call before this copy.
		if attempts[ticket.attemptId] then fail("ATTEMPT", "Attempt already consumed; inspect its journal and status. Never retry its upload.") end
		if attemptCount >= LIMITS.attempts then fail("CAPACITY", "Upload attempt capacity reached; no latch may be evicted or replayed.") end
		local entry: any = {attemptId = ticket.attemptId, state = "running", phase = "admission", uploadStarted = false,
			intentAcknowledged = false, resultAcknowledged = false, scopeLost = false,
			intentJournalState = "not_started", resultJournalState = "not_started"}
		attempts[ticket.attemptId] = entry
		attemptCount += 1
		if not resourceMatches(resource, ticket.assetType) then
			finish(entry, "failed", "INVALID_RESOURCE")
			fail("INPUT", "Expected the matching caller-owned editable resource.")
		end
		if not assertion(admit, ticket, resource) then return finish(entry, "reconciliation", "ADMISSION_FAILED") end
		entry.phase = "guard"
		if not assertion(guard, ticket, resource) then entry.scopeLost = true; return finish(entry, "reconciliation", "SCOPE_CHANGED") end
		entry.phase, entry.intentJournalState = "intent", "unknown"
		local saved, ack = pcall(intentJournal, ticket)
		if not saved or not acknowledge(ack, ticket, "intent", nil) then return finish(entry, "reconciliation", "INTENT_ACK_LOST") end
		entry.intentAcknowledged = true
		entry.intentJournalState = "acknowledged"
		-- A yielding durable write cannot preserve authority by itself.
		entry.phase = "admission"
		if not assertion(admit, ticket, resource) then return finish(entry, "reconciliation", "ADMISSION_CHANGED") end
		entry.phase = "guard"
		if not assertion(guard, ticket, resource) then entry.scopeLost = true; return finish(entry, "reconciliation", "SCOPE_CHANGED") end
		if not resourceMatches(resource, ticket.assetType) then return finish(entry, "reconciliation", "RESOURCE_CHANGED") end
		local parameters = {CreatorId = ticket.creator.id, CreatorType = if ticket.creator.kind == "user" then users else groups,
			Name = ticket.name, Description = ticket.description}
		entry.phase, entry.uploadStarted = "upload", true
		local called, result, idOrError = pcall(create, assetService, resource, if ticket.assetType == "Mesh" then meshes else images, parameters)
		if not called then return finish(entry, "reconciliation", "ENGINE_OUTCOME_UNKNOWN") end
		if typeof(result) ~= "EnumItem" or result.EnumType ~= success.EnumType then return finish(entry, "reconciliation", "INVALID_ENGINE_RESULT") end
		if result == success and not validId(idOrError) then return finish(entry, "reconciliation", "INVALID_ASSET_ID") end
		if result == success then entry.assetId = idOrError end
		if result ~= success then
			local stillLive = assertion(guard, ticket, resource)
			if not stillLive then entry.scopeLost = true end
			return finish(entry, if stillLive then "failed" else "reconciliation", if stillLive then "ENGINE_REJECTED" else "LATE_SCOPE_CHANGED")
		end
		entry.phase, entry.resultJournalState = "result", "unknown"
		local observation = table.freeze({attemptId = ticket.attemptId, assetId = entry.assetId})
		local journaled, resultAck = pcall(resultJournal, ticket, observation)
		entry.resultAcknowledged = journaled and acknowledge(resultAck, ticket, "result", entry.assetId)
		if entry.resultAcknowledged then entry.resultJournalState = "acknowledged" end
		if not assertion(guard, ticket, resource) then entry.scopeLost = true end
		if not entry.resultAcknowledged then return finish(entry, "reconciliation", "RESULT_ACK_LOST") end
		if entry.scopeLost then return finish(entry, "reconciliation", "LATE_SCOPE_CHANGED") end
		return finish(entry, "succeeded", nil)
	end
	return table.freeze(uploader)
end

return table.freeze(AssetUpload)
