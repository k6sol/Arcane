--!strict
-- Production Main/Transport in the pinned standalone VM with explicit doubles.
-- No socket, native Studio session, SDK, install, reload or user app is used.
-- Required daemon contract: POST /v1/plugin/status authenticates payload.apiKey
-- exactly (including its endpoint), checks payload.identity/clientSessionId and
-- optional sessionId, and returns {protocolVersion=1, identity=<exact echo>,
-- state="absent"|"lost"|"active"|"reconciliation", sessionId?}. Only absent/lost
-- authorize a fresh handshake. Lost/active require sessionId; absent omits it.
-- It MUST NOT mint a bearer/grant, heartbeat, dispatch or settle scene work.
-- Invalid/revoked API keys return 401/403 with error="KEY_REJECTED". A generic
-- legacy bearer AUTH response must preserve the key and stop safe recovery.
local v = __arcaneRequire("Validation")
local mode = fixture.reconnectCase
local delays: {number} = {}
task.wait = function(seconds: number): ()
	assert(seconds >= 2 and seconds <= 30, "worker waits within the original 2..30 second bounds")
	table.insert(delays, seconds)
	coroutine.yield()
end
local seen: {any} = {}
local function reply(value: any, code: number?): any
	local status = code or 200
	return {StatusCode = status, Success = status >= 200 and status < 300, Body = v.encode(value, http)}
end
local function statusReply(request: any, state: string?): any
	local payload = v.decode(request.Body, http)
	assert(request.Url == v.keyOrigin(expectKey) .. "/v1/plugin/status" and payload.apiKey == expectKey
		and payload.protocolVersion == 1 and request.Headers.Authorization == nil, "status uses the exact desired key and literal key endpoint")
	assert(payload.identity.clientSessionId == client.clientSessionId, "status is pinned to this plugin lifetime")
	return reply({protocolVersion = 1, identity = payload.identity, state = state or "lost",
		sessionId = if state == "absent" then nil else payload.sessionId or "unknown-ack-session"})
end
local function connected(): () idleMount(); enter(key); clickConnect(); ack() end
local function hide(): ()
	fixture.button.Click:Fire(); fixture.widget:GetPropertyChangedSignal("Enabled"):Fire()
	assert(not fixture.widget.Enabled and not fixture.button.active, "widget is hidden")
end
local function revoked(code: number?, errorCode: string?): ()
	fixture.uiHttpHook = function(request: any): any
		table.insert(seen, request)
		return reply({error = errorCode or "AUTH", message = "untrusted message " .. key}, code or 401)
	end
	cycle(); fixture.uiHttpHook = nil
end
local function count(route: string): number
	local total = 0
	for _, request in ipairs(seen) do if string.find(request.Url, route, 1, true) then total += 1 end end
	return total
end

if mode == "hidden connection" then
	connected(); local generation, pair = client.generation, client.pair
	hide(); cycle(); cycle()
	assert(client.pair == pair and client.generation == generation and client.recovery ~= nil
		and pollCount == 2 and disconnectCount == 0 and #fixture.workers == 1, "hiding preserves auth intent, polling and the one worker")
	revoked(409, "REVOKED"); ack()
	assert(not fixture.widget.Enabled and control.Text == "Connected" and statusCount == 1
		and connectCount == 2 and client.pair ~= pair and pair.token == nil, "daemon restart recovers while the widget stays hidden")
	unload()
elseif mode == "bootstrap absent history" or mode == "bootstrap play" or mode == "saved opt-out" then
	if mode == "bootstrap absent history" then
		assert(keyInput.Text == "" and client.recovery == nil and fixture.requests == 0, "missing preference waits for bounded settings observations")
		local wasEdit = fixture.edit
		fixture.edit = false
		cycle(); cycle()
		assert(fixture.requests == 0, "settings resolution under held Edit readiness never authenticates")
		fixture.edit = wasEdit
	end
	assert(keyInput.Text == key and control.BackgroundColor3 ~= green and fixture.requests == 0, "saved key is red and no HTTP occurs during mount")
	if mode == "saved opt-out" then
		assert(client.recovery == nil and client.desiredPair == nil, "explicit saved opt-out suppresses startup")
		cycle(); cycle(); assert(fixture.requests == 0, "opt-out survives idle cycles")
		clickConnect(); ack()
		assert(fixture.pluginSettings[lastSetting].autoConnect == nil, "explicit connect clears the persisted opt-out")
	else
		assert(client.recovery ~= nil and client.desiredPair == nil, "any valid saved key queues only status")
		if mode == "bootstrap play" then
			cycle(); cycle(); assert(fixture.requests == 0 and delays[1] == 30, "startup during Play waits without exhausting attempts or authenticating")
			fixture.edit = true
		end
		ack(); assert(statusCount == 1 and connectCount == 1, "first startup connects only after fresh absent status")
	end
	unload()
elseif mode == "explicit disconnect" then
	connected(); local intent = client.recovery
	client:requestDisconnect()
	assert(intent.apiKey == nil and client.recovery == nil and fixture.pluginSettings[lastSetting].autoConnect == false,
		"explicit disconnect scrubs recovery auth and persists opt-out in the existing owned record")
	cycle(); cycle(); cycle()
	assert(statusCount == 0 and connectCount == 1 and client.pair == nil, "explicit disconnect never auto-recovers")
	unload(); fixture.reloadMain()
	local reloaded = fixture.transports[#fixture.transports]
	assert(reloaded.recovery == nil and reloaded.desiredPair == nil, "opt-out persists across a new plugin lifetime")
	plugin.Unloading:Fire()
elseif mode == "definitive loss" then
	connected(); local oldPair, oldOps = client.pair, client.operations
	if fixture.reconnectPending then
		client:dispatch({protocolVersion = 1, id = "pending-before-loss", requestId = "pending-request", sessionId = oldPair.sessionId,
			clientSessionId = client.clientSessionId, method = "selection.read", args = {}, allowedRoots = {"Workspace"},
			allowWrites = false, leaseEpoch = 31, state = "dispatched", expiresAt = "2099-01-01T00:00:00.000Z"})
		assert(client.pending ~= nil and client.cacheCount == 1 and client.highEpoch == 31, "receipt path contains real cached work before definitive loss")
	end
	revoked(fixture.reconnectCode, fixture.reconnectError)
	assert(oldPair.token == nil and client.pair == nil and client.recovery.needsStatus and not client.blocked,
		"definitive loss drops the old bearer and fences old work before recovery")
	assert(client.operations == nil and client.pending == nil and client.cacheCount == 0 and client.cacheBytes == 0
		and client.highEpoch == 0 and next(client.cache) == nil, "404/410 and other definitive loss clear bearer, receipt and cache before any fresh authentication")
	ack()
	assert(statusCount == 1 and connectCount == 2 and client.operations ~= oldOps and client.pending == nil
		and client.highEpoch == 0 and next(client.cache) == nil, "replacement session only follows fresh exact-key loss status and has no old work")
	unload()
elseif mode == "loss during play" then
	connected(); fixture.edit = false; revoked(409, "REVOKED")
	local attempts = client.recovery.attempts
	cycle(); cycle(); assert(statusCount == 0 and connectCount == 1 and client.recovery.attempts == attempts, "loss during Play retains intent but sends no automatic handshake or status")
	fixture.edit = true; ack(); assert(statusCount == 1 and connectCount == 2, "edit mode resumes bounded recovery")
	unload()
elseif mode == "receipt never crosses session" or mode == "unsafe receipt" then
	connected()
	local pair = client.pair
	local envelope = {protocolVersion = 1, id = "recovery-command", requestId = "recovery-request", sessionId = pair.sessionId,
		clientSessionId = client.clientSessionId, method = "scene.create", state = "dispatched", allowedRoots = {"Workspace"},
		allowWrites = true, leaseEpoch = 123, expiresAt = "2099-01-01T00:00:00.000Z", args = {parent = client.operations.registry:ref(game:GetService("Workspace")), className = "Model", name = "OnlyOnce"}}
	-- The fixture's default key grant is read-only. Use a fresh explicit writable ACK.
	fixture.uiHttpHook = function(_request: any): any return reply({sessionId = "writable-session", token = "ui-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = true}) end
	clickConnect(); ack(); fixture.uiHttpHook = nil
	pair = client.pair; envelope.sessionId = pair.sessionId
	envelope.args.parent = client.operations.registry:ref(game:GetService("Workspace"))
	if mode == "unsafe receipt" then fixture.failFinish = true end
	client:dispatch(envelope)
	fixture.failFinish = nil
	local receipt, writes = client.pending, fixture.committed
	local children = #game:GetService("Workspace"):GetChildren()
	if mode == "unsafe receipt" then
		assert(receipt.unsafe and receipt.body.state == "failed" and receipt.body.result.partial and client.blocked,
			"real production Operations marks an applied scene change unsafe when history commit fails")
	else assert(receipt.body.state == "succeeded", "one scene command completed before a receipt ACK was lost") end
	revoked(409, "REVOKED")
	assert(client.pending == nil and pair.token == nil and not receipt.acknowledged, "old unacknowledged receipt is never adopted by replacement auth")
	if mode == "unsafe receipt" then
		cycle(); cycle(); assert(client.blocked and client.recovery == nil and statusCount == 0, "partial change requires reconciliation and suppresses all automatic handshakes")
	else
		ack(); assert(statusCount == 1 and client.pending == nil and next(client.cache) == nil and client.highEpoch == 0, "recovery starts a fresh operation lifetime")
		local accepted = pcall(function() client:dispatch(envelope) end)
		assert(not accepted and fixture.committed == writes, "old scene command is never replayed under a new session")
	end
	assert(fixture.committed == writes and #game:GetService("Workspace"):GetChildren() == children, "recovery never applies or rolls back scene effects")
	unload()
elseif mode == "unknown handshake active" or mode == "unknown handshake absent" then
	idleMount(); enter(key); clickConnect()
	local intent = client.recovery
	fixture.uiHttpHook = function(request: any): any
		table.insert(seen, request)
		assert(string.find(request.Url, "/v1/plugin/connect", 1, true), "first handshake alone has an unknown outcome")
		error("lost ACK " .. key)
	end
	cycle(); assert(intent.needsStatus and client.pair == nil and control.BackgroundColor3 ~= green, "unknown ACK enables status only")
	local beforeStatus = #delays
	fixture.uiHttpHook = function(request: any): any
		table.insert(seen, request)
		if string.find(request.Url, "/v1/plugin/status", 1, true) then return statusReply(request, if mode == "unknown handshake active" then "active" else "absent") end
		assert(mode == "unknown handshake absent", "an active session can never be superseded automatically")
		local payload = v.decode(request.Body, http)
		assert(payload.apiKey == key, "fresh handshake after definitive absence uses the same exact desired key")
		return reply({sessionId = "fresh-after-absence", token = "ui-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = false})
	end
	if mode == "unknown handshake active" then
		for _ = 1, 12 do cycle() end
		assert(count("/connect") == 1 and count("/status") == 8 and client.recovery == nil and intent.apiKey == nil
			and client.pair == nil, "eight bounded status checks cannot replay an ambiguous active handshake")
		assert(delays[beforeStatus + 1] == 4 and delays[beforeStatus + 2] == 8 and delays[beforeStatus + 3] == 16 and delays[beforeStatus + 4] == 30, "active-session checks back off without a tight loop")
	else
		ack(); assert(count("/connect") == 2 and count("/status") == 1, "fresh absent status precedes one fresh handshake")
	end
	fixture.uiHttpHook = nil; unload()
elseif mode == "status network bound" or mode == "status unsupported" or mode == "status key rejected" or mode == "status malformed" then
	assert(client.recovery ~= nil, "saved key queued recovery")
	local intent = client.recovery
	fixture.uiHttpHook = function(request: any): any
		table.insert(seen, request)
		assert(string.find(request.Url, "/v1/plugin/status", 1, true), "preflight never sends a handshake without definitive status")
		if mode == "status network bound" then error("status unavailable " .. key) end
		if mode == "status unsupported" then return reply({error = if fixture.reconnectCode == 401 or fixture.reconnectCode == 403 then "AUTH" else "NOT_FOUND"}, fixture.reconnectCode) end
		if mode == "status key rejected" then return reply({error = "KEY_REJECTED", message = "untrusted rejection " .. key}, fixture.reconnectCode) end
		local data = v.decode(request.Body, http)
		local identity = table.clone(data.identity)
		if fixture.reconnectMalformed == "identity" then identity.clientSessionId = "another-lifetime" end
		return reply({protocolVersion = 1, identity = identity, state = "lost",
			sessionId = "another-session", token = if fixture.reconnectMalformed == "bearer" then "untrusted-secret" else nil,
			commands = if fixture.reconnectMalformed == "commands" then v.array({}) else nil})
	end
	for _ = 1, 12 do cycle() end
	if mode == "status network bound" then
		assert(client.recovery == intent and intent.apiKey == key and client.pair == nil and connectCount == 0, "offline update retains the exact saved recovery intent without creating sessions")
		assert(#seen == 12 and delays[1] == 4 and delays[2] == 8 and delays[3] == 16 and delays[4] == 30 and delays[12] == 30, "extended outage keeps one bounded worker with capped backoff")
		fixture.uiHttpHook = nil -- Restore the fixture daemon: exact status followed by a fresh connect ACK.
		ack()
		assert(client.pair ~= nil and connectCount == 1 and fixture.pluginSettings[keySetting] == key, "app returning after a long update reconnects without entering the key again")
	elseif mode == "status key rejected" then
		assert(client.recovery == nil and intent.apiKey == nil and client.pair == nil and connectCount == 0, "rejected key stops recovery")
		assert(#seen == 1 and control.Text == "Failed" and keyInput.Text == "" and fixture.pluginSettings[keySetting] == "", "key rejection stops once and clears only the rejected saved input")
	else assert(client.recovery == nil and intent.apiKey == nil and connectCount == 0 and client.pair == nil and #seen == 1 and fixture.pluginSettings[keySetting] == key and control.BackgroundColor3 ~= green, "unsupported or malformed status stops once with saved key and nongreen UI") end
	fixture.uiHttpHook = nil; unload()
elseif string.sub(mode, 1, 12) == "late status " then
	assert(client.recovery ~= nil, "saved key queues the yielding status")
	local oldClient, intent, generation = client, client.recovery, client.generation
	fixture.uiHttpHook = function(request: any): any
		local result = statusReply(request, "absent")
		coroutine.yield()
		return result
	end
	cycle(); assert(client.inFlight, "status really yields in production RequestAsync")
	local action = string.sub(mode, 13)
	if action == "edit" then enter(otherKey)
	elseif action == "deferred edit" then keyInput.Text = otherKey
	elseif action == "new click" then enter(otherKey); expectKey = otherKey; clickConnect()
	elseif action == "disconnect" then client:requestDisconnect()
	elseif action == "identity" then game.Name = "OtherFixture"; game.Name = "ArcaneDisposableFixture"
	elseif action == "play" then fixture.edit = false
	elseif action == "unload" then plugin.Unloading:Fire()
	else assert(false, "unknown status race") end
	cycle()
	assert(connectCount == 0 and oldClient.pair == nil and control.BackgroundColor3 ~= green, "late status cannot authenticate or establish green after intent/lifecycle change")
	if action ~= "identity" and action ~= "play" then assert(oldClient.generation > generation and intent.apiKey == nil, "epoch change scrubs old exact-key intent") end
	fixture.uiHttpHook = nil
	if action == "new click" then ack(); assert(client.pair and statusCount == 0 and connectCount == 1, "only the newer explicit key can authenticate")
	elseif action == "identity" then cycle(); assert(client.blocked and client.recovery == nil, "identity change remains latched even after values revert")
	elseif action == "play" then
		cycle(); assert(connectCount == 0, "late status during Play cannot queue a handshake")
		fixture.edit = true; ack(); assert(statusCount == 1, "return to edit must read fresh status again")
	elseif action ~= "unload" then cycle(); cycle(); assert(connectCount == 0 and statusCount == 0, "edited or opted-out intent never resumes automatically") end
	if action ~= "unload" then unload() end
elseif mode == "receipt conflict" then
	connected(); revoked(409, "RECEIPT_CONFLICT")
	cycle(); cycle()
	assert(client.blocked and client.recovery == nil and statusCount == 0 and connectCount == 1, "generic 409 is a reconciliation fence, never session-loss recovery")
	unload()
elseif mode == "wrong lost session" then
	connected(); revoked(409, "REVOKED")
	fixture.uiHttpHook = function(request: any): any
		local payload = v.decode(request.Body, http)
		assert(payload.sessionId == "ui-session", "status asks about the exact previous session")
		return reply({protocolVersion = 1, identity = payload.identity, state = "lost", sessionId = "another-session"})
	end
	cycle(); cycle()
	assert(client.blocked and client.recovery == nil and connectCount == 1, "loss of another session cannot authorize this plugin handshake")
	fixture.uiHttpHook = nil; unload()
elseif mode == "late revoked poll" then
	connected(); local intent = client.recovery
	fixture.uiHttpHook = function(_request: any): any
		coroutine.yield()
		return reply({error = "REVOKED"}, 409)
	end
	cycle(); assert(client.inFlight, "old poll genuinely yields")
	enter(otherKey); expectKey = otherKey; clickConnect()
	local generation, replacement = client.generation, client.recovery
	cycle()
	assert(intent.apiKey == nil and client.generation == generation and client.recovery == replacement and not client.blocked,
		"stale loss cannot advance the new epoch, erase its desired key or schedule old recovery")
	fixture.uiHttpHook = nil; ack()
	assert(connectCount == 2 and statusCount == 0 and keyInput.Text == otherKey, "only the newer exact key and ACK establish access")
	unload()
else assert(false, "unknown reconnect case") end
storageBoundaries(); noSecretText()
for _, status in ipairs(fixture.statuses) do
	local encoded = v.encode(status, http)
	for _, secret in ipairs({key, otherKey, "ui-token", "untrusted-secret"}) do
		assert(not string.find(encoded, secret, 1, true), "public statuses redact keys, bearers and HTTP error bodies")
	end
end
