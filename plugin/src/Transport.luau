--!strict
local V = require(script.Parent.Validation)
local Operations = require(script.Parent.Operations)
local Transport = {}
Transport.__index = Transport
Transport.POLL_SECONDS = 2
Transport.MAX_BACKOFF_SECONDS = 30
local ROUTES = table.freeze({connect = "/v1/plugin/connect", pair = "/v1/plugin/pair", poll = "/v1/plugin/poll", result = "/v1/plugin/result", disconnect = "/v1/plugin/disconnect"})
local IDENTITY_CHANGED = "Place identity changed; this session is fenced. Inspect receipts and explicitly connect again."
type Transport = any

function Transport.new(gameModel: any, onStatus: (any) -> ()): Transport
	local http = gameModel:GetService("HttpService")
	return setmetatable({gameModel = gameModel, http = http, run = gameModel:GetService("RunService"),
		clientSessionId = http:GenerateGUID(false), onStatus = onStatus, generation = 0,
		pair = nil, desiredPair = nil, disconnectRequested = false, stopped = false,
		inFlight = false, started = false, failures = 0, cache = {}, cacheCount = 0,
		cacheBytes = 0, highEpoch = 0, pending = nil, blocked = false, identityFence = nil}, Transport)
end

function Transport:status(state: string, detail: string, commandId: string?)
	if self.stopped then return end
	local changed = self.identityFence and self.identityFence.changed
	if changed and table.find({"connected", "executing", "retrying"}, state) then state, detail = "reconciliation", IDENTITY_CHANGED end
	local pair = if self.pair and self.generation == self.pair.generation and not self.disconnectRequested and not changed then self.pair else nil
	self.onStatus({state = state, detail = detail, commandId = commandId,
		sessionId = if pair then pair.sessionId else nil,
		allowedRoots = if pair then table.clone(pair.allowedRoots) else {},
		allowWrites = if pair then pair.allowWrites else false,
		clientSessionId = self.clientSessionId, editMode = self.run:IsEdit()})
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

function Transport:requestConnect(apiKey: any): ()
	if self.stopped then return end
	local origin = V.keyOrigin(apiKey)
	if not self.run:IsEdit() then V.fail("PLAY", "Stop playtesting before connecting.") end
	self.generation += 1
	self:forgetDesired()
	self.desiredPair = {url = origin, apiKey = apiKey, generation = self.generation}
	self.disconnectRequested = true
	self:status("connecting", "Connecting to the Arcane workbench.")
end

-- Compatibility entry point for legacy fixtures; never exposed by Main.
function Transport:requestPair(url: any, code: any): ()
	if self.stopped then return end
	local origin = V.url(url)
	local pairingCode = V.string(code, "pairing code", 128)
	if not self.run:IsEdit() then V.fail("PLAY", "Stop playtesting before pairing.") end
	self.generation += 1 -- Immediately fences callbacks already waiting on Studio.
	self:forgetDesired()
	self.desiredPair = {url = origin, code = pairingCode, generation = self.generation}
	self.disconnectRequested = true
	self:status("pairing", "Pairing requested; waiting for the current request to finish.")
end

function Transport:requestDisconnect(): ()
	if self.stopped then return end
	self.generation += 1
	self:forgetDesired()
	self.disconnectRequested = true
	self:status("disconnecting", "Local writes are fenced; disconnecting from the daemon.")
end

function Transport:stop(): ()
	-- Unloading must not yield or launch a second network request. The daemon
	-- observes heartbeat loss; no token or session state is saved anywhere.
	self.generation += 1
	self.stopped = true
	self:forgetDesired()
	self:dropIdentityFence()
	if self.pair then self.pair.token = nil end
	self.pair = nil
	self.operations = nil
	self.pending = nil
	self.cache = {}
end

function Transport:post(url: string, route: string, payload: any, token: string?): any
	V.url(url)
	if not table.find({ROUTES.connect, ROUTES.pair, ROUTES.poll, ROUTES.result, ROUTES.disconnect}, route) then V.fail("URL", "Unsupported plugin route.") end
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
	if self.identityFence then self:observeIdentity(self.identityFence) end
	if not ok then V.fail("NETWORK", "Loopback request failed or timed out.") end
	if type(response) ~= "table" or type(response.StatusCode) ~= "number" or type(response.Success) ~= "boolean" then V.fail("PROTOCOL", "Invalid HTTP response.") end
	-- Never inspect/follow Location, and never construct a URL from a response.
	-- RequestAsync documents Timeout, but no redirect-disable option. Native redirect
	-- behavior still needs a disposable-fixture check; see docs/build/PLUGIN.md.
	if response.StatusCode >= 300 and response.StatusCode < 400 then V.fail("REDIRECT", "Daemon returned a redirect; connection refused.") end
	if response.StatusCode == 401 or response.StatusCode == 403 then
		if route == ROUTES.connect then V.fail("KEY_REJECTED", "Arcane API key was rejected. Enter a new API key.") end
		V.fail("REVOKED", "Session expired or was revoked; connect again.")
	end
	if response.StatusCode == 409 then V.fail("RECONCILE", "Daemon refused the session or receipt; inspect the command and connect again.") end
	if not response.Success then V.fail("NETWORK", "Daemon request failed (HTTP " .. tostring(response.StatusCode) .. ").") end
	if type(response.Body) ~= "string" or #response.Body > V.RESULT_BYTES + V.ARGUMENT_BYTES + 8192 then V.fail("BODY_LIMIT", "Daemon response exceeds the transport bound.") end
	local decoded, data = pcall(function() return V.decode(response.Body, self.http) end)
	if not decoded then V.fail("PROTOCOL", "Daemon response is not valid JSON.") end
	return V.object(data, "daemon response")
end

function Transport:clearSession(): ()
	self:dropIdentityFence()
	if self.pair then self.pair.token = nil end
	self.pair = nil
	self.operations = nil
	self.pending = nil
	self.cache = {}
	self.cacheCount, self.cacheBytes, self.highEpoch = 0, 0, 0
	self.blocked = false
end

function Transport:exchange(desired: any): ()
	if self.stopped or desired.generation ~= self.generation then desired.code = nil; desired.apiKey = nil; return end
	local capabilities = table.clone(V.READ_METHODS)
	for _, method in ipairs(V.WRITE_METHODS) do table.insert(capabilities, method) end
	local isKey = desired.apiKey ~= nil
	local payload: any = {
		protocolVersion = V.PROTOCOL,
		identity = {clientSessionId = self.clientSessionId, placeId = self.gameModel.PlaceId,
			universeId = self.gameModel.GameId, name = V.string(self.gameModel.Name, "place name", 200), pluginVersion = V.VERSION},
		capabilities = V.array(capabilities),
	}
	if isKey then payload.apiKey = desired.apiKey else payload.code = desired.code end
	local fence = self:watchIdentity(payload.identity)
	desired.apiKey, desired.code = nil, nil
	local result = self:post(desired.url, if isKey then ROUTES.connect else ROUTES.pair, payload, nil)
	payload.apiKey, payload.code = nil, nil
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
	self:checkIdentity(result) -- Before resolving any roots in the current engine.
	self.operations = Operations.new(result, self.gameModel, self.http)
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
	if not table.find(V.READ_METHODS, command.method) and not table.find(V.WRITE_METHODS, command.method) then V.fail("METHOD", "Unsupported Studio method.") end
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
	if not self.run:IsEdit() then V.fail("PLAY", "Commands are only available in Studio edit mode.") end
	if table.find(V.WRITE_METHODS, command.method) and not pair.allowWrites then V.fail("GRANT", "Session is read only.") end
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
	self:status("executing", command.method, command.id)
	local ok, output = pcall(function()
		self:guard(command, pair)
		return self.operations:execute(command, function() self:guard(command, pair) end)
	end)
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

function Transport:tick(): number
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
	if self.desiredPair then
		local desired = self.desiredPair
		self.desiredPair = nil
		-- Human-triggered exchanges are never automatically retried after an
		-- uncertain response: a session may already exist at the daemon.
		local ok, err = pcall(function() self:exchange(desired) end)
		desired.code, desired.apiKey = nil, nil
		if not ok and desired.generation == self.generation then
			if type(err) == "table" and err.code == "KEY_REJECTED" then
				self:clearSession()
				self.generation += 1
				self:status("failed", "Arcane API key was rejected. Enter a new API key.")
			else
				self:status(if type(err) == "table" and err.code == "IDENTITY" then "reconciliation" else "disconnected", V.safeError(err) .. " Click Connect to try again.")
			end
		end
		return Transport.POLL_SECONDS
	end
	local pair = self.pair
	if not pair then return Transport.POLL_SECONDS end
	self:observeIdentity(pair.identityFence)
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
	local response = self:post(pair.url, ROUTES.poll, {sessionId = pair.sessionId}, pair.token)
	-- A poll that returns after disconnect/re-pair can never dispatch old work.
	if self.stopped or self.pair ~= pair or self.generation ~= pair.generation or self.disconnectRequested then return Transport.POLL_SECONDS end
	self:checkIdentity(pair)
	V.fields(response, {"commands"}, "poll response")
	local commands = V.list(response.commands, 1, "command queue")
	if #commands == 1 then self:dispatch(commands[1])
	else self:status("connected", if self.run:IsEdit() then "Connected; waiting for commands." else "Connected; commands are fenced during playtesting.") end
	return Transport.POLL_SECONDS
end

function Transport:cycle(): number
	local ok, delay = pcall(function() return self:tick() end)
	if ok then self.failures = 0; return delay end
	if type(delay) == "table" and delay.code == "NETWORK" then
		self.failures = math.min(self.failures + 1, 5)
		local backoff = math.min(Transport.MAX_BACKOFF_SECONDS, Transport.POLL_SECONDS * 2 ^ self.failures)
		self:status("retrying", "Loopback unavailable; retrying in " .. tostring(backoff) .. " seconds. Completed work will only resend its receipt.")
		return backoff
	end
	self.blocked = true
	if type(delay) == "table" and delay.code == "REVOKED" then
		self:clearSession()
		self.generation += 1
		self:status("disconnected", V.safeError(delay))
	else self:status("reconciliation", V.safeError(delay)) end
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
