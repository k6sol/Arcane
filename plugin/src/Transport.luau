--!strict
local V = require(script.Parent.Validation)
local Operations = require(script.Parent.Operations)
local TestProof = require(script.Parent.TestProof)
local Transport = {}
Transport.__index = Transport
Transport.POLL_SECONDS = 2
Transport.MAX_BACKOFF_SECONDS = 30
Transport.MAX_RECOVERY_ATTEMPTS = 8
-- Status is a read-only POST so the exact key never enters a URL. The daemon
-- must authenticate that key and inspect this exact client/identity without
-- creating a session, renewing a lease, dispatching work or returning a bearer.
local ROUTES = table.freeze({connect = "/v1/plugin/connect", status = "/v1/plugin/status", pair = "/v1/plugin/pair", poll = "/v1/plugin/poll", result = "/v1/plugin/result", disconnect = "/v1/plugin/disconnect"})
local IDENTITY_CHANGED = "Place identity changed; this session is fenced. Inspect receipts and explicitly connect again."
local ASSET_CLEANUP_FAILED = "Owned asset staging resources could not all be released. Inspect staging resources before reloading the plugin."
type Transport = any

function Transport.new(gameModel: any, onStatus: (any) -> (), artifactHash: string?): Transport
	local http = gameModel:GetService("HttpService")
	local clientSessionId = http:GenerateGUID(false)
	local proof = if artifactHash then TestProof.new(gameModel, clientSessionId, artifactHash) else nil
	return setmetatable({gameModel = gameModel, http = http, run = gameModel:GetService("RunService"),
		clientSessionId = clientSessionId, testProof = proof, onStatus = onStatus, generation = 0,
		pair = nil, desiredPair = nil, disconnectRequested = false, stopped = false,
		inFlight = false, started = false, failures = 0, cache = {}, cacheCount = 0,
		cacheBytes = 0, highEpoch = 0, pending = nil, blocked = false, identityFence = nil,
		recovery = nil, checkInput = nil, assetCleanupFailed = false}, Transport)
end

function Transport:isEdit(): boolean
	-- Edit RunService remains Stopped while a separate Play DataModel runs.
	-- Use the plugin-facing global lifecycle property for production admission.
	local ok, active = pcall(function(): any return self.gameModel:GetService("StudioTestService").EditModeActive end)
	if ok then return type(active) == "boolean" and active == true end
	return false
end

function Transport:status(state: string, detail: string, commandId: string?)
	if self.stopped then return end
	local changed = self.identityFence and self.identityFence.changed
	if changed and table.find({"connected", "executing", "retrying"}, state) then state, detail = "reconciliation", IDENTITY_CHANGED end
	if self.assetCleanupFailed then state, detail = "reconciliation", "CLEANUP: " .. ASSET_CLEANUP_FAILED end
	local pair = if self.pair and self.generation == self.pair.generation and not self.disconnectRequested and not changed and not self.assetCleanupFailed then self.pair else nil
	self.onStatus({state = state, detail = detail, commandId = commandId,
		sessionId = if pair then pair.sessionId else nil,
		allowedRoots = if pair then table.clone(pair.allowedRoots) else {},
		allowWrites = if pair then pair.allowWrites else false,
		clientSessionId = self.clientSessionId, editMode = self:isEdit()})
end

function Transport:dropIdentityFence(): ()
	local fence = self.identityFence
	self.identityFence = nil
	if fence then for _, connection in ipairs(fence.connections) do connection:Disconnect() end end
end

function Transport:invalidateIdentity(fence: any): ()
	fence.changed = true -- Sticky for this exchange/session, even if values revert.
	if self.identityFence == fence then
		self.blocked = true
	end
end

function Transport:observeIdentity(fence: any): boolean
	if not fence or self.identityFence ~= fence then return false end
	local identity = fence.identity
	local ok, matches = pcall(function(): boolean
		return self.gameModel.PlaceId == identity.placeId and self.gameModel.GameId == identity.universeId
			and self.gameModel.Name == identity.name
	end)
	if not fence.changed and (not ok or not matches) then self:invalidateIdentity(fence) end
	if fence.changed then self.blocked = true end
	return not fence.changed
end

function Transport:watchIdentity(identity: any): any
	self:dropIdentityFence()
	local fence: any = {identity = V.immutable(identity), changed = false, connections = {}}
	self.identityFence = fence
	-- Signals latch changes during yielding HTTP/editor calls, including a change
	-- back to the original value. Synchronous comparisons cover deferred signals.
	for _, property in ipairs({"PlaceId", "GameId", "Name"}) do
		table.insert(fence.connections, self.gameModel:GetPropertyChangedSignal(property):Connect(function()
			self:invalidateIdentity(fence)
			if self.identityFence == fence then self:status("reconciliation", IDENTITY_CHANGED) end
		end))
	end
	return fence
end

function Transport:checkIdentity(pair: any): ()
	if not pair or not self:observeIdentity(pair.identityFence) then V.fail("IDENTITY", IDENTITY_CHANGED) end
end


function Transport:forgetDesired(): ()
	local desired = self.desiredPair
	if desired then desired.code = nil; desired.apiKey = nil end
	self.desiredPair = nil
end

function Transport:forgetRecovery(): ()
	if self.recovery then self.recovery.apiKey = nil end
	self.recovery = nil
end

function Transport:checkAssetCleanup(): ()
	if self.assetCleanupFailed then V.fail("CLEANUP", ASSET_CLEANUP_FAILED) end
end

function Transport:disposeOperations(): ()
	local operations = self.operations
	-- Detach before synchronous cancellation so retirement cannot dispose twice.
	self.operations = nil
	if not operations then return end
	local ok = pcall(function() operations:cancelAssetTransfers() end)
	if not ok then
		-- Cancellation attempts every owned receiver, but cannot prove release on
		-- failure. An empty transfer table or fresh session is not reconciliation.
		self.assetCleanupFailed = true
		self.blocked = true
		self:forgetDesired()
		self:forgetRecovery()
	end
end

function Transport:requestConnect(apiKey: any, automatic: boolean?): ()
	if self.stopped then return end
	self:checkAssetCleanup()
	local origin = V.keyOrigin(apiKey)
	if not automatic and not self:isEdit() then V.fail("PLAY", "Stop playtesting before connecting.") end
	self.generation += 1
	self:forgetDesired()
	self:forgetRecovery()
	local intent = {url = origin, apiKey = apiKey, generation = self.generation,
		needsStatus = automatic == true, attempts = 0, sessionId = nil, fence = nil}
	self.recovery = intent
	if not automatic then self.desiredPair = {url = origin, apiKey = apiKey, generation = self.generation} end
	self.disconnectRequested = true
	self:status("connecting", "Connecting to the Arcane workbench.")
end

-- Compatibility entry point for legacy fixtures; never exposed by Main.
function Transport:requestPair(url: any, code: any): ()
	if self.stopped then return end
	self:checkAssetCleanup()
	local origin = V.url(url)
	local pairingCode = V.string(code, "pairing code", 128)
	if not self:isEdit() then V.fail("PLAY", "Stop playtesting before pairing.") end
	self.generation += 1 -- Immediately fences callbacks already waiting on Studio.
	self:forgetDesired()
	self:forgetRecovery()
	self.desiredPair = {url = origin, code = pairingCode, generation = self.generation}
	self.disconnectRequested = true
	self:status("pairing", "Pairing requested; waiting for the current request to finish.")
end

function Transport:requestDisconnect(): ()
	if self.stopped then return end
	self.generation += 1
	self:forgetDesired()
	self:forgetRecovery()
	self.disconnectRequested = true
	self:status("disconnecting", "Local writes are fenced; disconnecting from the daemon.")
end

function Transport:stop(): ()
	-- Unloading must not yield or launch a second network request. The daemon
	-- observes heartbeat loss; no token or session state is saved anywhere.
	if self.stopped then return end
	self.generation += 1
	self.stopped = true
	self:forgetDesired()
	self:forgetRecovery()
	self:dropIdentityFence()
	if self.testProof then self.testProof:stop() end
	if self.pair then self.pair.token = nil end
	self.pair = nil
	self:disposeOperations()
	self.pending = nil
	self.cache = {}
	self.cacheCount, self.cacheBytes, self.highEpoch = 0, 0, 0
	-- UI callbacks are fenced on unload; report a bounded local diagnostic and
	-- allow the rest of the unloading handler to finish even when release fails.
	if self.assetCleanupFailed then warn("CLEANUP: " .. ASSET_CLEANUP_FAILED) end
end

function Transport:post(url: string, route: string, payload: any, token: string?): any
	V.url(url)
	if not table.find({ROUTES.connect, ROUTES.status, ROUTES.pair, ROUTES.poll, ROUTES.result, ROUTES.disconnect}, route) then V.fail("URL", "Unsupported plugin route.") end
	if self.inFlight then V.fail("FLIGHT", "Another HTTP request is in flight.") end
	if route == ROUTES.poll then self:checkIdentity(self.pair) end
	local headers = { ["Content-Type"] = "application/json", ["Accept"] = "application/json" }
	if token then headers.Authorization = "Bearer " .. token end
	local body = V.encode(payload, self.http)
	if #body > V.RESULT_BYTES + 4096 then V.fail("BODY_LIMIT", "Request exceeds the transport bound.") end
	self.inFlight = true
	local ok, response = pcall(function()
		return self.http:RequestAsync({Url = url .. route, Method = "POST", Headers = headers, Body = body, Timeout = 10})
	end)
	self.inFlight = false
	if self.checkInput and not self.stopped then self.checkInput() end
	if self.identityFence then self:observeIdentity(self.identityFence) end
	if not ok then V.fail("NETWORK", "Loopback request failed or timed out.") end
	if type(response) ~= "table" or type(response.StatusCode) ~= "number" or type(response.Success) ~= "boolean" then V.fail("PROTOCOL", "Invalid HTTP response.") end
	-- Never inspect/follow Location, and never construct a URL from a response.
	-- RequestAsync documents Timeout, but no redirect-disable option. Native redirect
	-- behavior still needs a disposable-fixture check; see docs/build/PLUGIN.md.
	if response.StatusCode >= 300 and response.StatusCode < 400 then V.fail("REDIRECT", "Daemon returned a redirect; connection refused.") end
	local errorCode = nil
	if not response.Success and type(response.Body) == "string" and #response.Body <= 8192 then
		local decoded, errorBody = pcall(function() return V.decode(response.Body, self.http) end)
		if decoded and type(errorBody) == "table" then errorCode = errorBody.error end
	end
	if response.StatusCode == 401 or response.StatusCode == 403 then
		if route == ROUTES.status and errorCode ~= "KEY_REJECTED" then
			-- Older daemons route unknown plugin POSTs through bearer auth. Their
			-- generic AUTH is not evidence that this saved API key is invalid.
			V.fail("STATUS_UNAVAILABLE", "Daemon could not authenticate safe key status. Click Connect to connect explicitly.")
		end
		if route == ROUTES.connect or route == ROUTES.status then V.fail("KEY_REJECTED", "Arcane API key was rejected. Enter a new API key.") end
		if errorCode == "ORIGIN" or errorCode == "SCOPE" then V.fail("RECONCILE", "Daemon refused the session scope; inspect the connection.") end
		V.fail("REVOKED", "Session expired or was revoked; connect again.")
	end
	if route == ROUTES.status and (response.StatusCode == 400 or response.StatusCode == 404 or response.StatusCode == 405) then
		V.fail("STATUS_UNAVAILABLE", "Daemon does not support safe session status. Click Connect to connect explicitly.")
	end
	if (route == ROUTES.poll or route == ROUTES.result) and (response.StatusCode == 404 or response.StatusCode == 410) then
		V.fail("REVOKED", "Session no longer exists; checking fresh session status.")
	end
	-- The daemon reports restart/revocation as 409, not necessarily 401. Never
	-- mistake an unrelated receipt conflict for definitive session loss, or echo
	-- its untrusted message. Only inspect a bounded JSON error code.
	if (response.StatusCode == 400 or response.StatusCode == 409) and route ~= ROUTES.connect and route ~= ROUTES.pair and route ~= ROUTES.status then
		if table.find({"REVOKED", "EXPIRED", "SESSION"}, errorCode) then
			V.fail("REVOKED", "Session expired or was lost; checking fresh session status.")
		end
	end
	if response.StatusCode == 409 then V.fail("RECONCILE", "Daemon refused the session or receipt; inspect the command and connect again.") end
	if not response.Success then V.fail("NETWORK", "Daemon request failed (HTTP " .. tostring(response.StatusCode) .. ").") end
	if type(response.Body) ~= "string" or #response.Body > V.RESULT_BYTES + V.ARGUMENT_BYTES + 8192 then V.fail("BODY_LIMIT", "Daemon response exceeds the transport bound.") end
	local decoded, data = pcall(function() return V.decode(response.Body, self.http) end)
	if not decoded then V.fail("PROTOCOL", "Daemon response is not valid JSON.") end
	return V.object(data, "daemon response")
end

function Transport:clearSession(keepIdentity: boolean?): ()
	if self.testProof then self.testProof:disconnect() end
	if not keepIdentity then self:dropIdentityFence() end
	if self.pair then self.pair.token = nil end
	self.pair = nil
	self:disposeOperations()
	self.pending = nil
	self.cache = {}
	self.cacheCount, self.cacheBytes, self.highEpoch = 0, 0, 0
	self.blocked = self.assetCleanupFailed
	if self.assetCleanupFailed then self:status("reconciliation", "CLEANUP: " .. ASSET_CLEANUP_FAILED) end
end

function Transport:exchange(desired: any): ()
	if self.stopped or desired.generation ~= self.generation then desired.code = nil; desired.apiKey = nil; return end
	self:checkAssetCleanup()
	local capabilities = table.clone(V.READ_METHODS)
	for _, method in ipairs(V.WRITE_METHODS) do table.insert(capabilities, method) end
	for _, method in ipairs(V.ASSET_STAGE_METHODS or {}) do table.insert(capabilities, method) end
	local isKey = desired.apiKey ~= nil
	local payload: any = {
		protocolVersion = V.PROTOCOL,
		identity = {clientSessionId = self.clientSessionId, placeId = self.gameModel.PlaceId,
			universeId = self.gameModel.GameId, name = V.string(self.gameModel.Name, "place name", 200), pluginVersion = V.VERSION},
		capabilities = V.array(capabilities),
	}
	if isKey then payload.apiKey = desired.apiKey else payload.code = desired.code end
	local intent = self.recovery
	local fence = if intent and intent.fence then intent.fence else self:watchIdentity(payload.identity)
	if intent then intent.fence = fence; intent.needsStatus = true end
	if not self:observeIdentity(fence) then V.fail("IDENTITY", IDENTITY_CHANGED) end
	-- Recovery keeps the original identity pin, never recaptures another place.
	payload.identity = fence.identity
	desired.apiKey, desired.code = nil, nil
	local ok, result = pcall(function() return self:post(desired.url, if isKey then ROUTES.connect else ROUTES.pair, payload, nil) end)
	payload.apiKey, payload.code = nil, nil
	if not ok then error(result, 0) end
	V.fields(result, {"sessionId", "token", "protocolVersion", "allowedRoots", "allowWrites"}, "pair result")
	if result.protocolVersion ~= V.PROTOCOL then V.fail("PROTOCOL", "Unsupported daemon protocol.") end
	V.string(result.sessionId, "session ID", 256)
	V.string(result.token, "session token", 4096)
	result.allowedRoots = V.roots(result.allowedRoots)
	V.boolean(result.allowWrites, "write grant")
	-- Keep a late pair only long enough to revoke it in the single worker loop.
	result.url = desired.url
	result.generation = desired.generation
	result.identityFence = fence -- Pinned initial payload, never an ACK or later name.
	if self.stopped then result.token = nil; return end
	self.pair = result
	self.failures = 0
	if self.generation ~= desired.generation then self.disconnectRequested = true; return end
	if intent and self.recovery == intent then intent.sessionId = result.sessionId; intent.needsStatus = false; intent.attempts = 0 end
	self:checkIdentity(result) -- Before resolving any roots in the current engine.
	self.operations = Operations.new(result, self.gameModel, self.http, function(): () self:assetProgress() end)
	local editor = self.operations.editor
	-- Fence the yielding editor call's return before Operations can reread source.
	-- Existing operation/callback guards still own lease, baseline and recovery.
	self.operations.editor = {
		GetEditorSource = function(_self: any, instance: any): string
			self:checkIdentity(result)
			return editor:GetEditorSource(instance)
		end,
		UpdateSourceAsync = function(_self: any, instance: any, callback: any): ()
			self:checkIdentity(result)
			editor:UpdateSourceAsync(instance, callback)
			self:checkIdentity(result)
		end,
	}
	self:checkIdentity(result)
	if self.testProof then
		-- The mapping witness is editor metadata, but it is still an Instance.
		-- Read-only or narrower legacy grants must not create it outside scope.
		if result.allowWrites and table.find(result.allowedRoots, "ServerStorage") then self.testProof:bind(result.sessionId, true)
		else self.testProof:disconnect() end
	end
	self:status("connected", "Connected to this Studio window. " .. (if result.allowWrites then "Writes granted." else "Read only."))
end

function Transport:envelope(command: any): ()
	V.object(command, "command")
	local pair = self.pair
	if not pair or command.protocolVersion ~= V.PROTOCOL or command.sessionId ~= pair.sessionId
		or command.clientSessionId ~= self.clientSessionId or command.state ~= "dispatched" then
		V.fail("SESSION", "Command targets another session or has an invalid protocol/state.")
	end
	V.string(command.id, "command ID", 256)
	V.string(command.requestId, "request ID", 256)
	V.integer(command.leaseEpoch, 1, 9007199254740991, "lease epoch")
	local roots = V.roots(command.allowedRoots)
	if #roots ~= #pair.allowedRoots then V.fail("GRANT", "Command root grants differ from pairing.") end
	for _, root in ipairs(roots) do if not table.find(pair.allowedRoots, root) then V.fail("GRANT", "Command root is not granted.") end end
	if command.allowWrites ~= pair.allowWrites then V.fail("GRANT", "Command write grant differs from pairing.") end
	if not table.find(V.READ_METHODS, command.method) and not table.find(V.WRITE_METHODS, command.method)
		and not table.find(V.ASSET_STAGE_METHODS or {}, command.method) then V.fail("METHOD", "Unsupported Studio method.") end
	V.string(command.expiresAt, "command expiry", 64)
	V.object(command.args, "arguments")
	if #V.encode(command.args, self.http) > V.ARGUMENT_BYTES then V.fail("BODY_LIMIT", "Arguments exceed 256 KiB.") end
end

function Transport:guard(command: any, pair: any): ()
	if self.stopped or self.pair ~= pair or self.generation ~= pair.generation
		or self.disconnectRequested then V.fail("SESSION", "Local session was disconnected or replaced.") end
	self:checkIdentity(pair)
	if self.blocked then V.fail("SESSION", "Local session requires reconciliation.") end
	self:envelope(command)
	if command.leaseEpoch ~= self.highEpoch then V.fail("LEASE", "Command lease is stale.") end
	-- DateTime.fromIsoDate accepts UTC RFC3339 daemon timestamps.
	if not string.match(command.expiresAt, "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d.*Z$") then V.fail("LEASE", "Expiry must be a UTC timestamp.") end
	local ok, expires = pcall(function() return DateTime.fromIsoDate(command.expiresAt) end)
	if not ok or not expires or expires.UnixTimestampMillis <= DateTime.now().UnixTimestampMillis then V.fail("LEASE", "Command lease has expired.") end
	local staging = table.find(V.ASSET_STAGE_METHODS or {}, command.method) ~= nil
	if not staging and not self:isEdit() then V.fail("PLAY", "Commands are only available in Studio edit mode.") end
	if (table.find(V.WRITE_METHODS, command.method) or staging) and not pair.allowWrites then V.fail("GRANT", "Session is read only.") end
	if staging then
		-- One fresh snapshot per guard binds CPU staging to this exact Edit epoch.
		-- A second snapshot could accidentally mix two play lifetimes.
		local ok, proof = pcall(function(): any return if self.testProof then self.testProof:snapshot() else nil end)
		local continuity = command.args.continuity
		local identity = pair.identityFence.identity
		if not ok or type(proof) ~= "table" or type(continuity) ~= "table"
			or proof.sessionId ~= pair.sessionId or proof.mode ~= "Edit" or proof.connected ~= true or proof.continuitySupported ~= true
			or proof.placeId ~= identity.placeId or proof.universeId ~= identity.universeId
			or proof.clientLifetimeId ~= self.clientSessionId
			or type(proof.clientLifetimeId) ~= "string" or type(proof.pluginArtifactHash) ~= "string" or type(proof.playEpoch) ~= "number"
			or continuity.clientLifetimeId ~= proof.clientLifetimeId or continuity.pluginArtifactHash ~= proof.pluginArtifactHash
			or continuity.playEpoch ~= proof.playEpoch or not self:isEdit() then V.fail("SCOPE", "Asset staging Edit continuity changed or is unavailable.") end
	end
	if command.method == "asset.reconstruct" and self.assetEngineAdmitted then
		local renewal = self.assetRenewal
		local wall, monotonic = DateTime.now().UnixTimestampMillis, os.clock()
		if not renewal or renewal.commandId ~= command.id or renewal.leaseEpoch ~= command.leaseEpoch
			or wall < renewal.observedAt or wall >= renewal.expiresAt or monotonic < renewal.monotonicStartedAt or monotonic >= renewal.monotonicExpiresAt then
			V.fail("SCOPE", "Authenticated reconstruction renewal expired; no further engine work is admitted.")
		end
	end
end

-- The same single worker refreshes only its exact dispatched reconstruction.
-- Called from existing mesh batch yields; no parallel task or lease extension.
function Transport:assetProgress(): ()
	local command, pair = self.executingCommand, self.pair
	if not command or command.method ~= "asset.reconstruct" then return end
	self:guard(command, pair)
	local started = os.clock()
	if self.assetEngineAdmitted and self.assetProgressAt and started >= self.assetProgressAt and started - self.assetProgressAt < 2 then return end
	local proof = if self.testProof then self.testProof:snapshot() else nil
	self:guard(command, pair)
	self.assetProgressAt = started
	local response = self:post(pair.url, ROUTES.poll, {sessionId = pair.sessionId, observation = proof,
		executingCommand = {commandId = command.id, leaseEpoch = command.leaseEpoch}}, pair.token)
	V.fields(response, {"commands", "progress"}, "reconstruction progress")
	if #V.list(response.commands, 1, "progress commands") ~= 0 then V.fail("RECONCILE", "Reconstruction progress cannot dispatch new work.") end
	local progress = V.fields(response.progress, {"commandId", "leaseEpoch", "observedAt", "expiresAt"}, "progress renewal")
	if progress.commandId ~= command.id or progress.leaseEpoch ~= command.leaseEpoch then V.fail("RECONCILE", "Progress renewal belongs to another command or lease.") end
	local function timestamp(value: any): number
		if type(value) ~= "string" or #value > 64 or not string.match(value, "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$") then V.fail("SCOPE", "Progress renewal requires exact UTC timestamps.") end
		local parsed, result = pcall(function(): any return DateTime.fromIsoDate(value) end)
		if not parsed or not result or type(result.UnixTimestampMillis) ~= "number" then V.fail("SCOPE", "Progress renewal timestamp is unavailable.") end
		return result.UnixTimestampMillis
	end
	local observed, expires = timestamp(progress.observedAt), timestamp(progress.expiresAt)
	local elapsed, received = os.clock() - started, DateTime.now().UnixTimestampMillis
	if elapsed < 0 or elapsed >= 4 or observed > received or expires - observed ~= 6000 or received >= expires then
		V.fail("SCOPE", "Progress acknowledgement is stale or exceeded its bounded wait; no engine work is admitted.")
	end
	-- Candidate is checked BEFORE replacing the prior permit. Every subsequent
	-- reconstruction guard enforces both server UTC and request-start duration.
	self.assetRenewal = {commandId = command.id, leaseEpoch = command.leaseEpoch, observedAt = observed, expiresAt = expires,
		monotonicStartedAt = started, monotonicExpiresAt = started + 6}
	self.assetEngineAdmitted = true
	self:guard(command, pair)
end

function Transport:dispatch(command: any): ()
	self:checkIdentity(self.pair) -- Also fences the cached-receipt fast path.
	self:envelope(command)
	local fingerprint = V.encode(command, self.http)
	local cached = self.cache[command.id]
	if cached then
		if cached.fingerprint ~= fingerprint then V.fail("RECONCILE", "Command ID was reused with a different payload.") end
		self.pending = cached -- Resend the immutable receipt; never execute twice.
		return
	end
	if command.leaseEpoch <= self.highEpoch then V.fail("LEASE", "New command has an old lease epoch.") end
	-- Fail closed without evicting command IDs or unacknowledged receipts.
	if self.cacheCount >= V.MAX_RECEIPTS or self.cacheBytes + #fingerprint + V.RESULT_BYTES + 4096 > V.MAX_CACHE_BYTES then
		V.fail("CAPACITY", "Session receipt capacity reached; inspect receipts and connect again.")
	end
	self.highEpoch = command.leaseEpoch
	local pair = self.pair
	self.executingCommand, self.assetProgressAt, self.assetRenewal, self.assetEngineAdmitted = command, nil, nil, false
	self:status("executing", command.method, command.id)
	local ok, output = pcall(function()
		self:guard(command, pair)
		return self.operations:execute(command, function() self:guard(command, pair) end)
	end)
	self.executingCommand = nil
	if self.stopped then return end
	local unsafe = not ok and type(output) == "table" and output.unsafe == true
	local payload: any = {sessionId = pair.sessionId, commandId = command.id,
		state = if ok then "succeeded" else "failed"}
	if ok then payload.result = output
	else
		payload.error = V.safeError(output)
		if unsafe then payload.result = output.recovery end
	end
	local encoded = V.encode(payload, self.http)
	local entry = {fingerprint = fingerprint, body = V.immutable(payload), unsafe = unsafe, acknowledged = false}
	self.cache[command.id] = entry
	self.cacheCount += 1
	self.cacheBytes += #fingerprint + #encoded
	self.pending = entry
	if unsafe then self.blocked = true end
end

function Transport:recover(): number
	local intent = self.recovery
	if not intent or intent.generation ~= self.generation or self.stopped then return Transport.POLL_SECONDS end
	self:checkAssetCleanup()
	if not self:isEdit() then return Transport.MAX_BACKOFF_SECONDS end
	if intent.attempts >= Transport.MAX_RECOVERY_ATTEMPTS then
		self:forgetRecovery()
		self:status("reconciliation", "Automatic recovery paused after eight attempts. Click Connect to try again.")
		return Transport.MAX_BACKOFF_SECONDS
	end
	if not intent.fence then
		intent.fence = self:watchIdentity({clientSessionId = self.clientSessionId, placeId = self.gameModel.PlaceId,
			universeId = self.gameModel.GameId, name = V.string(self.gameModel.Name, "place name", 200), pluginVersion = V.VERSION})
	end
	if not self:observeIdentity(intent.fence) then V.fail("IDENTITY", IDENTITY_CHANGED) end
	intent.attempts += 1
	local payload = {protocolVersion = V.PROTOCOL, apiKey = intent.apiKey,
		identity = intent.fence.identity, sessionId = intent.sessionId}
	local ok, result = pcall(function() return self:post(intent.url, ROUTES.status, payload, nil) end)
	payload.apiKey = nil
	if self.stopped or self.recovery ~= intent or self.generation ~= intent.generation or self.disconnectRequested then return Transport.POLL_SECONDS end
	if not ok then error(result, 0) end
	if not self:observeIdentity(intent.fence) then V.fail("IDENTITY", IDENTITY_CHANGED) end
	V.fields(result, {"protocolVersion", "identity", "state", "sessionId"}, "session status")
	if result.protocolVersion ~= V.PROTOCOL or not V.equal(result.identity, intent.fence.identity) then
		V.fail("PROTOCOL", "Session status does not match the exact plugin identity.")
	end
	if result.state == "active" then
		V.string(result.sessionId, "session ID", 256)
		-- A lost connect ACK may have created this session. Status must never
		-- reveal its bearer; wait for definitive loss, never supersede it blindly.
		self:status("reconciliation", "A session already exists; checking status before another connection.")
		return math.min(Transport.MAX_BACKOFF_SECONDS, Transport.POLL_SECONDS * 2 ^ intent.attempts)
	end
	if result.state == "reconciliation" then V.fail("RECONCILE", "Daemon requires command reconciliation before connecting.") end
	if result.state == "lost" then
		V.string(result.sessionId, "session ID", 256)
		if intent.sessionId and result.sessionId ~= intent.sessionId then V.fail("PROTOCOL", "Session status targets another session.") end
	elseif result.state == "absent" then
		if result.sessionId ~= nil then V.fail("PROTOCOL", "Absent session status contains a session.") end
	else V.fail("PROTOCOL", "Unsupported session status.") end
	-- This status belongs to the current exact key and epoch, and was just read
	-- by the single worker. No old command, receipt, grant or token is reused.
	self:status("connecting", "Session loss confirmed; reconnecting to Arcane.")
	if self.recovery ~= intent or self.generation ~= intent.generation or self.disconnectRequested or not self:isEdit() then return Transport.POLL_SECONDS end
	self:exchange({url = intent.url, apiKey = intent.apiKey, generation = intent.generation})
	return Transport.POLL_SECONDS
end

function Transport:tick(): number
	if self.stopped then return Transport.POLL_SECONDS end
	if self.checkInput then self.checkInput() end
	if self.assetCleanupFailed then return Transport.MAX_BACKOFF_SECONDS end
	if self.disconnectRequested then
		local old = self.pair
		if old and old.token then
			-- Best effort revoke, never retry a disconnect forever while pairing.
			pcall(function() self:post(old.url, ROUTES.disconnect, {sessionId = old.sessionId}, old.token) end)
		end
		self:clearSession()
		self.disconnectRequested = false
		if not self.desiredPair then self:status("disconnected", "Disconnected. Enter your Arcane API key and click Connect.") end
	end
	if self.assetCleanupFailed then return Transport.MAX_BACKOFF_SECONDS end
	if self.desiredPair then
		local desired = self.desiredPair
		self.desiredPair = nil
		-- An uncertain exchange can only be followed by a fresh read-only status,
		-- never by replaying this handshake.
		local ok, err = pcall(function() self:exchange(desired) end)
		desired.code, desired.apiKey = nil, nil
		if not ok and desired.generation == self.generation then
			if type(err) == "table" and err.code == "KEY_REJECTED" then
				self:clearSession()
				self:forgetRecovery()
				self.generation += 1
				self:status("failed", "Arcane API key was rejected. Enter a new API key.")
			else
				if type(err) ~= "table" or err.code ~= "NETWORK" then self:forgetRecovery() end
				self:status(if type(err) == "table" and err.code == "IDENTITY" then "reconciliation" else "disconnected", V.safeError(err) .. " Click Connect to try again.")
			end
		end
		return if not ok then Transport.MAX_BACKOFF_SECONDS else Transport.POLL_SECONDS
	end
	local pair = self.pair
	if not pair then
		if self.recovery and self.recovery.needsStatus and not self.blocked then return self:recover() end
		return Transport.POLL_SECONDS
	end
	self:observeIdentity(pair.identityFence)
	-- Retained buffers/EditableMeshes belong to one Edit epoch, including while
	-- idle. Retirement is local and never turns a historical receipt into a retry.
	local observed, observation = pcall(function(): any return if self.testProof then self.testProof:snapshot() else nil end)
	if not observed then observation = nil end
	if self.operations and self.operations.retireAssetContinuity then
		local cleaned = pcall(function() self.operations:retireAssetContinuity(observation) end)
		if not cleaned then
			self:disposeOperations()
			self.assetCleanupFailed = true; self.blocked = true
			V.fail("CLEANUP", ASSET_CLEANUP_FAILED)
		end
	end
	if self.pending then
		local receipt = self.pending
		local response = self:post(pair.url, ROUTES.result, receipt.body, pair.token)
		if response.accepted ~= true then V.fail("RECONCILE", "Daemon did not acknowledge the receipt.") end
		receipt.acknowledged = true
		self.pending = nil
		self:status(if self.blocked then "reconciliation" else "connected",
			if self.blocked then "Partial change: inspect the command and place before pairing again." else "Receipt acknowledged.", receipt.body.commandId)
		return Transport.POLL_SECONDS
	end
	if self.blocked then return Transport.POLL_SECONDS end
	local response = self:post(pair.url, ROUTES.poll, {sessionId = pair.sessionId, observation = observation}, pair.token)
	-- A poll that returns after disconnect/re-pair can never dispatch old work.
	if self.stopped or self.pair ~= pair or self.generation ~= pair.generation or self.disconnectRequested then return Transport.POLL_SECONDS end
	self:checkIdentity(pair)
	V.fields(response, {"commands"}, "poll response")
	local commands = V.list(response.commands, 1, "command queue")
	if #commands == 1 then self:dispatch(commands[1])
	else self:status("connected", if self:isEdit() then "Connected; waiting for commands." else "Connected; commands are fenced during playtesting.") end
	return Transport.POLL_SECONDS
end

function Transport:cycle(): number
	local generation = self.generation
	local ok, delay = pcall(function() return self:tick() end)
	if ok then self.failures = 0; return delay end
	if self.stopped or generation ~= self.generation then return Transport.POLL_SECONDS end
	if type(delay) == "table" and delay.code == "NETWORK" then
		self.failures = math.min(self.failures + 1, 5)
		local backoff = math.min(Transport.MAX_BACKOFF_SECONDS, Transport.POLL_SECONDS * 2 ^ self.failures)
		self:status("retrying", "Loopback unavailable; checking again in " .. tostring(backoff) .. " seconds. Commands are never replayed.")
		return backoff
	end
	local wasBlocked = self.blocked
	self.blocked = true
	if type(delay) == "table" and delay.code == "REVOKED" then
		local intent = self.recovery
		local safe = intent and not wasBlocked and not (self.identityFence and self.identityFence.changed)
			and not (self.pending and self.pending.unsafe)
		-- Loss fences every old callback immediately. Pending receipts stay at the
		-- old daemon for reconciliation and are never sent under replacement auth.
		self:clearSession(safe == true)
		self.generation += 1
		if safe and not self.assetCleanupFailed then intent.generation = self.generation; intent.needsStatus = true; intent.attempts = 0
		else self:forgetRecovery(); self.blocked = wasBlocked or self.assetCleanupFailed end
		self:status(if self.blocked then "reconciliation" else "disconnected", V.safeError(delay))
	elseif type(delay) == "table" and delay.code == "KEY_REJECTED" then
		self:clearSession(); self:forgetRecovery(); self.generation += 1
		self:status("failed", "Arcane API key was rejected. Enter a new API key.")
	else
		self:forgetRecovery()
		self:status("reconciliation", V.safeError(delay))
	end
	return Transport.MAX_BACKOFF_SECONDS
end

function Transport:start(): ()
	if self.started then return end
	self.started = true
	task.spawn(function()
		while not self.stopped do
			local delay = self:cycle()
			if self.stopped then break end
			task.wait(delay)
		end
	end)
end

return Transport
