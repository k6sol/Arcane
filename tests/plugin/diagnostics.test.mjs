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
const names = ['Validation', 'Properties', 'Registry', 'Sha256Stream', 'AssetMesh', 'AssetTransfer', 'AssetPlacement', 'Operations', 'TestProof', 'Transport', 'Diagnostics'];

// Production module bodies run unchanged against engine doubles; no Studio is used.
async function harness() {
  const [engine, ...sources] = await Promise.all([
    readFile(join(root, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
    ...names.map(name => readFile(join(root, 'plugin/src', name + '.luau'), 'utf8')),
  ]);
  return engine + `
Enum.MessageType = enumCategory({"MessageOutput", "MessageInfo", "MessageWarning", "MessageError"})
local engineTypeof = typeof
local typeof = function(value: any): string
  if type(value) == "table" and value.fakeInstance == true then return "Instance" end
  return engineTypeof(value)
end
local statuses, requests = {}, {}
local factories, modules = {}, {}
local script: any = {Parent = {}}
local function require(reference: any): any
  local name = reference.Name
  if modules[name] == nil then modules[name] = factories[name]() end
  return modules[name]
end
` + names.map((name, i) => `script.Parent.${name} = {Name = "${name}"}\nfactories.${name} = function()\n${sources[i]}\nend\n`).join('') + `
local V = require(script.Parent.Validation)
local Transport = require(script.Parent.Transport)
local Diagnostics = require(script.Parent.Diagnostics)
fixture.encode = function(value: any): string return V.encode(value, http) end
local scalarDecode = http.JSONDecode
http.JSONDecode = function(self: any, json: string): any
  if string.sub(json, 1, 1) == '"' then return scalarDecode(self, json) end
  return V.decode(json, self)
end
local function signal(): any
  local value: any = {connections = {}}
  function value:Connect(callback: any): any
    local connection: any = {Connected = true, callback = callback}
    function connection:Disconnect(): () self.Connected = false end
    table.insert(self.connections, connection)
    return connection
  end
  function value:Fire(...: any): ()
    for _, connection in ipairs(table.clone(self.connections)) do
      if connection.Connected then connection.callback(...) end
    end
  end
  return value
end
local log = {MessageOut = signal()}
local context = {Error = signal()}
local studio: any = {}
function studio:GetService(name: string): any
  if name == "LogService" then return log end
  if name == "ScriptContext" then return context end
  error("unexpected service " .. name)
end
local clockValue = 100
local active = true
local function clock(): number return clockValue end
local function encode(value: any): string return V.encode(value, http) end
local function fakeScript(path: string): any return {fakeInstance = true, GetFullName = function(_self: any): string return path end} end
local function entries(collector: any): {any}
  local list = {}
  for _, id in ipairs(collector.order) do table.insert(list, collector.entries[id]) end
  return list
end
local key = "arcane_local_v1_45871_" .. string.rep("a", 64)
local pollStatus = 200
local polls = {}
fixture.httpHook = function(request: any): any
  table.insert(requests, request)
  local body = V.decode(request.Body, http)
  if string.find(request.Url, "/connect", 1, true) then
    fixture.connectPayload = body
    return response({sessionId = "session-diagnostics", token = "synthetic-token",
      protocolVersion = V.PROTOCOL, allowedRoots = V.array({"Workspace"}), allowWrites = true})
  elseif string.find(request.Url, "/poll", 1, true) then
    table.insert(polls, body)
    if pollStatus ~= 200 then return {StatusCode = pollStatus, Success = false, Body = "{}", Headers = {}} end
    return response({commands = V.array({})})
  elseif string.find(request.Url, "/disconnect", 1, true) then return response({}) end
  error("unexpected route " .. request.Url)
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
  const directory = await mkdtemp(join(tmpdir(), 'arcane-plugin-diagnostics-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('arcane-plugin-diagnostics-'));
    await rm(directory, {recursive: true, force: true});
  });
  const filename = join(directory, 'diagnostics.luau');
  await writeFile(filename, await harness() + checks + '\nprint("Diagnostics fixture passed")\n');
  execute(compiler, ['--null', filename]);
  assert.match(execute(runtime, [filename]), /Diagnostics fixture passed/);
}

test('Diagnostics production source compiles with the actual offline Luau compiler', options, () => {
  execute(compiler, ['--null', join(root, 'plugin/src/Diagnostics.luau')]);
});

test('captures Studio errors and warnings, pairs LogService with ScriptContext once and deduplicates repeats', options, t => run(t, `
local collector = Diagnostics.new(studio, function(): boolean return active end, clock)
assert(collector:start() == true)
log.MessageOut:Fire("plain output", Enum.MessageType.MessageOutput)
log.MessageOut:Fire("info output", Enum.MessageType.MessageInfo)
assert(#collector.order == 0, "only errors and warnings are kept")
-- One native script error reaches both signals; it is one occurrence, with its stack and script path.
log.MessageOut:Fire("ServerScriptService.Spawner:12: attempt to index nil with 'Parent'", Enum.MessageType.MessageError)
context.Error:Fire("ServerScriptService.Spawner:12: attempt to index nil with 'Parent'", "Script 'ServerScriptService.Spawner', Line 12", fakeScript("ServerScriptService.Spawner"))
local list = entries(collector)
assert(#list == 1, "paired signals merge")
local first = list[1]
assert(first.kind == "error" and first.message == "attempt to index nil with 'Parent'" and first.source == "ServerScriptService.Spawner" and first.line == 12)
assert(first.count == 1 and string.find(first.stack, "Line 12", 1, true))
-- Repeats inside the window count against the same entry.
clockValue += 5
log.MessageOut:Fire("ServerScriptService.Spawner:12: attempt to index nil with 'Parent'", Enum.MessageType.MessageError)
clockValue += 5
log.MessageOut:Fire("ServerScriptService.Spawner:12: attempt to index nil with 'Parent'", Enum.MessageType.MessageError)
assert(#entries(collector) == 1 and first.count == 3, "count " .. tostring(first.count))
log.MessageOut:Fire("Infinite yield possible on 'Workspace:WaitForChild(\\"Door\\")'", Enum.MessageType.MessageWarning)
list = entries(collector)
assert(#list == 2 and list[2].kind == "warning" and list[2].source == nil and list[2].line == nil)
-- A repeat after the window opens a new entry instead of growing an old one forever.
clockValue += Diagnostics.WINDOW_SECONDS + 1
log.MessageOut:Fire("ServerScriptService.Spawner:12: attempt to index nil with 'Parent'", Enum.MessageType.MessageError)
assert(#entries(collector) == 3 and first.count == 3)
-- Nothing is captured while the window is not paired.
active = false
log.MessageOut:Fire("Workspace.Script:1: unpaired", Enum.MessageType.MessageError)
assert(#entries(collector) == 3)
active = true
collector:stop()
log.MessageOut:Fire("Workspace.Script:1: after stop", Enum.MessageType.MessageError)
assert(#collector.order == 0 and #log.MessageOut.connections == 1 and not log.MessageOut.connections[1].Connected)
`));

test('bounds distinct entries, message, stack and source sizes, and never forwards invalid UTF-8', options, t => run(t, `
local collector = Diagnostics.new(studio, nil, clock)
for index = 1, 150 do collector:record("error", "Workspace.Script" .. index .. ":1: failure " .. index, "log") end
assert(#collector.order == Diagnostics.MAX_ENTRIES, "distinct entries are bounded")
assert(collector.entries[collector.order[1]].message == "failure 51", "oldest entries are evicted first")
local count = 0
for _ in pairs(collector.entries) do count += 1 end
assert(count == Diagnostics.MAX_ENTRIES)
collector:record("warning", string.rep("x", 9000), "log", string.rep("p", 2000), string.rep("s", 9000))
local big = collector.entries[collector.order[#collector.order]]
assert(#big.message == Diagnostics.MESSAGE_BYTES and #big.stack == Diagnostics.STACK_BYTES and #big.source == Diagnostics.SOURCE_BYTES)
collector:record("error", string.rep("é", 1500) .. "\\255", "log")
local utf = collector.entries[collector.order[#collector.order]]
assert(utf8.len(utf.message) ~= nil and #utf.message <= Diagnostics.MESSAGE_BYTES)
collector:record("error", "", "log")
collector:record("debug", "ignored", "log")
assert(collector.entries[collector.order[#collector.order]] == utf, "empty and unsupported kinds are ignored")
-- One report is bounded by count and encoded bytes; an acknowledgement marks only that snapshot.
local batch = collector:take(encode)
assert(#batch.entries == Diagnostics.MAX_PER_REPORT)
local bytes = 0
for _, entry in ipairs(batch.entries) do bytes += #encode(entry) + 1 end
assert(bytes <= Diagnostics.MAX_REPORT_BYTES)
collector:ack(batch)
local nextBatch = collector:take(encode)
assert(nextBatch.entries[1].id ~= batch.entries[1].id, "acknowledged entries are not resent")
`));

test('transport advertises the capability and reports changed diagnostics only on an accepted poll', options, t => run(t, `
local collector = Diagnostics.new(studio, nil, clock)
local client = Transport.new(game, function(status: any): () table.insert(statuses, status) end)
client.diagnostics = collector
client:requestConnect(key)
assert(client:cycle() == Transport.POLL_SECONDS and client.pair)
assert(table.find(fixture.connectPayload.capabilities, Diagnostics.CAPABILITY), "collector capability is advertised")
-- An idle poll with nothing new carries no diagnostics field.
assert(client:cycle() == Transport.POLL_SECONDS and polls[#polls].diagnostics == nil)
collector:record("error", "ServerScriptService.Main:4: boom", "log")
-- A lost poll does not mark the entry reported; the next poll resends it.
pollStatus = 500
client:cycle()
assert(#polls[#polls].diagnostics == 1 and polls[#polls].diagnostics[1].count == 1)
pollStatus = 200
client.failures = 0
client:cycle()
local sent = polls[#polls].diagnostics
assert(#sent == 1 and sent[1].message == "boom" and sent[1].source == "ServerScriptService.Main" and sent[1].line == 4 and sent[1].kind == "error")
client:cycle()
assert(polls[#polls].diagnostics == nil, "accepted entries are not resent")
-- A repeat changes the absolute count and is reported again under the same ID.
collector:record("error", "ServerScriptService.Main:4: boom", "log")
client:cycle()
assert(polls[#polls].diagnostics[1].id == sent[1].id and polls[#polls].diagnostics[1].count == 2)
-- A collector fault never blocks the poll.
collector.take = function(): any error("collector fault") end
local before = #polls
assert(client:cycle() == Transport.POLL_SECONDS and #polls == before + 1 and polls[#polls].diagnostics == nil)
client:stop()
-- Without a collector the capability is not advertised.
local plain = Transport.new(game, function(_status: any): () end)
plain:requestConnect(key)
plain:cycle()
assert(not table.find(fixture.connectPayload.capabilities, Diagnostics.CAPABILITY))
plain:stop()
`));
