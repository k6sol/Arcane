--!strict
-- Official standalone Luau VM + MockEngine doubles, never real Studio evidence.
local V = contextRequire("Validation")
local Operations = contextRequire("Operations")
local Transport = contextRequire("Transport")
fixture.encode = function(value: any): string return V.encode(value, http) end
Enum.CreatorType = enumCategory({"User", "Group"})
game._identity.CreatorId, game._identity.CreatorType = 0, Enum.CreatorType.User
fixture.localUserId, fixture.userCalls = 78, 0
services.StudioService = {GetUserId = function(_self: any): any
	fixture.userCalls += 1
	if fixture.userHook then fixture.userHook() end
	if fixture.userError then error("private fixture error must not escape") end
	return fixture.localUserId
end}

local checks, serial = 0, 0
local function check(value: any, message: string): () assert(value, message); checks += 1 end
local function counters(): any
	return {writes = fixture.writes, created = #fixture.created, committed = fixture.committed,
		cancelled = fixture.cancelled, requests = fixture.requests, sourceReads = fixture.sourceReads or 0}
end
local function unchanged(before: any): () check(V.equal(before, counters()), "context read never assigns, allocates Instances, edits source, records history or calls HTTP") end
local function identity(place: number, universe: number, creator: number, kind: any): ()
	-- Direct fixture storage setup is deliberately not an engine observation.
	game._identity.PlaceId, game._identity.GameId = place, universe
	game._identity.CreatorId, game._identity.CreatorType = creator, kind
	fixture.edit, fixture.userError, fixture.userHook, fixture.userCalls, fixture.localUserId = true, false, nil, 0, 78
end
local function client(roots: {string}?): any
	local transport = Transport.new(game, function(_status: any): () end)
	fixture.httpHook = function(request: any): any
		check(request.Url == "http://127.0.0.1:45871/v1/plugin/pair", "only mocked pairing is used")
		local input = V.decode(request.Body, http)
		check(table.find(input.capabilities, "scene.import_context") ~= nil, "actual exchange advertises the read capability")
		return response({sessionId = "context-session-" .. transport.clientSessionId, token = "fixture-memory-token",
			protocolVersion = 1, allowedRoots = roots or {"Workspace"}, allowWrites = false})
	end
	transport:requestPair("http://127.0.0.1:45871", "fixture-code")
	transport:tick()
	check(transport.pair ~= nil and transport.operations ~= nil and not transport.pair.allowWrites, "actual transport uses a read-only double pairing")
	return transport
end
local function command(transport: any, args: any?): any
	serial += 1
	return {protocolVersion = 1, id = "context-command-" .. serial, requestId = "context-request-" .. serial,
		sessionId = transport.pair.sessionId, clientSessionId = transport.clientSessionId,
		method = "scene.import_context", args = args or {}, allowedRoots = V.array(table.clone(transport.pair.allowedRoots)),
		allowWrites = false, leaseEpoch = serial, expiresAt = "2099-01-01T00:00:00.000Z", state = "dispatched"}
end
local function run(transport: any, args: any?): (any, any)
	local cmd, before = command(transport, args), counters()
	transport:dispatch(cmd)
	unchanged(before)
	local payload = transport.pending.body
	check(payload.commandId == cmd.id and payload.sessionId == cmd.sessionId, "exact command/session receipt envelope")
	check(transport.operations.mutations[cmd.id] == nil and (payload.result == nil or payload.result.mutation == nil), "context never emits a mutation receipt")
	return payload, cmd
end
local function succeed(transport: any): (any, any)
	local payload, cmd = run(transport)
	check(payload.state == "succeeded", tostring(payload.error))
	local value = payload.result
	check(value.sessionId == cmd.sessionId and value.root == "Workspace", "actual session and root")
	check(value.parentRef.sessionId == cmd.sessionId and value.parentRef.root == "Workspace"
		and value.parentRef.className == "Workspace" and #value.parentRef.pathSegments == 0, "actual Workspace root ref")
	check(transport.operations.registry:resolve(value.parentRef) == services.Workspace, "opaque ref resolves to the actual granted Instance")
	check(transport.operations.registry.byId[value.parentRef.instanceId] == services.Workspace, "ref is registered locally, never inferred from a display path")
	check(table.isfrozen(value) and table.isfrozen(value.creator) and table.isfrozen(value.studioUser), "read receipt snapshots are immutable")
	check(value.modeProvenance == "StudioTestService.EditModeActive" and value.creator.provenance == "game.CreatorType/CreatorId"
		and value.studioUser.provenance == "StudioService:GetUserId", "exact observation provenance")
	check(#V.encode(value, http) < V.RESULT_BYTES, "bounded JSON result")
	check(V.equal(value, V.decode(V.encode(value, http), http)), "nulls and empty paths survive the real protocol codec")
	return value, cmd
end
local function refuse(transport: any, args: any, code: string, fenced: boolean?): ()
	local payload = run(transport, args)
	check(payload.state == "failed" and string.sub(payload.error, 1, #code + 1) == code .. ":", tostring(payload.error))
	check(payload.result == nil and not transport.pending.unsafe, "read failure never claims a mutation or reconciliation write")
	check(transport.blocked == (fenced == true), "existing identity fencing is preserved")
end

for _, kind in ipairs({"User", "Group"}) do
	identity(12, 34, 56, Enum.CreatorType[kind])
	local transport = client()
	local value = succeed(transport)
	check(value.placeId == 12 and value.universeId == 34 and value.mode == "Edit", "exact published identity")
	check(value.creator.status == "available" and value.creator.id == 56 and value.creator.kind == string.lower(kind), "actual published place owner")
	check(value.studioUser.status == "not_applicable" and value.studioUser.id == V.NULL and fixture.userCalls == 0, "published owners never fall back to a Studio user")
end

identity(0, 0, 0, Enum.CreatorType.User)
local localTransport = client()
local localValue, localCommand = succeed(localTransport)
check(localValue.creator.status == "unavailable" and localValue.creator.kind == V.NULL and localValue.creator.id == 0, "local place remains without a published creator")
check(localValue.studioUser.status == "available" and localValue.studioUser.id == 78 and fixture.userCalls == 1, "separate actual local Studio user")
local cached = localTransport.pending
fixture.localUserId = 90
local beforeReplay = counters()
localTransport:dispatch(localCommand)
unchanged(beforeReplay)
check(localTransport.pending == cached and cached.body.result.studioUser.id == 78 and fixture.userCalls == 1, "duplicate command replays its original immutable observation")
local fresh = succeed(localTransport)
check(fresh.studioUser.id == 90 and fixture.userCalls == 2 and fresh.parentRef.instanceId == localValue.parentRef.instanceId, "a new command observes current user and reuses the actual Workspace ref")
check(localTransport.operations.registry.count == 1, "repeated reads do not exhaust reference capacity")
local forged = V.immutable(localCommand)
forged = table.clone(forged); forged.args = {root = "Workspace"}
local replayOk, replayError = pcall(function() localTransport:dispatch(forged) end)
check(not replayOk and replayError.code == "RECONCILE", "changed payload cannot reuse a cached command ID")

for _, value in ipairs({0, -1, 0.5, 9007199254740992, "78", false}) do
	identity(0, 0, 0, Enum.CreatorType.User)
	fixture.localUserId = value
	local result = succeed(client())
	check(result.studioUser.status == "unavailable" and result.studioUser.id == V.NULL, "anonymous/invalid Studio identity stays unavailable")
end
for _, unavailable in ipairs({"error", "missing"}) do
	identity(0, 0, 0, Enum.CreatorType.User)
	fixture.userError = unavailable == "error"
	if unavailable == "missing" then fixture.localUserId = nil end
	local result = succeed(client())
	check(result.studioUser.status == "unavailable" and result.studioUser.id == V.NULL, "failed/missing Studio user stays unavailable without leaking error text")
end

for _, ids in ipairs({{12, 0, 0}, {0, 34, 0}, {0, 0, 56}, {12, 34, 0}}) do
	identity(ids[1], ids[2], ids[3], Enum.CreatorType.User)
	local result = succeed(client())
	check(result.studioUser.status == "not_applicable" and fixture.userCalls == 0, "all three zeros are required, including template/partial IDs")
end
identity(12, 34, 56, {Name = "User"})
local unknown = succeed(client())
check(unknown.creator.status == "unavailable" and unknown.creator.kind == V.NULL and unknown.creator.id == 56 and fixture.userCalls == 0, "unknown native creator enum never becomes an invented owner")

identity(12, 34, 56, Enum.CreatorType.Group)
local transport = client()
for _, args in ipairs({{root = "Workspace"}, {ref = {}}, {creatorId = 56}, {source = "print(1)"}}) do refuse(transport, args, "INPUT") end
for _, args in ipairs({V.array({}), V.NULL}) do
	local before = counters()
	local ok, err = pcall(function() transport:dispatch(command(transport, args)) end)
	check(not ok and err.code == "INPUT", "non-object arguments fail at the actual transport envelope")
	unchanged(before)
end
identity(12, 34, 56, Enum.CreatorType.Group)
refuse(client({"ServerStorage"}), {}, "GRANT")

for _, key in ipairs({"PlaceId", "GameId", "CreatorId"}) do
	for _, id in ipairs({-1, 0.5, 9007199254740992}) do
		identity(12, 34, 56, Enum.CreatorType.User)
		local scoped = client()
		-- Isolate operation validation from the existing transport identity fence.
		game._identity[key] = id
		local before = counters()
		local ok, err = pcall(function() scoped.operations:execute(command(scoped), function() end) end)
		check(not ok and err.code == "CONTEXT_UNAVAILABLE", "invalid exact engine identity refuses context")
		unchanged(before)
	end
end

identity(9007199254740991, 9007199254740991, 9007199254740991, Enum.CreatorType.Group)
local maximum = succeed(client())
check(maximum.placeId == 9007199254740991 and maximum.universeId == maximum.placeId and maximum.creator.id == maximum.placeId, "safe integer boundary is preserved exactly")

for _, change in ipairs({"creator", "place", "mode", "disconnect", "expiry"}) do
	identity(0, 0, 0, Enum.CreatorType.User)
	fixture.now = 1000
	local scoped = client()
	fixture.userHook = function(): ()
		if change == "creator" then game._identity.CreatorId = 56
		elseif change == "place" then game.PlaceId = 12
		elseif change == "mode" then fixture.edit = false
		elseif change == "disconnect" then scoped:requestDisconnect()
		else fixture.now = fixture.expiry end
	end
	refuse(scoped, {}, if change == "disconnect" then "SESSION" else if change == "expiry" then "LEASE" else "CONTEXT_CHANGED", change == "place")
end
fixture.now = 1000

identity(12, 34, 56, Enum.CreatorType.Group)
transport = client()
fixture.edit = false
refuse(transport, {}, "PLAY")
-- Direct operation observation only: the production transport remains fenced.
local directPlay = transport.operations:execute(command(transport), function() end)
check(directPlay.mode == "Play", "operation reads global test state even if the Edit RunService context is idle")
fixture.edit = true
local testService = services.StudioTestService
services.StudioTestService = {EditModeActive = "unknown"}
local before = counters()
local unavailableOk, unavailableError = pcall(function() transport.operations:execute(command(transport), function() end) end)
check(not unavailableOk and unavailableError.code == "CONTEXT_UNAVAILABLE", "unavailable global mode has no RunService fallback")
unchanged(before)
services.StudioTestService = testService

identity(12, 34, 56, Enum.CreatorType.Group)
transport = client()
local observed, delivered = succeed(transport)
local crossSession = command(transport); crossSession.sessionId = "other-session"
local sessionOk, sessionError = pcall(function() transport:dispatch(crossSession) end)
check(not sessionOk and sessionError.code == "SESSION", "wrong receipt session is refused before observation")
local stale = command(transport); stale.leaseEpoch = delivered.leaseEpoch
local leaseOk, leaseError = pcall(function() transport:dispatch(stale) end)
check(not leaseOk and leaseError.code == "LEASE", "stale command lease is refused")
game.PlaceId = 99
local identityOk, identityError = pcall(function() transport:dispatch(delivered) end)
check(not identityOk and identityError.code == "IDENTITY", "a place change fences even cached context receipts")
identity(12, 34, 56, Enum.CreatorType.Group)
local other = client()
local refOk, refError = pcall(function() other.operations.registry:resolve(observed.parentRef) end)
check(not refOk and refError.code == "SESSION", "opaque Workspace ref belongs only to its original session")
other.operations.registry.count = V.MAX_REFS
refuse(other, {}, "CAPACITY")

-- Exercise the real Transport.tick -> post -> V.encode -> RequestAsync Body,
-- not just direct table equality. Mock HTTP acknowledges only a command receipt;
-- this does not invoke or accept any import/upload. Host tests independently parse
-- these exact body strings with JSON.parse and the closed TypeScript decoder.
for _, wireCase in ipairs({"published-user", "published-group", "published-unavailable", "local-available", "local-anonymous", "local-api-unavailable"}) do
	local localPlace = string.sub(wireCase, 1, 6) == "local-"
	identity(if localPlace then 0 else 12, if localPlace then 0 else 34,
		if localPlace or wireCase == "published-unavailable" then 0 else 56,
		if wireCase == "published-group" then Enum.CreatorType.Group else Enum.CreatorType.User)
	if wireCase == "local-anonymous" then fixture.localUserId = 0 end
	if wireCase == "local-api-unavailable" then fixture.userError = true end
	local wireClient = client()
	local observed, sentCommand = succeed(wireClient)
	local captured: string? = nil
	fixture.httpHook = function(request: any): any
		check(request.Url == "http://127.0.0.1:45871/v1/plugin/result" and request.Method == "POST", "actual receipt POST route")
		check(request.Headers.Authorization == "Bearer fixture-memory-token", "actual paired receipt authentication (double only)")
		captured = request.Body
		local decoded = V.decode(request.Body, http)
		check(decoded.sessionId == sentCommand.sessionId and decoded.commandId == sentCommand.id and decoded.state == "succeeded", "serialized receipt session/command continuity")
		check(V.equal(decoded.result, observed), "actual Transport wire body preserves every observation field")
		check(decoded.result.creator.kind ~= nil and decoded.result.studioUser.id ~= nil, "explicit null fields survive on wire, never omitted")
		return response({accepted = true})
	end
	wireClient:tick()
	check(type(captured) == "string" and wireClient.pending == nil and wireClient.cache[sentCommand.id].acknowledged, "actual transport sends and acknowledges the exact cached receipt")
	print("ARCANE_CONTEXT_WIRE " .. wireCase .. " " .. (captured :: string))
end

print("Arcane import context fixture passed: " .. checks .. " checks (engine doubles only)")
