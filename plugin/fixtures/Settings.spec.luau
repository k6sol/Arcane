--!strict
-- Production Main and Transport with explicit settings doubles; no native profile or socket.
local mode = fixture.settingsCase
local safeKey, safeState = "Arcane_LocalApiKey_v2", "Arcane_LastConnection_v2"
local function writes(name: string, value: any?): number
	local count = 0
	for _, call in ipairs(fixture.setCalls) do if call.key == name and (value == nil or call.value == value) then count += 1 end end
	return count
end
local function reloadMain(): ()
	local oldClient, oldWorker = client, worker
	unload()
	local requests, attempts = fixture.requests, #fixture.setCalls
	if coroutine.status(oldWorker) ~= "dead" then local ok, err = coroutine.resume(oldWorker); assert(ok, tostring(err)) end
	assert(fixture.requests == requests and #fixture.setCalls == attempts, "unloaded workers cannot finish a storage retry or authenticate")
	fixture.reloadMain()
	for _, instance in ipairs(fixture.created) do
		if not instance._destroyed then
			if instance.Name == "ApiKey" then keyInput = instance end
			if instance.Name == "Connect" then control = instance end
		end
	end
	client = fixture.transports[#fixture.transports]
	worker = coroutine.create(fixture.workers[#fixture.workers])
	assert(client ~= oldClient and client.clientSessionId ~= oldClient.clientSessionId and client.pair == nil and client.pending == nil,
		"reload has a new lifetime without restoring a bearer or pending command")
	assert(fixture.requests == requests and #fixture.workers == #fixture.transports, "each lifetime owns exactly one worker and mount never issues HTTP")
end
if mode == "safe namespace" then
	idleMount()
	fixture.rejectDottedWrites = true
	enter(key); clickConnect(); cycle()
	assert(client.pair ~= nil and control.Text == "Connected", "the live connection succeeds independently of persistence")
	assert(fixture.pluginSettings[safeKey] == key and fixture.pluginSettings[safeState].connected == true,
		"a valid connection persists under safe keys even when dotted writes silently fail")
	for _, call in ipairs(fixture.setCalls) do assert(not string.find(call.key, ".", 1, true), "new writes never use unsafe dotted names") end
	reloadMain(); ack()
	assert(statusCount == 1 and connectCount == 2, "the saved safe key reconnects automatically through fresh status after reload")
	unload()
elseif mode == "legacy migration" or mode == "legacy opt-out" then
	assert(client.recovery == nil and keyInput.Text == "" and fixture.requests == 0, "migration waits for key and preference observations together")
	cycle(); cycle()
	assert(fixture.pluginSettings[safeKey] == key and fixture.pluginSettings[fixture.settingNames.legacyApiKey] == key,
		"valid legacy key migrates with verified safe writes without deleting its source")
	assert(fixture.pluginSettings[safeState] ~= nil, "legacy health migrates under a safe name")
	for _, call in ipairs(fixture.setCalls) do assert(not string.find(call.key, ".", 1, true), "legacy settings are read-only") end
	if mode == "legacy opt-out" then
		assert(client.recovery == nil and fixture.requests == 0 and fixture.pluginSettings[safeState].autoConnect == false,
			"a late explicit legacy opt-out is resolved before any automatic authentication")
		clickConnect(); ack()
	else assert(client.pair ~= nil and statusCount == 1 and connectCount == 1, "migration resumes only after fresh status and ACK") end
	unload()
elseif mode == "canonical wins" or mode == "transient canonical nil" then
	expectKey = otherKey
	if mode == "transient canonical nil" then
		assert(client.recovery == nil and fixture.requests == 0, "temporary canonical nil does not adopt an older key")
		cycle(); assert(fixture.requests == 0, "the read budget does not rush legacy fallback")
		cycle()
	else ack() end
	assert(keyInput.Text == otherKey and fixture.pluginSettings[safeKey] == otherKey and statusCount == 1 and connectCount == 1,
		"the valid canonical key wins without ever authenticating the older legacy key")
	unload()
elseif mode == "tombstone" or mode == "malformed canonical" or mode == "pending state opt-out" then
	for _ = 1, 5 do cycle() end
	assert(fixture.requests == 0 and client.recovery == nil and client.pair == nil, "authoritative canonical state never borrows legacy authorization")
	if mode == "pending state opt-out" then
		assert(fixture.pluginSettings[safeState].autoConnect == false and keyInput.Text == key, "a temporarily unavailable canonical opt-out is honored")
	else assert(keyInput.Text == "" and writes(safeKey) == 0, "empty or malformed canonical key is never overwritten by migration") end
	unload()
elseif mode == "dropped write" or mode == "nil readback" or mode == "exhausted write" then
	idleMount()
	if mode == "nil readback" then fixture.getSettingNilCounts = {[safeKey] = 2}
	else fixture.setSettingDropCounts = {[safeKey] = if mode == "exhausted write" then 99 else 2} end
	enter(key); clickConnect(); cycle(); cycle(); cycle()
	assert(client.pair ~= nil and control.Text == "Connected" and writes(safeKey, key) == 3, "storage has three total attempts without disrupting the live session")
	if mode == "exhausted write" then
		assert(fixture.pluginSettings[safeKey] == nil, "silently dropped bytes cannot be reported as durable")
		local attempts = writes(safeKey, key)
		for _ = 1, 5 do cycle() end
		assert(writes(safeKey, key) == attempts, "exhaustion does not turn into perpetual retries")
		local message = ""
		for _, instance in ipairs(fixture.created) do if instance.Name == "StatusText" then message = instance.Text end end
		assert(string.find(message, "Reconnect", 1, true), "unverified persistence has actionable fixed text")
	else assert(fixture.pluginSettings[safeKey] == key, "a transient drop or nil readback recovers on the same worker") end
	unload()
elseif mode == "pending edit" or mode == "pending unload" then
	idleMount(); fixture.setSettingDropCounts = {[safeKey] = 2}
	enter(key); clickConnect()
	assert(writes(safeKey, key) == 1 and fixture.pluginSettings[safeKey] == nil, "first silent failure leaves a pending write")
	if mode == "pending edit" then
		fixture.setSettingDropCounts = {}
		fixture.pluginSettings[fixture.settingNames.legacyApiKey] = key
		enter(otherKey)
		for _ = 1, 3 do cycle() end
		assert(fixture.requests == 0 and fixture.pluginSettings[safeKey] == "" and writes(safeKey, key) == 1,
			"editing retires the old write and leaves an authoritative tombstone")
	end
	reloadMain(); cycle(); cycle()
	assert(fixture.requests == 0 and writes(safeKey, key) == 1, "no old write or credential resumes after unload/reload")
	unload()
elseif mode == "startup deferred edit" or mode == "startup hidden nil edit" or mode == "startup unload" then
	assert(client.recovery == nil and fixture.requests == 0, "startup reads are still unresolved")
	if mode ~= "startup unload" then
		keyInput.Text = otherKey -- Deliberately defer the Text signal until the worker checks actual input.
		cycle(); cycle()
		assert(keyInput.Text == otherKey and client.recovery == nil and fixture.requests == 0 and fixture.pluginSettings[safeKey] == "",
			"unresolved startup cannot refill a deferred edit and persists a deletion tombstone even after silent nil")
	end
	fixture.getSettingNilCounts = {}
	reloadMain(); cycle(); cycle()
	if mode == "startup unload" then
		assert(client.pair ~= nil, "a new lifetime may perform its own fresh migration after the old one was retired")
	else assert(fixture.requests == 0 and keyInput.Text == "", "an old legacy key cannot resurrect on the next reload") end
	unload()
elseif mode == "dirty opt-out clear" then
	assert(client.recovery == nil and fixture.pluginSettings[safeState].autoConnect == false, "fixture begins explicitly opted out")
	fixture.setSettingDropCounts = {[safeState] = 1}
	enter("intermediate edit")
	assert(fixture.pluginSettings[safeState].autoConnect == false, "the first opt-out-clear write really fails silently")
	enter(otherKey)
	assert(fixture.pluginSettings[safeState].autoConnect == nil, "a later edit reissues the unconfirmed state intent instead of deduplicating it away")
	expectKey = otherKey; clickConnect()
	fixture.uiHttpHook = function(_request: any): any error("offline fixture") end
	cycle(); assert(client.pair == nil and fixture.pluginSettings[safeKey] == otherKey, "the new key is saved while HTTP is offline")
	fixture.uiHttpHook = nil
	reloadMain(); ack()
	assert(keyInput.Text == otherKey and statusCount == 1 and connectCount == 1, "the new key still auto-reconnects because an old opt-out was not left behind")
	unload()
elseif mode == "code edit while loading" then
	enter("123456")
	assert(fixture.pluginSettings[safeKey] == "" and writes(safeKey) == 1 and fixture.requests == 0,
		"editing unresolved startup stores only one empty deletion tombstone")
	control.Activated:Fire()
	assert(client.codePairing ~= nil and keyInput.Text == "" and fixture.requests == 0, "the explicit code click only queues its attempt")
	for _, call in ipairs(fixture.setCalls) do assert(call.key == safeKey and call.value == "", "neither the typed code nor a ticket is ever persisted") end
	unload()
elseif mode == "state read exhaustion" then
	cycle(); cycle()
	assert(client.recovery == nil and fixture.requests == 0, "unreadable preference pauses automatic authentication")
	for _, call in ipairs(fixture.setCalls) do assert(call.key ~= safeState or call.value.autoConnect ~= false, "a read failure never persists an inferred opt-out") end
	fixture.getSettingFaults = {}; clickConnect(); ack()
	assert(fixture.pluginSettings[safeState].autoConnect == nil, "explicit reconnect clears the transient storage pause")
	unload()
else error("Unknown settings fixture.", 0) end
