import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {dirname, join, resolve, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compiler = process.env.ARCANE_LUAU_COMPILE ?? (runtime
  ? join(dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const options = {skip: (!runtime || !compiler) && 'Configure existing standalone Luau compiler and VM; no tools are installed and no Studio is used.'};
const names = ['Validation', 'Properties', 'Registry', 'Sha256Stream', 'AssetMesh', 'AssetTransfer', 'Operations', 'TestProof', 'Transport'];

// Keep production module bodies and their script-relative imports unchanged.
// All engine services, HTTP, scheduling and future resource ownership are doubles.
async function harness() {
  const [engine, ...sources] = await Promise.all([
    readFile(join(root, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
    ...names.map(name => readFile(join(root, 'plugin/src', name + '.luau'), 'utf8')),
  ]);
  return engine + `
local warnings, workers, statuses, requests = {}, {}, {}, {}
local warn = function(message: string): () table.insert(warnings, message) end
task.spawn = function(callback: any): any
  local worker = coroutine.create(callback)
  table.insert(workers, worker)
  return worker
end
task.wait = function(seconds: number?): () coroutine.yield(seconds) end
local factories, modules = {}, {}
local script: any = {Parent = {}}
local function require(reference: any): any
  local name = reference.Name
  if modules[name] == nil then modules[name] = factories[name]() end
  return modules[name]
end
` + names.map((name, i) => `script.Parent.${name} = {Name = "${name}"}\nfactories.${name} = function()\n${sources[i]}\nend\n`).join('') + `
local V = require(script.Parent.Validation)
local Operations = require(script.Parent.Operations)
local Transport = require(script.Parent.Transport)
fixture.encode = function(value: any): string return V.encode(value, http) end
local scalarDecode = http.JSONDecode
http.JSONDecode = function(self: any, json: string): any
  if string.sub(json, 1, 1) == '"' then return scalarDecode(self, json) end
  return V.decode(json, self)
end
local key = "arcane_local_v1_45871_" .. string.rep("a", 64)
local function reply(value: any, code: number?): any return response(value, code) end
fixture.httpHook = function(request: any): any
  table.insert(requests, request)
  if string.find(request.Url, "/connect", 1, true) or string.find(request.Url, "/pair", 1, true) then
    return reply({sessionId = "session-" .. tostring(fixture.requests), token = "synthetic-token",
      protocolVersion = V.PROTOCOL, allowedRoots = V.array({"Workspace"}), allowWrites = true})
  elseif string.find(request.Url, "/status", 1, true) then
    local payload = V.decode(request.Body, http)
    return reply({protocolVersion = V.PROTOCOL, identity = payload.identity, state = "lost", sessionId = payload.sessionId})
  elseif string.find(request.Url, "/poll", 1, true) then return reply({commands = V.array({})})
  elseif string.find(request.Url, "/result", 1, true) then return reply({accepted = true})
  elseif string.find(request.Url, "/disconnect", 1, true) then return reply({}) end
  error("unexpected route")
end
local function connected(): any
  local client = Transport.new(game, function(status: any): () table.insert(statuses, status) end)
  client:requestConnect(key)
  assert(client:cycle() == Transport.POLL_SECONDS and client.pair and client.operations)
  return client
end
local function rejects(callback: any, code: string): ()
  local ok, result = pcall(callback)
  assert(not ok and type(result) == "table" and result.code == code, "expected " .. code .. ": " .. tostring(result))
end
local function seedReceipts(client: any): ()
  client.pending = {body = {commandId = "old-command"}, unsafe = false}
  client.cache = {old = client.pending}
  client.cacheCount, client.cacheBytes, client.highEpoch = 1, 128, 7
end
local function retired(client: any, old: any): ()
  assert(old.token == nil and client.pair == nil and client.operations == nil and client.pending == nil)
  assert(next(client.cache) == nil and client.cacheCount == 0 and client.cacheBytes == 0 and client.highEpoch == 0)
end
local function owned(client: any, failing: boolean?): any
  local receivers = {}
  for index = 1, 2 do
    local receiver: any = {calls = 0, stagingBuffer = buffer.create(4096), destroyAttempts = 0}
    function receiver:cancel(): ()
      assert(client.pair == nil and client.operations == nil, "authority is retired before release")
      self.calls += 1
      self.stagingBuffer = nil
      self.destroyAttempts += 1 -- A future unparented resource double, not a native GPU allocation.
      if failing and index == 1 then error({code = "CLEANUP", message = "private-release-detail synthetic-token"}) end
    end
    receivers[index] = receiver
    client.operations.assetTransfers[tostring(index)] = {receiver = receiver}
  end
  return receivers
end
local function released(receivers: any): ()
  for _, receiver in ipairs(receivers) do
    assert(receiver.calls == 1 and receiver.stagingBuffer == nil and receiver.destroyAttempts == 1)
  end
end
local function cleanupStatus(): ()
  local status = statuses[#statuses]
  assert(status.state == "reconciliation" and string.find(status.detail, "CLEANUP:", 1, true))
  assert(status.sessionId == nil and not status.allowWrites and #status.allowedRoots == 0)
  assert(not string.find(status.detail, "private-release-detail", 1, true) and not string.find(status.detail, "synthetic-token", 1, true))
end
local function proofFor(client: any): any
  local identity = client.pair.identityFence.identity
  return {sessionId = client.pair.sessionId, clientLifetimeId = client.clientSessionId, pluginArtifactHash = string.rep("b", 64),
    playEpoch = 3, mode = "Edit", connected = true, continuitySupported = true,
    placeId = identity.placeId, universeId = identity.universeId}
end
local function stageCommand(client: any, proof: any): any
	if client.highEpoch == 0 then client.highEpoch = 1 end
  return {protocolVersion = V.PROTOCOL, id = "stage-command", requestId = "stage-request", state = "dispatched",
    sessionId = client.pair.sessionId, clientSessionId = client.clientSessionId, method = "asset.stage_packet",
    allowedRoots = V.array({"Workspace"}), allowWrites = client.pair.allowWrites,
    leaseEpoch = client.highEpoch, expiresAt = "2099-01-01T00:00:00.000Z",
    args = {continuity = {clientLifetimeId = proof.clientLifetimeId, pluginArtifactHash = proof.pluginArtifactHash, playEpoch = proof.playEpoch}}}
end
`;
}

function execute(binary, args) {
  const result = spawnSync(binary, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function run(t, checks) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-transport-cleanup-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('arcane-transport-cleanup-'));
    await rm(directory, {recursive: true, force: true});
  });
  const filename = join(directory, 'transport.luau');
  await writeFile(filename, await harness() + checks + '\nprint("Transport cleanup fixture passed")\n');
  execute(compiler, ['--null', filename]);
  assert.match(execute(runtime, [filename]), /Transport cleanup fixture passed/);
}

test('transport cleanup production modules compile with the actual offline Luau compiler', options, () => {
  for (const name of names) execute(compiler, ['--null', join(root, 'plugin/src', name + '.luau')]);
});

for (const keepIdentity of [false, true]) {
  test(`clearSession cancels actual receiving transfers and owned buffers exactly once; keepIdentity=${keepIdentity}`, options, t => run(t, `
local client = connected()
local old, operations, fence = client.pair, client.operations, client.identityFence
local receivers = owned(client)
local expected = {digest = string.rep("a", 64), payloadDigest = string.rep("b", 64), manifestDigest = string.rep("c", 64)}
local packet = V.encode({formatVersion = 1, kind = "begin", payloadDigest = expected.payloadDigest,
  manifestDigest = expected.manifestDigest, ordinal = 0, objectCount = 1}, http)
-- Receiving state is genuine production AssetTransfer state, not a mocked cancel.
-- Temporarily remove the resource doubles to respect the production transfer limit.
local doubles = operations.assetTransfers
operations.assetTransfers = {}
operations:receiveAssetPacket(expected, packet, function() end)
local receiver = operations.assetTransfers[expected.digest].receiver
assert(receiver:status().state == "receiving")
for id, entry in pairs(doubles) do operations.assetTransfers[id] = entry end
seedReceipts(client)
client.blocked = true
client:clearSession(${keepIdentity})
retired(client, old); released(receivers)
assert(receiver:status().state == "cancelled" and next(operations.assetTransfers) == nil)
assert(not client.blocked and not client.assetCleanupFailed)
assert(${keepIdentity ? 'client.identityFence == fence' : 'client.identityFence == nil'})
for _, connection in ipairs(fence.connections) do assert(connection.Connected == ${keepIdentity}) end
client:clearSession(); client:stop(); released(receivers)
`));
}

test('stop disposes without yielding, HTTP or status callbacks and remains idempotent', options, t => run(t, `
local client = connected()
local old, operations = client.pair, client.operations
local receivers = owned(client)
seedReceipts(client)
local desired = {apiKey = key, code = "synthetic-code"}
client.desiredPair = desired
local recovery = client.recovery
local proofStops = 0
client.testProof = {stop = function() proofStops += 1 end}
local beforeRequests, beforeStatuses = fixture.requests, #statuses
local thread = coroutine.create(function() client:stop() end)
assert(coroutine.resume(thread) and coroutine.status(thread) == "dead", "unload completes synchronously")
retired(client, old); released(receivers)
assert(next(operations.assetTransfers) == nil and recovery.apiKey == nil and desired.apiKey == nil and desired.code == nil)
assert(client.recovery == nil and client.desiredPair == nil and client.identityFence == nil and proofStops == 1)
client:stop(); client:requestConnect(key); client:start(); client:start()
if workers[1] then assert(coroutine.resume(workers[1]) and coroutine.status(workers[1]) == "dead") end
assert(client:cycle() == Transport.POLL_SECONDS and fixture.requests == beforeRequests and #statuses == beforeStatuses)
assert(#workers == 1 and proofStops == 1 and #warnings == 0); released(receivers)
`));

for (const intent of ['disconnect', 'connect', 'pair']) {
  test(`${intent} retires staging in the single worker before any replacement exchange`, options, t => run(t, `
local client = connected()
local old, operations = client.pair, client.operations
local receivers = owned(client)
client:start(); client:start(); assert(#workers == 1)
${intent === 'disconnect' ? 'client:requestDisconnect()' : intent === 'connect' ? 'client:requestConnect(key)' : 'client:requestPair("http://127.0.0.1:45871", "synthetic-code")'}
assert(receivers[1].calls == 0, "UI intent does not start another disposal worker")
local before = fixture.requests
local ok = coroutine.resume(workers[1]); assert(ok)
released(receivers); assert(old.token == nil and next(operations.assetTransfers) == nil)
assert(requests[#requests${intent === 'disconnect' ? '' : ' - 1'}].Url == "http://127.0.0.1:45871/v1/plugin/disconnect")
assert(fixture.requests == before + ${intent === 'disconnect' ? 1 : 2})
assert(${intent === 'disconnect' ? 'client.pair == nil and client.operations == nil' : 'client.pair ~= old and client.operations ~= operations'})
client:stop()
assert(coroutine.resume(workers[1]) and coroutine.status(workers[1]) == "dead")
assert(#workers == 1); released(receivers)
`));
}

for (const failing of [false, true]) {
  test(`definitive revocation disposes staging and preserves safe recovery semantics; cleanup failure=${failing}`, options, t => run(t, `
local client = connected()
local old, operations, intent = client.pair, client.operations, client.recovery
local receivers = owned(client, ${failing})
seedReceipts(client)
local normal = fixture.httpHook
fixture.httpHook = function(request: any): any
  table.insert(requests, request)
  return reply({error = "REVOKED"}, 409)
end
assert(client:cycle() == Transport.MAX_BACKOFF_SECONDS)
fixture.httpHook = normal
retired(client, old); released(receivers); assert(next(operations.assetTransfers) == nil)
local before = fixture.requests
${failing ? `
assert(client.blocked and client.assetCleanupFailed and client.recovery == nil and intent.apiKey == nil)
cleanupStatus()
client:clearSession(true); client:clearSession()
rejects(function() client:requestConnect(key) end, "CLEANUP")
rejects(function() client:requestConnect(key, true) end, "CLEANUP")
rejects(function() client:requestPair("http://127.0.0.1:45871", "synthetic-code") end, "CLEANUP")
client:requestDisconnect(); client:status("connected", "must not hide cleanup")
for _ = 1, 3 do assert(client:cycle() == Transport.MAX_BACKOFF_SECONDS) end
cleanupStatus(); assert(fixture.requests == before and client.blocked and client.assetCleanupFailed)
` : `
assert(not client.blocked and not client.assetCleanupFailed and client.recovery == intent and intent.needsStatus)
assert(client:cycle() == Transport.POLL_SECONDS and client.pair ~= old and client.operations ~= operations)
assert(fixture.requests == before + 2 and requests[#requests - 1].Url == old.url .. "/v1/plugin/status")
assert(requests[#requests].Url == old.url .. "/v1/plugin/connect" and client.highEpoch == 0 and client.pending == nil)
`}
client:stop(); released(receivers)
`));
}

test('a cleanup failure during explicit reconnect cannot be overwritten by its desired exchange', options, t => run(t, `
local client = connected()
local old, operations = client.pair, client.operations
local receivers = owned(client, true)
client:requestConnect(key)
local desired, intent = client.desiredPair, client.recovery
local before = fixture.requests
assert(client:cycle() == Transport.MAX_BACKOFF_SECONDS)
retired(client, old); released(receivers); cleanupStatus()
assert(fixture.requests == before + 1 and requests[#requests].Url == old.url .. "/v1/plugin/disconnect")
assert(client.desiredPair == nil and client.recovery == nil and desired.apiKey == nil and intent.apiKey == nil)
client:start(); client:start(); assert(#workers == 1)
for _ = 1, 2 do assert(coroutine.resume(workers[1]) and coroutine.status(workers[1]) == "suspended") end
assert(fixture.requests == before + 1); cleanupStatus()
client:stop(); assert(coroutine.resume(workers[1]) and coroutine.status(workers[1]) == "dead")
`));

test('unload release failure is bounded and does not abort the remaining unloading handler', options, t => run(t, `
local client = connected()
local old, operations = client.pair, client.operations
local receivers = owned(client, true)
local beforeRequests, beforeStatuses = fixture.requests, #statuses
local finished = false
local thread = coroutine.create(function() client:stop(); finished = true end)
assert(coroutine.resume(thread) and coroutine.status(thread) == "dead" and finished)
retired(client, old); released(receivers); assert(next(operations.assetTransfers) == nil)
assert(client.assetCleanupFailed and client.blocked and #warnings == 1)
assert(string.find(warnings[1], "CLEANUP:", 1, true) and not string.find(warnings[1], "synthetic-token", 1, true))
client:stop(); client:cycle()
assert(#warnings == 1 and #statuses == beforeStatuses and fixture.requests == beforeRequests)
`));

test('stop during a yielding poll retires staging and fences the late response without a second request', options, t => run(t, `
local client = connected()
local old = client.pair
local receivers = owned(client)
fixture.httpHook = function(request: any): any
  table.insert(requests, request); coroutine.yield("http")
  return reply({commands = V.array({})})
end
client:start(); client:start()
assert(coroutine.resume(workers[1]) and client.inFlight)
local before = fixture.requests
client:stop(); retired(client, old); released(receivers)
assert(client.inFlight and fixture.requests == before)
assert(coroutine.resume(workers[1]) and coroutine.status(workers[1]) == "dead" and not client.inFlight)
assert(#workers == 1 and fixture.requests == before and client.pair == nil and client.operations == nil)
`));

test('transient network failure preserves staging ownership and original retry backoff', options, t => run(t, `
local client = connected()
local old, operations = client.pair, client.operations
local receivers = owned(client)
local normal = fixture.httpHook
fixture.httpHook = function() error("injected network outage") end
assert(client:cycle() == 4 and client.failures == 1)
assert(client.pair == old and client.operations == operations and receivers[1].calls == 0)
fixture.httpHook = normal
assert(client:cycle() == Transport.POLL_SECONDS and client.failures == 0)
client:stop(); released(receivers)
`));

test('staging capability stays separate, its envelope requires write grant, and every guard uses one fresh proof', options, t => run(t, `
local reads, writes = table.clone(V.READ_METHODS), table.clone(V.WRITE_METHODS)
local client = connected()
local payload = V.decode(requests[1].Body, http)
for _, method in ipairs(V.ASSET_STAGE_METHODS) do
  assert(table.find(payload.capabilities, method) and not table.find(V.READ_METHODS, method) and not table.find(V.WRITE_METHODS, method))
end
assert(V.equal(reads, V.READ_METHODS) and V.equal(writes, V.WRITE_METHODS))
local proof, calls = proofFor(client), 0
client.testProof = {snapshot = function() calls += 1; return table.clone(proof) end, stop = function() end}
local command = stageCommand(client, proof)
client:envelope(command); client:guard(command, client.pair); assert(calls == 1)
client:guard(command, client.pair); assert(calls == 2)
proof.playEpoch += 1
rejects(function() client:guard(command, client.pair) end, "SCOPE"); assert(calls == 3)
command.args.continuity.playEpoch = proof.playEpoch
client:guard(command, client.pair); assert(calls == 4)
client.pair.allowWrites, command.allowWrites = false, false
rejects(function() client:guard(command, client.pair) end, "GRANT"); assert(calls == 4)
command.method = "asset.upload"; rejects(function() client:envelope(command) end, "METHOD")
command.method = "asset.parent"; rejects(function() client:envelope(command) end, "METHOD")
client:stop()
`));

test('staging guard fails SCOPE for absent, changed or unavailable continuity and exact-session proof', options, t => run(t, `
local client = connected()
local original = proofFor(client)
local command = stageCommand(client, original)
local proof, calls = table.clone(original), 0
client.testProof = {snapshot = function() calls += 1; return proof end, stop = function() end}
local changes = {sessionId = "other-session", mode = "Play", connected = false, continuitySupported = false,
  placeId = 1, universeId = 1, clientLifetimeId = "other-lifetime", pluginArtifactHash = string.rep("c", 64), playEpoch = 4}
for field, value in pairs(changes) do
  proof = table.clone(original); proof[field] = value
  local before = calls
  rejects(function() client:guard(command, client.pair) end, "SCOPE"); assert(calls == before + 1)
end
proof = nil; rejects(function() client:guard(command, client.pair) end, "SCOPE")
proof = table.clone(original); command.args.continuity = nil
rejects(function() client:guard(command, client.pair) end, "SCOPE")
command = stageCommand(client, original)
for _, field in ipairs({"clientLifetimeId", "pluginArtifactHash", "playEpoch"}) do
  command.args.continuity = {clientLifetimeId = original.clientLifetimeId, pluginArtifactHash = original.pluginArtifactHash, playEpoch = original.playEpoch}
  command.args.continuity[field] = nil
  rejects(function() client:guard(command, client.pair) end, "SCOPE")
end
command = stageCommand(client, original)
fixture.edit = false
local before = calls
rejects(function() client:guard(command, client.pair) end, "SCOPE"); assert(calls == before + 1)
fixture.edit = true
client.testProof.snapshot = function() error("injected unavailable proof") end
rejects(function() client:guard(command, client.pair) end, "SCOPE")
client.testProof = nil; rejects(function() client:guard(command, client.pair) end, "SCOPE")
client:stop()
`));
