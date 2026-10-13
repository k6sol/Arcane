--!strict
-- Runs under the official standalone Luau VM, using MockEngine only.
local V, P = Validation, Properties
fixture.encode = function(data: any): string return V.encode(data, http) end
local checks = 0
local function check(condition: boolean, name: string): ()
	assert(condition, name)
	checks += 1
end
local function refuses(code: string?, callback: () -> any): any
	local ok, err = pcall(callback)
	check(not ok, "expected refusal " .. tostring(code))
	if code then check(type(err) == "table" and err.code == code, "expected " .. code .. ", got " .. V.safeError(err)) end
	return err
end
local serial = 0
local function command(method: string, args: any, epoch: number?): any
	serial += 1
	return {protocolVersion = 1, id = "command-" .. serial, requestId = "request-" .. serial,
		sessionId = "session-test", clientSessionId = "client-test", method = method, args = args,
		allowedRoots = {"Workspace"}, allowWrites = true, leaseEpoch = epoch or serial,
		expiresAt = "2099-01-01T00:00:00.000Z", state = "dispatched",
		createdAt = "2026-10-11T00:00:00.000Z", finishedAt = V.NULL, result = V.NULL, error = V.NULL}
end
local function fresh(): any
	fixture.identitySignals = {}
	game.PlaceId, game.GameId, game.Name = 0, 0, "ArcaneDisposableFixture"
	fixture.now, fixture.expiry, fixture.edit = 1000, 2000, true
	fixture.httpHook, fixture.editorHook, fixture.historyHook = nil, nil, nil
	fixture.failProperty, fixture.failBegin, fixture.failFinish, fixture.failDestroy = nil, nil, nil, nil
	fixture.sources, fixture.selection = {}, {}
	fixture.sourceReads = 0
	local workspace = game:GetService("Workspace")
	for _, child in ipairs(workspace:GetChildren()) do child.Parent = nil end
	fixture.writes, fixture.committed, fixture.cancelled = 0, 0, 0
	local pair = {sessionId = "session-test", allowedRoots = {"Workspace"}, allowWrites = true}
	return Operations.new(pair, game, http)
end
local function run(ops: any, method: string, args: any, guard: any?): (any, any)
	local envelope = command(method, args)
	return ops:execute(envelope, guard or function() end), envelope
end
local function attached(ops: any, class: string, name: string): (any, any)
	local instance = Instance.new(class)
	instance.Name = name
	instance.Parent = game:GetService("Workspace")
	return instance, ops.registry:ref(instance)
end
local function transport(writable: boolean?): any
	fresh()
	local client = Transport.new(game, function(_status: any) end)
	fixture.httpHook = function(request: any): any
		check(request.Url == "http://127.0.0.1:45871/v1/plugin/pair", "pair URL is literal")
		check(request.Headers.Authorization == nil and request.Headers.Origin == nil, "pair uses no bearer or browser Origin")
		check(request.Method == "POST" and request.Timeout == 10, "documented RequestAsync parameters")
		return response({sessionId = "session-test", token = "memory-token", protocolVersion = 1,
			allowedRoots = {"Workspace"}, allowWrites = writable ~= false})
	end
	client:requestPair("http://127.0.0.1:45871", "one-use-test-code")
	client:tick()
	check(client.pair ~= nil, "paired transport")
	return client
end
local function targeted(client: any, method: string, args: any, epoch: number?): any
	local envelope = command(method, args, epoch)
	envelope.clientSessionId = client.clientSessionId
	envelope.allowWrites = client.pair.allowWrites
	return envelope
end

-- Wire boundaries, canonical JSON and null/array/object identity.
check(V.encode({empty = {}, list = V.array({}), before = V.NULL}, http) == '{"before":null,"empty":{},"list":[]}', "null/empty containers")
local decoded = V.decode('{"before":null,"items":[null,{},[],true,false,-12.5e+2],"text":"caf\\u00e9\\n\\ud83e\\uddea"}', http)
check(decoded.before == V.NULL and #decoded.items == 6 and decoded.items[1] == V.NULL, "null array positions preserved")
check(decoded.text == "café\n🧪" and decoded.items[6] == -1250, "scalar decode")
check(V.encode(V.immutable(decoded), http) == V.encode(decoded, http), "frozen JSON retains container identity")
check(not V.equal({}, V.array({})) and not V.equal(V.NULL, {}), "containers cannot alias")
for _, invalid in ipairs({'{"x":1,"x":2}', '{"x":null,"x":1}', '{"__proto__":1}', '{"x":01}', '[1,]', '{"x":}', 'true false', '1e999', '"\\uD800"', '"\\q"', '{"x":1,}', ''}) do
	refuses(nil, function() return V.decode(invalid, http) end)
end
refuses(nil, function() return V.decode(string.rep("[", 82) .. "0" .. string.rep("]", 82), http) end)
refuses("INPUT", function() V.object(V.array({}), "object") end)
refuses("INPUT", function() V.list({}, 1, "array") end)
refuses("INPUT", function() V.encode({[1] = 1, key = "mixed"}, http) end)
refuses("INPUT", function() V.string(string.char(255), "source", 1024) end)
refuses("INPUT", function() V.string(string.rep("é", V.SOURCE_BYTES / 2 + 1), "source", V.SOURCE_BYTES) end)
check(V.url("http://127.0.0.1:45871") == "http://127.0.0.1:45871", "literal port accepted")
for _, url in ipairs({"https://127.0.0.1:1", "http://localhost:1", "http://127.0.0.1:01", "http://127.0.0.1:65536", "http://127.0.0.1:1/", "http://127.0.0.1:1@evil", "http://127.0.0.1:1#token"}) do
	refuses(nil, function() return V.url(url) end)
end

-- Registry references use identity, never names or display paths.
do
	local ops = fresh()
	local one, refOne = attached(ops, "Folder", "duplicate")
	local two, refTwo = attached(ops, "Folder", "duplicate")
	check(refOne.instanceId ~= refTwo.instanceId, "duplicate names have distinct refs")
	refOne.pathSegments = V.array({"invented", "display", "path"})
	check(ops.registry:resolve(refOne) == one, "paths are display only")
	local foreign = table.clone(refTwo); foreign.sessionId = "other"
	refuses("SESSION", function() return ops.registry:resolve(foreign) end)
	local guessed = table.clone(refTwo); guessed.instanceId = "duplicate"
	refuses("REF", function() return ops.registry:resolve(guessed) end)
	two.Parent = game:GetService("ReplicatedStorage")
	refuses("REF", function() return ops.registry:resolve(refTwo) end)
	check(#run(ops, "scene.children", {root = "Workspace"}).items == 1, "children only current root")
	local read = run(ops, "scene.inspect", {ref = refOne})
	check(read.properties.Source == nil and read.properties.Parent == nil, "inspect is allowlisted")
	fixture.selection = {one, two}
	check(#run(ops, "selection.read", {}).items == 1, "selection filters root grants")
	local empty = run(ops, "scene.search", {root = "Workspace", query = "absent"})
	check(V.encode(empty, http) == '{"items":[],"truncated":false}', "empty search emits array")
	refuses("INPUT", function() run(ops, "scene.search", {root = "Workspace", query = ""}) end)
	refuses("METHOD", function() run(ops, "script.eval", {source = "return 1"}) end)
end

-- Validate every create property before allocation/parenting, disable scripts.
do
	local ops = fresh()
	local parent = ops.registry:ref(game:GetService("Workspace"))
	local count = #fixture.created
	refuses("PROPERTY", function() run(ops, "scene.create", {parent = parent, className = "Script", name = "unsafe", properties = {Source = "print(1)"}}) end)
	check(#fixture.created == count, "invalid create never allocates")
	refuses("CLASS", function() run(ops, "scene.create", {parent = parent, className = "RemoteEvent", name = "unsafe"}) end)
	for _, class in ipairs({"Script", "LocalScript", "ModuleScript"}) do
		local result = run(ops, "scene.create", {parent = parent, className = class, name = class})
		local instance = ops.registry:resolve(result.ref)
		check(class == "ModuleScript" or instance.Disabled == true, "new BaseScripts disabled")
		check(result.mutation.before == V.NULL and string.find(V.encode(result, http), '"before":null', 1, true) ~= nil, "creation receipt has explicit null")
	end
end

-- Expected properties must exactly cover changes; receipts snapshot the engine.
do
	local ops = fresh()
	local part, ref = attached(ops, "Part", "part")
	refuses("INPUT", function() run(ops, "scene.update", {ref = ref, expected = {Anchored = false, Name = "part"}, properties = {Anchored = true}}) end)
	refuses("CONFLICT", function() run(ops, "scene.update", {ref = ref, expected = {}, properties = {Anchored = true}}) end)
	refuses("CONFLICT", function() run(ops, "scene.update", {ref = ref, expected = {Anchored = true}, properties = {Anchored = true}}) end)
	refuses("SERVICE", function() run(ops, "scene.update", {ref = ops.registry:ref(game:GetService("Workspace")), expected = {Name = "Workspace"}, properties = {Name = "Oops"}}) end)
	refuses("PROPERTY", function() run(ops, "scene.update", {ref = ref, expected = {Source = ""}, properties = {Source = "no"}}) end)
	local result, receipt = run(ops, "scene.update", {ref = ref, expected = {Position = P.encode("Position", part.Position), Anchored = false},
		properties = {Position = {type = "Vector3", value = {0.1, 0.2, 0.3}}, Anchored = true}})
	check(result.mutation.after.properties.Position.value[1] == part.Position.X, "receipt contains actual float32 value")
	local restored = run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation})
	check(restored.restored and not part.Anchored and part.Position == Vector3.new(0, 0, 0), "property restore applies exact original")
	refuses("RECEIPT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}) end)
end

-- Restore never clobbers later edits and requires immutable locally issued receipt.
do
	local ops = fresh()
	local parent = ops.registry:ref(game:GetService("Workspace"))
	local result, receipt = run(ops, "scene.create", {parent = parent, className = "Folder", name = "owned"})
	local instance = ops.registry:resolve(result.ref)
	local forged = V.decode(V.encode(result.mutation, http), http); forged.after.properties.Name = "forged"
	refuses("RECEIPT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = forged}) end)
	instance.Name = "user edit"
	refuses("CONFLICT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}) end)
	instance.Name = "owned"
	local child = Instance.new("Folder"); child.Parent = instance
	refuses("CONFLICT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}) end)
	child.Parent = nil
	instance._attributes.changed = true
	refuses("CONFLICT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}) end)
	instance._attributes = {}
	fixture.historyHook = function() instance.Name = "changed at begin"; fixture.historyHook = nil end
	refuses("CONFLICT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}) end)
	check(not instance._destroyed, "restore rechecks immediately before destruction")
	instance.Name = "owned"
	check(run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}).restored and instance._destroyed, "unchanged owned create restored")
end

-- Editor source, callback conflicts and fences, source size and recovery receipts.
do
	local ops = fresh()
	local instance, ref = attached(ops, "ModuleScript", "module")
	instance.Source = "saved"; fixture.sources[instance] = "dirty"
	check(run(ops, "script.read", {ref = ref}).source == "dirty", "reads dirty editor source")
	refuses("CONFLICT", function() run(ops, "script.update", {ref = ref, expectedSource = "saved", source = "new"}) end)
	local result, receipt = run(ops, "script.update", {ref = ref, expectedSource = "dirty", source = "new"})
	check(result.mutation.before.source == "dirty" and fixture.sources[instance] == "new", "editor update receipt")
	fixture.sources[instance] = "later"
	refuses("CONFLICT", function() run(ops, "scene.restore", {receiptCommandId = receipt.id, mutation = result.mutation}) end)
	fixture.editorHook = function(target: any, callback: any)
		check(callback("concurrent") == nil, "callback cancels baseline conflict")
		check(callback("later") == nil, "callback conflict remains sticky")
		fixture.sources[target] = "concurrent"
	end
	refuses("CONFLICT", function() run(ops, "script.update", {ref = ref, expectedSource = "later", source = "next"}) end)
	fixture.editorHook = nil
	fixture.sources[instance] = string.rep("\1", 50000)
	local writes = fixture.writes
	refuses("BODY_LIMIT", function() run(ops, "script.update", {ref = ref, expectedSource = fixture.sources[instance], source = string.rep("\2", 50000)}) end)
	check(fixture.writes == writes, "overlarge escaped receipt rejected before mutation")
	fixture.sources[instance] = "baseline"
	local active = true
	fixture.editorHook = function(_target: any, callback: any) active = false; callback("baseline") end
	refuses("SESSION", function() run(ops, "script.update", {ref = ref, expectedSource = "baseline", source = "next"}, function() if not active then V.fail("SESSION", "fenced") end end) end)
	check(fixture.sources[instance] == "baseline", "callback fence prevents write")
end

-- Every transport command rechecks session, grants, edit mode and lease.
do
	local client = transport()
	local base = targeted(client, "selection.read", {}, 10000)
	for field, value in pairs({sessionId = "other", clientSessionId = "other", protocolVersion = 2, allowWrites = false, state = "queued"}) do
		local wrong = table.clone(base); wrong[field] = value
		refuses(nil, function() client:dispatch(wrong) end)
	end
	local wrongRoots = table.clone(base); wrongRoots.allowedRoots = {"ServerStorage"}
	refuses("GRANT", function() client:dispatch(wrongRoots) end)
	fixture.expiry = fixture.now
	client:dispatch(base)
	check(client.pending.body.state == "failed" and string.find(client.pending.body.error, "LEASE", 1, true) ~= nil, "expired lease refused")
	fixture.expiry = 2000
	local stale = targeted(client, "selection.read", {}, 9999)
	refuses("LEASE", function() client:dispatch(stale) end)
	fixture.edit = false
	client:dispatch(targeted(client, "selection.read", {}, 10001))
	check(client.pending.body.state == "failed" and string.find(client.pending.body.error, "PLAY", 1, true) ~= nil, "play mode fenced")
end
do
	local client = transport(false)
	local parent = client.operations.registry:ref(game:GetService("Workspace"))
	client:dispatch(targeted(client, "scene.create", {parent = parent, className = "Folder", name = "denied"}, 20000))
	check(client.pending.body.state == "failed" and #game:GetService("Workspace"):GetChildren() == 0, "read-only pairing blocks writes")
end

-- Receipt retry is immutable, single-flight, never repeats mutation.
do
	local client = transport()
	local parent = client.operations.registry:ref(game:GetService("Workspace"))
	local envelope = targeted(client, "scene.create", {parent = parent, className = "Folder", name = "once"}, 30000)
	client:dispatch(envelope)
	local writes, receipt = fixture.writes, client.pending
	fixture.httpHook = function(_request: any): any error("network error containing memory-token") end
	check(client:cycle() == 4 and client.pending == receipt, "receipt network failure retains receipt with backoff")
	client:dispatch(envelope)
	check(fixture.writes == writes and client.pending == receipt, "duplicate dispatch never reruns mutation")
	local sent
	fixture.httpHook = function(request: any): any
		check(request.Headers.Authorization == "Bearer memory-token", "plugin bearer used")
		sent = request.Body
		return response({accepted = true})
	end
	client:tick()
	check(receipt.acknowledged and client.pending == nil and sent == V.encode(receipt.body, http), "receipt acknowledgement")
	client:dispatch(envelope)
	check(fixture.writes == writes, "acknowledged duplicate still never reruns")
	local reused = table.clone(envelope); reused.args = {parent = parent, className = "Folder", name = "different"}
	refuses("RECONCILE", function() client:dispatch(reused) end)
	client.inFlight = true
	refuses("FLIGHT", function() client:post(client.pair.url, "/v1/plugin/poll", {sessionId = "session-test"}, "memory-token") end)
	client.inFlight = false
	check(not string.find(V.safeError("memory-token"), "memory-token", 1, true), "unstructured errors redact bearer")
end

-- Partial mutation failures are reported and block further work.
do
	local client = transport()
	local part, ref = attached(client.operations, "Part", "partial")
	fixture.failProperty = "Transparency"
	client:dispatch(targeted(client, "scene.update", {ref = ref, expected = {Anchored = false, Transparency = 0}, properties = {Anchored = true, Transparency = 0.5}}, 40000))
	check(part.Anchored and client.blocked and client.pending.body.state == "failed", "partial update blocked")
	check(client.pending.body.result.partial and client.pending.body.result.rollbackVerified == false, "failure exposes recovery details")
	fixture.failProperty = nil
	local requests = fixture.requests
	fixture.httpHook = function(_request: any): any return response({accepted = true}) end
	client:tick()
	client:tick()
	check(fixture.requests == requests + 1, "blocked session sends receipt but never polls more commands")
end

-- Late polls, one-use pairing failure, daemon restart, redirects and response bounds.
do
	local client = transport()
	local envelope = targeted(client, "selection.read", {}, 50000)
	fixture.httpHook = function(_request: any): any client:requestDisconnect(); return response({commands = {envelope}}) end
	client:tick()
	check(client.cacheCount == 0, "late poll cannot dispatch after disconnect")
	client:stop()
	check(client.pair == nil and client.pending == nil and next(client.cache) == nil, "unload clears bearer and command memory")
end
do
	local client = Transport.new(game, function(_status: any) end)
	local requests = fixture.requests
	fixture.httpHook = function(_request: any): any error("uncertain pair") end
	client:requestPair("http://127.0.0.1:45871", "one-use")
	client:cycle(); client:cycle()
	check(fixture.requests == requests + 1 and client.desiredPair == nil, "one-use pairing never retries uncertainty")
end
for _, status in ipairs({301, 302, 307, 308, 401, 403, 409}) do
	local client = transport()
	fixture.httpHook = function(_request: any): any return response({}, status) end
	refuses(if status < 400 then "REDIRECT" elseif status == 401 or status == 403 then "REVOKED" else "RECONCILE",
		function() client:post(client.pair.url, "/v1/plugin/poll", {sessionId = "session-test"}, client.pair.token) end)
	check(not client.inFlight, "HTTP flight released on refusal")
end
for _, status in ipairs({401, 403}) do
	local client = transport()
	local statuses: any = {}
	client.onStatus = function(value: any): () table.insert(statuses, value) end
	fixture.httpHook = function(_request: any): any return response({}, status) end
	local requests = fixture.requests
	client:cycle()
	check(client.pair == nil, "daemon restart revocation clears token")
	check(statuses[#statuses].state == "disconnected" and statuses[#statuses].sessionId == nil, "poll revocation remains disconnected, never key-rejected")
	client:cycle(); client:cycle()
	check(fixture.requests == requests + 1, "revoked poll does not reconnect automatically")
end
do
	local client = transport()
	fixture.httpHook = function(_request: any): any return {StatusCode = 200, Success = true, Body = string.rep("x", V.RESULT_BYTES + V.ARGUMENT_BYTES + 8193)} end
	refuses("BODY_LIMIT", function() client:tick() end)
	fixture.httpHook = function(_request: any): any return response({commands = {}}) end
	refuses("INPUT", function() client:tick() end)
end

-- Human API keys derive only loopback origins and are discarded after exchange.
do
	local key = "arcane_local_v1_45871_" .. string.rep("a", 64)
	check(V.keyOrigin(key) == "http://127.0.0.1:45871", "key derives only literal loopback")
	check(V.keyOrigin("arcane_local_v1_1_" .. string.rep("a", 64)) == "http://127.0.0.1:1", "ASCII hexadecimal and lowest port")
	check(V.keyOrigin("arcane_local_v1_65535_" .. string.rep("0", 64)) == "http://127.0.0.1:65535", "highest port")
	for _, malformed in ipairs({
		"arcane_local_v1_0_" .. string.rep("a", 64), "arcane_local_v1_65536_" .. string.rep("a", 64),
		"arcane_local_v1_045871_" .. string.rep("a", 64), "arcane_local_v1_45871_" .. string.rep("a", 63),
		"arcane_local_v1_45871_" .. string.rep("a", 65), "arcane_local_v1_45871_" .. string.rep("g", 64),
		"arcane_local_v1_45871_" .. string.rep("A", 64), key .. "/", key .. "\n", " " .. key, key .. "#fragment", "arcane_local_v1_localhost_" .. string.rep("a", 64),
		"arcane_local_v1_４５８７１_" .. string.rep("a", 64), "provider-key", "http://127.0.0.1:45871",
	}) do
		local err = refuses(nil, function() return V.keyOrigin(malformed) end)
		check(not string.find(V.safeError(err), malformed, 1, true), "key validation never echoes secret")
	end
	fresh()
	local statuses: any = {}
	local client = Transport.new(game, function(status: any) table.insert(statuses, status) end)
	client:requestConnect(key)
	local waiting = client.desiredPair
	fixture.httpHook = function(request: any): any
		check(request.Url == "http://127.0.0.1:45871/v1/plugin/connect", "connect uses fixed route and key port")
		check(request.Headers.Authorization == nil and request.Headers.Origin == nil, "connect has no control/plugin bearer")
		local body = V.decode(request.Body, http)
		V.fields(body, {"apiKey", "protocolVersion", "identity", "capabilities"}, "connect payload")
		check(body.apiKey == key and body.code == nil and body.url == nil, "key-only wire contract")
		check(body.identity.clientSessionId == client.clientSessionId and body.protocolVersion == 1, "connect identity and protocol")
		check(#body.capabilities == #V.READ_METHODS + #V.WRITE_METHODS, "explicit method capabilities")
		check(waiting.apiKey == nil and client.desiredPair == nil, "key forgotten before yielding HTTP")
		return response({sessionId = "session-test", token = "plugin-memory-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = false})
	end
	client:tick()
	check(client.pair.token == "plugin-memory-token" and client.pair.apiKey == nil and not client.pair.allowWrites, "retains only session bearer and returned read grant")
	for _, status in ipairs(statuses) do
		check(not string.find(V.encode(status, http), key, 1, true), "status never exposes API key")
	end
	client:requestDisconnect()
	check(client.desiredPair == nil, "disconnect clears queued key")
	client:stop()
	check(client.pair == nil, "stop clears session bearer")
end
do
	fresh()
	local key = "arcane_local_v1_45871_" .. string.rep("b", 64)
	local client = Transport.new(game, function(_status: any) end)
	client:requestConnect(key)
	local previous = client.desiredPair
	client:requestConnect("arcane_local_v1_45872_" .. string.rep("c", 64))
	check(previous.apiKey == nil, "replacement forgets old queued key")
	local current = client.desiredPair
	client:requestDisconnect()
	check(current.apiKey == nil and client.desiredPair == nil, "cancel forgets current queued key")
	client:requestConnect(key)
	local stopped = client.desiredPair
	client:stop()
	check(stopped.apiKey == nil, "unload forgets unexchanged key")
end
do
	fresh()
	local key = "arcane_local_v1_45871_" .. string.rep("d", 64)
	local statuses: any = {}
	local client = Transport.new(game, function(status: any) table.insert(statuses, status) end)
	local requests = fixture.requests
	fixture.httpHook = function(_request: any): any error("network error containing " .. key) end
	client:requestConnect(key)
	local queued = client.desiredPair
	client:cycle(); client:cycle(); client:cycle()
	check(fixture.requests == requests + 1 and client.pair == nil and queued.apiKey == nil, "uncertain connect never automatically retries or retains key")
	check(statuses[#statuses].state == "disconnected" and not string.find(statuses[#statuses].detail, key, 1, true), "uncertain connection is visibly disconnected with redacted error")
	for _, status in ipairs(statuses) do check(status.state ~= "failed", "network uncertainty is not a key rejection") end
end

-- Only a current connect-route 401/403 retires the human key intent. Recovery is
-- another explicit exchange, and late rejection cannot cancel a newer intent.
for _, statusCode in ipairs({401, 403}) do
	fresh()
	local wrongKey = "arcane_local_v1_45871_" .. string.rep("f", 64)
	local correctKey = "arcane_local_v1_45871_" .. string.rep("a", 64)
	local statuses: any = {}
	local client = Transport.new(game, function(status: any): () table.insert(statuses, status) end)
	fixture.httpHook = function(_request: any): any return response({}, statusCode) end
	refuses("KEY_REJECTED", function() client:post("http://127.0.0.1:45871", "/v1/plugin/connect", {apiKey = wrongKey}, nil) end)
	client:requestConnect(wrongKey)
	local rejected, generation, requests = client.desiredPair, client.generation, fixture.requests
	client:cycle()
	check(rejected.apiKey == nil and client.desiredPair == nil and client.generation > generation, "rejection erases and retires only the current key intent")
	check(client.pair == nil and client.operations == nil and client.pending == nil and client.identityFence == nil and not client.blocked, "rejected exchange clears session state and identity observers")
	local failure = statuses[#statuses]
	check(failure.state == "failed" and failure.sessionId == nil and #failure.allowedRoots == 0 and not failure.allowWrites, "key-rejected status never grants a live session")
	check(string.find(failure.detail, "Enter a new API key", 1, true) ~= nil and not string.find(V.encode(failure, http), wrongKey, 1, true), "rejection requests a replacement without exposing the key")
	client:cycle(); client:cycle()
	check(fixture.requests == requests + 1 and statuses[#statuses] == failure, "rejected key never retries or replaces its failure status automatically")
	fixture.httpHook = function(request: any): any
		check(V.decode(request.Body, http).apiKey == correctKey, "explicit recovery sends only the new key")
		return response({sessionId = "session-test", token = "recovery-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = false})
	end
	client:requestConnect(correctKey)
	check(client.pair == nil and statuses[#statuses].state == "connecting", "replacement intent is not an ACK")
	client:cycle()
	check(fixture.requests == requests + 2 and client.pair ~= nil and client.pair.token == "recovery-token" and client.desiredPair == nil, "new correct key recovers in exactly one exchange")
	check(statuses[#statuses].state == "connected" and statuses[#statuses].sessionId == "session-test", "only the recovery ACK reports connected")
	client:stop()

	fresh()
	statuses = {}
	client = Transport.new(game, function(status: any): () table.insert(statuses, status) end)
	client:requestConnect(wrongKey)
	local replacement: any = nil
	fixture.httpHook = function(_request: any): any
		client:requestConnect(correctKey)
		replacement = client.desiredPair
		return response({}, statusCode)
	end
	client:cycle()
	check(client.desiredPair == replacement and replacement.apiKey == correctKey and client.generation == replacement.generation, "stale rejection preserves the newer desired key and generation")
	check(statuses[#statuses].state == "connecting", "stale rejection cannot publish failed over a newer intent")
	fixture.httpHook = function(request: any): any
		check(V.decode(request.Body, http).apiKey == correctKey, "stale rejection recovery exchanges the newer key")
		return response({sessionId = "session-test", token = "newer-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = false})
	end
	client:cycle()
	check(client.pair ~= nil and client.desiredPair == nil and statuses[#statuses].state == "connected", "newer intent ACK survives the older rejection")
	client:stop()
end

do
	fresh()
	local statuses: any = {}
	local client = Transport.new(game, function(status: any): () table.insert(statuses, status) end)
	fixture.httpHook = function(_request: any): any return response({}, 500) end
	client:requestConnect("arcane_local_v1_45871_" .. string.rep("a", 64))
	local requests = fixture.requests
	client:cycle(); client:cycle()
	check(fixture.requests == requests + 1 and statuses[#statuses].state == "disconnected", "HTTP 500 is an uncertain exchange, not a rejected key or automatic retry")
	client:stop()
end
do
	fresh()
	local key = "arcane_local_v1_45871_" .. string.rep("a", 64)
	local client = Transport.new(game, function(_status: any) end)
	client:requestConnect(key)
	local queued, requests = client.desiredPair, fixture.requests
	refuses("KEY", function() client:requestConnect("malformed-replacement") end)
	check(client.desiredPair == queued and fixture.requests == requests, "transport validation rejects malformed input before any exchange or intent mutation")
	client:requestDisconnect() -- Main's malformed-replacement branch explicitly fences the old intent.
	check(queued.apiKey == nil and client.desiredPair == nil, "internal malformed replacement disconnect forgets old queued key")
	client:cycle(); client:cycle()
	check(fixture.requests == requests and client.pair == nil, "malformed replacement never dispatches or automatically retries")
	fixture.httpHook = function(request: any): any
		check(V.decode(request.Body, http).apiKey == key, "new valid key replaces malformed intent")
		return response({sessionId = "session-test", token = "replacement-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = false})
	end
	client:requestConnect(key); client:cycle()
	check(client.pair ~= nil and client.desiredPair == nil and fixture.requests == requests + 1, "malformed then new key recovers with one explicit exchange")
	client:stop()
end
do
	fresh()
	local key = "arcane_local_v1_45871_" .. string.rep("e", 64)
	local client = Transport.new(game, function(_status: any) end)
	local requests = fixture.requests
	fixture.edit = false
	refuses("PLAY", function() client:requestConnect(key) end)
	check(fixture.requests == requests and client.desiredPair == nil, "play mode refuses key exchange")
	fixture.edit = true
	client:requestConnect(key)
	fixture.httpHook = function(_request: any): any
		client:requestDisconnect()
		return response({sessionId = "session-test", token = "late-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = true})
	end
	client:tick()
	check(client.disconnectRequested and client.pair.generation ~= client.generation, "late key exchange is fenced for revocation")
	refuses("SESSION", function() client:guard(targeted(client, "selection.read", {}, 60000), client.pair) end)
end

-- The exact initial exchange identity is pinned, including across yielding HTTP.
for _, field in ipairs({"PlaceId", "GameId", "Name"}) do
	for _, route in ipairs({"connect", "pair"}) do
		fresh()
		local statuses: any = {}
		local client = Transport.new(game, function(status: any) table.insert(statuses, status) end)
		local original = game[field]
		fixture.httpHook = function(request: any): any
			local initial = V.decode(request.Body, http).identity
			check(initial.placeId == 0 and initial.universeId == 0 and initial.name == "ArcaneDisposableFixture", "exchange payload captures original engine identity")
			game[field] = if field == "Name" then "OtherFixture" else 42
			game[field] = original -- Change-and-return must still retire this exchange.
			return response({sessionId = "session-test", token = "old-place-token", protocolVersion = 1, allowedRoots = {"Workspace"}, allowWrites = true})
		end
		if route == "connect" then client:requestConnect("arcane_local_v1_45871_" .. string.rep("a", 64))
		else client:requestPair("http://127.0.0.1:45871", "identity-fixture") end
		local writes, requests = fixture.writes, fixture.requests
		client:cycle(); client:cycle()
		check(client.pair ~= nil and client.pair.identityFence.changed and client.blocked and client.operations == nil, "changed exchange ACK cannot create root registry")
		check(client.pair.identityFence.identity.name == "ArcaneDisposableFixture" and table.isfrozen(client.pair.identityFence.identity), "pinned identity is immutable initial payload")
		check(fixture.writes == writes and fixture.requests == requests + 1 and client.desiredPair == nil, "changed exchange never reads scene, writes, retries or polls")
		check(statuses[#statuses].state == "reconciliation" and not statuses[#statuses].allowWrites, "changed exchange never reports connected grants")
		client:stop()
	end
end

-- A poll resumed in another identity cannot dispatch even a read command.
for _, field in ipairs({"PlaceId", "GameId", "Name"}) do
	local client = transport()
	local envelope = targeted(client, "selection.read", {}, 70000)
	local original = game[field]
	local writes, requests = fixture.writes, fixture.requests
	fixture.httpHook = function(_request: any): any
		game[field] = if field == "Name" then "OtherFixture" else 42
		game[field] = original
		return response({commands = V.array({envelope})})
	end
	refuses("IDENTITY", function() client:tick() end)
	client:cycle()
	check(client.blocked and client.cacheCount == 0 and fixture.writes == writes and fixture.requests == requests + 1, "changed poll refuses queued read and stops polling after values revert")
	client:stop()
end

-- Current-value comparison also fences work before deferred property signals.
do
	local client = transport()
	local parent = client.operations.registry:ref(game:GetService("Workspace"))
	local queued = targeted(client, "scene.create", {parent = parent, className = "Model", name = "NeverCreate"}, 71000)
	local writes = fixture.writes
	game._identity.PlaceId = 42 -- Simulate a deferred GetPropertyChangedSignal.
	refuses("IDENTITY", function() client:dispatch(queued) end)
	game._identity.PlaceId = 0
	refuses("IDENTITY", function() client:dispatch(queued) end)
	check(client.blocked and client.pending == nil and fixture.writes == writes, "queued mutation cannot pass a latched identity fence")
	client:stop()
end

-- UpdateSourceAsync callbacks are non-yielding identity guards, not a rollback.
for _, phase in ipairs({"before-callback", "callback-reinvocation", "editor-return"}) do
	local client = transport()
	local applied = phase ~= "before-callback"
	local scriptInstance, ref = attached(client.operations, "Script", "IdentityCallback")
	fixture.sources[scriptInstance] = "before"
	local update = targeted(client, "script.update", {ref = ref, expectedSource = "before", source = "after"}, 72000)
	local readsBeforeChange = 0
	fixture.editorHook = function(instance: any, callback: any): ()
		if applied then
			fixture.sources[instance] = callback("before") -- First proposal already applied.
		end
		game.Name = "OtherFixture"
		game.Name = "ArcaneDisposableFixture"
		readsBeforeChange = fixture.sourceReads
		if phase == "editor-return" then return end -- No callback reinvocation.
		callback(if applied then "after" else "before")
	end
	local writes = fixture.writes
	client:dispatch(update)
	check(client.blocked and client.pending.body.state == "failed" and fixture.writes == writes, "callback identity change blocks further mutation")
	check(fixture.sources[scriptInstance] == (if applied then "after" else "before"), "identity fence never rolls back an applied editor proposal")
	check(fixture.sourceReads == readsBeforeChange, "changed editor return never rereads source")
	if applied then check(client.pending.body.result.partial and not client.pending.body.result.rollbackVerified, "applied proposal retains ambiguous recovery receipt") end
	fixture.httpHook = function(request: any): any
		check(string.find(request.Url, "/v1/plugin/result", 1, true) ~= nil, "blocked callback delivers only existing receipt")
		return response({accepted = true})
	end
	local requests = fixture.requests
	client:tick(); client:tick()
	check(fixture.requests == requests + 1 and client.pending == nil and client.blocked, "receipt ACK cannot resume callback-fenced work")
	client:stop()
end

-- Successful/cached receipts survive a switch, without enabling more work.
do
	local client = transport()
	local parent = client.operations.registry:ref(game:GetService("Workspace"))
	local create = targeted(client, "scene.create", {parent = parent, className = "Model", name = "AlreadyApplied"}, 73000)
	client:dispatch(create)
	local receipt = client.pending
	check(receipt.body.state == "succeeded" and not client.blocked, "unchanged identity mutation succeeds")
	game.GameId = 42
	game.GameId = 0
	local writes = fixture.writes
	refuses("IDENTITY", function() client:dispatch(create) end)
	fixture.httpHook = function(request: any): any
		check(request.Body == V.encode(receipt.body, http), "identity switch preserves exact existing receipt")
		return response({accepted = true})
	end
	client:tick()
	check(receipt.acknowledged and client.blocked and client.pending == nil, "successful receipt ACK retains identity latch")
	refuses("IDENTITY", function() client:dispatch(create) end)
	local requests = fixture.requests
	client:cycle()
	check(fixture.writes == writes and fixture.requests == requests, "cached receipt never re-enables work or automatic cleanup")
	local connections = table.clone(client.identityFence.connections)
	client:stop()
	for _, connection in ipairs(connections) do check(not connection.Connected, "unload disconnects identity watchers") end
end
do
	local client = transport()
	fixture.httpHook = function(_request: any): any return response({commands = V.array({})}) end
	client:tick()
	check(not client.blocked and not client.identityFence.changed and client.operations ~= nil, "unchanged identity poll remains usable")
	client:stop()
end

print("Arcane logic checks passed: " .. checks)
