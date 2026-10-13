--!strict
-- Executed with production Main/Transport by the official standalone Luau VM.
-- Property signals, selection and HTTP/editor yields are explicit doubles;
-- these cases do not claim native Studio keyboard or window-chrome coverage.
local validation = __arcaneRequire("Validation")
local mode = fixture.keyInputCase
local function reply(value: any): any
	return {StatusCode = 200, Success = true, Body = validation.encode(value, http)}
end
local function connectReply(): any
	return reply({sessionId = "ui-session", token = "ui-token", protocolVersion = 1,
		allowedRoots = {"Workspace"}, allowWrites = true})
end
local function envelope(method: string, args: any): any
	return {protocolVersion = 1, id = "old-command", requestId = "old-request",
		sessionId = client.pair.sessionId, clientSessionId = client.clientSessionId,
		method = method, args = args, allowedRoots = {"Workspace"},
		allowWrites = client.pair.allowWrites, leaseEpoch = 99, state = "dispatched",
		expiresAt = "2099-01-01T00:00:00.000Z"}
end
local function edited(): ()
	assert(keyInput.Text == otherKey and control.Text == "Connect" and control.BackgroundColor3 ~= green,
		"replacement stays visible and red until a new explicit exchange ACK")
	assert(client.desiredPair == nil and client.disconnectRequested and fixture.pluginSettings[keySetting] == "",
		"editing forgets old auth intent and stored key before any new click")
end
local function reloadSavedKey(): ()
	local oldClient, requests, writes = client, fixture.requests, #fixture.setCalls
	plugin.Unloading:Fire()
	assert(oldClient.stopped and oldClient.pair == nil and keyInput.Text == ""
		and fixture.pluginSettings[keySetting] == key, "unload clears lifetime memory while retaining the saved raw key")
	fixture.reloadMain()
	for _, instance in ipairs(fixture.created) do
		if not instance._destroyed then
			if instance.Name == "ApiKey" then keyInput = instance end
			if instance.Name == "Connect" then control = instance end
		end
	end
	client = fixture.transports[#fixture.transports]
	assert(client ~= oldClient and client.clientSessionId ~= oldClient.clientSessionId and client.pair == nil
		and client.desiredPair == nil and client.pending == nil and client.highEpoch == 0 and next(client.cache) == nil,
		"reloaded Main creates a fresh lifetime without any token, command or epoch")
	assert(keyInput.Text == key and keyInput.TextEditable and control.Text == "Reconnect"
		and control.BackgroundColor3 ~= green and fixture.requests == requests and #fixture.setCalls == writes,
		"saved raw key is visible and editable on real Main reload without probing or cached green")
end
idleMount()
enter(key); clickConnect()
if mode == "unload in-flight ACK" then
	fixture.uiHttpHook = function(_request: any): any
		connectCount += 1
		coroutine.yield()
		return connectReply()
	end
	cycle(); assert(client.inFlight, "old lifetime exchange really yields")
	local oldClient, oldWorker = client, worker
	reloadSavedKey()
	local ok, err = coroutine.resume(oldWorker)
	assert(ok, tostring(err))
	assert(oldClient.pair == nil and oldClient.operations == nil and client.pair == nil
		and control.Text == "Reconnect" and control.BackgroundColor3 ~= green and keyInput.Text == key,
		"unloaded lifetime ACK cannot adopt access or UI in the freshly mounted plugin")
	fixture.uiHttpHook = nil
	worker = coroutine.create(fixture.workers[#fixture.workers])
	cycle(); cycle()
	assert(connectCount == 1, "reload and old ACK never automatically authenticate the saved key")
	control.Activated:Fire(); ack(); unload()
elseif mode == "queued edit" then
	local queued, epoch = client.desiredPair, client.generation
	enter(otherKey); edited()
	assert(queued.apiKey == nil and client.generation > epoch, "typing forgets queued raw auth and advances epoch")
	cycle(); cycle()
	assert(connectCount == 0 and fixture.requests == 0, "unsubmitted replacement never authenticates automatically")
	expectKey = otherKey; clickConnect(); ack(); unload()
elseif mode == "late connect ACK" or mode == "deferred text ACK" then
	fixture.uiHttpHook = function(_request: any): any
		connectCount += 1
		coroutine.yield()
		return connectReply()
	end
	cycle()
	assert(client.inFlight, "production exchange really yields before ACK")
	local epoch = client.generation
	if mode == "deferred text ACK" then keyInput.Text = otherKey else enter(otherKey); edited() end
	cycle()
	assert(client.generation > epoch and control.BackgroundColor3 ~= green and control.Text == "Connect"
		and keyInput.Text == otherKey, "late ACK cannot adopt old access or overwrite an edit even before the Text signal")
	assert(client.pair and client.pair.generation ~= client.generation and client.disconnectRequested,
		"late bearer is retained only for fenced cleanup")
	local oldPair = client.pair
	fixture.uiHttpHook = nil
	cycle(); cycle()
	assert(oldPair.token == nil and client.pair == nil and client.operations == nil and connectCount == 1
		and disconnectCount == 1 and pollCount == 0, "single worker revokes late bearer without dispatching or retrying")
	expectKey = otherKey; clickConnect(); ack(); unload()
else
	-- The remaining cases begin with an actual current ACK.
	if mode == "editor replacement" or mode == "deferred editor replacement" then fixture.uiHttpHook = connectReply end
	ack()
	fixture.uiHttpHook = nil
	local oldPair, oldOperations = client.pair, client.operations
	if mode == "play refuses reconnect" then
		local epoch, requests = client.generation, fixture.requests
		fixture.edit = false
		control.Activated:Fire()
		assert(client.generation > epoch and client.desiredPair == nil and client.disconnectRequested
			and oldPair.generation ~= client.generation and fixture.requests == requests,
			"locally refused reconnect fences the previous ACK without launching HTTP")
		assert(control.Text == "Reconnect" and control.BackgroundColor3 ~= green and keyInput.Text == key
			and fixture.pluginSettings[keySetting] == key and not fixture.pluginSettings[lastSetting].connected,
			"refused connect keeps the saved raw key and red Reconnect status")
		fixture.edit = true
		clickConnect(); ack(); unload()
	elseif mode == "saved key reload" then
		reloadSavedKey()
		worker = coroutine.create(fixture.workers[#fixture.workers])
		local requests = fixture.requests
		cycle(); cycle()
		assert(fixture.requests == requests and control.Text == "Reconnect", "idle reloaded worker never authenticates automatically")
		control.Activated:Fire(); ack(); unload()
	elseif mode == "select all delete" or mode == "select all replace" then
		local epoch, writes = client.generation, #fixture.setCalls
		keyInput.SelectionStart, keyInput.CursorPosition = 1, #keyInput.Text + 1
		assert(control.Text == "Connected" and control.BackgroundColor3 == green and client.generation == epoch
			and #fixture.setCalls == writes, "selecting the raw connected key does not disconnect or rewrite input")
		local value = if mode == "select all delete" then "" else otherKey
		keyInput.SelectionStart, keyInput.CursorPosition = -1, #value + 1
		enter(value)
		assert(keyInput.Text == value and keyInput.SelectionStart == -1 and keyInput.CursorPosition == #value + 1
			and keyInput.TextEditable and not keyInput.ClearTextOnFocus, "editing callback leaves text, caret and selection under normal textbox control")
		assert(oldPair.generation ~= client.generation and client.desiredPair == nil and client.disconnectRequested
			and control.Text == "Connect" and control.BackgroundColor3 ~= green, "selection replacement immediately fences a live session")
		assert(fixture.pluginSettings[keySetting] == "" and not fixture.pluginSettings[lastSetting].connected,
			"deletion/replacement removes stale saved auth and connected history")
		cycle(); cycle()
		assert(oldPair.token == nil and client.pair == nil and client.operations == nil and pollCount == 0,
			"old connection is cleaned up without another command poll")
		if value == "" then
			control.Activated:Fire()
			assert(control.Text == "Failed" and keyInput.PlaceholderText == "Enter a new API key"
				and client.desiredPair == nil and connectCount == 1, "empty Connect cannot fall back to deleted saved auth")
			enter(otherKey)
		end
		expectKey = otherKey; clickConnect(); ack(); unload()
	elseif mode == "late poll replacement" then
		local command = envelope("selection.read", {})
		fixture.uiHttpHook = function(request: any): any
			assert(string.find(request.Url, "/v1/plugin/poll", 1, true), "old request is a poll")
			coroutine.yield()
			return reply({commands = validation.array({command})})
		end
		cycle(); assert(client.inFlight, "production poll really yields")
		enter(otherKey); edited(); cycle()
		assert(client.pending == nil and client.cacheCount == 0 and next(client.cache) == nil,
			"dispatched command returned by old poll is never adopted")
		fixture.uiHttpHook = nil; expectKey = otherKey
		clickConnect(); ack()
		assert(client.pair ~= oldPair and client.operations ~= oldOperations and client.highEpoch == 0
			and client.pending == nil and next(client.cache) == nil, "new connection starts fresh without old dispatched work")
		unload()
	elseif mode == "editor replacement" or mode == "deferred editor replacement" then
		local target = Instance.new("Script")
		target.Parent = game:GetService("Workspace")
		fixture.sources[target] = "before"
		local command = envelope("script.update", {ref = client.operations.registry:ref(target),
			expectedSource = "before", source = "after"})
		fixture.uiHttpHook = function(_request: any): any return reply({commands = validation.array({command})}) end
		fixture.editorHook = function(instance: any, callback: any): ()
			coroutine.yield()
			local proposal = callback("before")
			if proposal then fixture.sources[instance] = proposal end
		end
		cycle()
		assert(fixture.sources[target] == "before" and control.Text == "Connected", "production editor update is suspended before proposing a write")
		if mode == "deferred editor replacement" then
			keyInput.Text = otherKey -- Deliberately withhold the fixture's Text signal.
			cycle(); edited()
		else enter(otherKey); edited(); cycle() end
		local receipt = client.pending
		assert(fixture.sources[target] == "before" and receipt.body.state == "failed"
			and string.find(receipt.body.error, "SESSION", 1, true), "new text fences an already dispatched editor callback")
		fixture.uiHttpHook, fixture.editorHook = nil, nil
		expectKey = otherKey; clickConnect(); ack()
		assert(client.pair ~= oldPair and client.operations ~= oldOperations and client.pending == nil
			and next(client.cache) == nil and client.highEpoch == 0 and not receipt.acknowledged,
			"old dispatched result is not adopted or sent under replacement access")
		unload()
	elseif mode == "late receipt ACK" then
		client:dispatch(envelope("selection.read", {}))
		local receipt = client.pending
		fixture.uiHttpHook = function(request: any): any
			assert(string.find(request.Url, "/v1/plugin/result", 1, true), "old request settles its own dispatched receipt")
			coroutine.yield()
			return reply({accepted = true})
		end
		cycle(); assert(client.inFlight, "production receipt delivery really yields")
		enter(otherKey); edited(); cycle()
		assert(receipt.acknowledged and control.Text == "Connect" and control.BackgroundColor3 ~= green
			and not fixture.pluginSettings[lastSetting].connected, "old receipt ACK cannot restore connected status for an edited key")
		fixture.uiHttpHook = nil; expectKey = otherKey; clickConnect(); ack()
		assert(client.pair ~= oldPair and client.pending == nil and next(client.cache) == nil and client.highEpoch == 0,
			"fresh connection cannot inherit an old receipt or epoch")
		unload()
	else
		assert(false, "unknown key input fixture case")
	end
end
storageBoundaries(); noSecretText()
