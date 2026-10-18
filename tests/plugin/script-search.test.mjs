import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE;
const options = { skip: !runtime && 'Standalone Luau runtime is not configured; native Studio is never used.' };
const modules = ['Validation', 'Registry', 'Properties', 'AssetMesh', 'Sha256Stream', 'AssetTransfer', 'AssetPlacement', 'TerrainGen', 'Operations', 'Transport', 'TestProof'];
const helpers = `
local V = require(script.Parent.Validation)
local Transport = require(script.Parent.Transport)
fixture.encode = function(value: any): string return V.encode(value, http) end
local transport = Transport.new(game, function() end)
fixture.httpHook = function(request: any): any
  assert(request.Url == "http://127.0.0.1:45871/v1/plugin/pair", "only the memory pairing route is used")
  return response({sessionId = "search-session", token = "memory-search-token", protocolVersion = 1,
    allowedRoots = {"Workspace"}, allowWrites = false})
end
transport:requestPair("http://127.0.0.1:45871", "memory-pairing-code")
transport:tick()
assert(transport.operations and transport.pair.allowWrites == false)
local ops = transport.operations
local workspace = game:GetService("Workspace")
for _, child in ipairs(workspace:GetChildren()) do child.Parent = nil end
fixture.sources = {}
local function attach(className: string, text: string, parent: any?): any
  local instance = Instance.new(className)
  instance.Name, instance.Source, instance.Parent = "RepeatedName", text, parent or workspace
  return instance
end
local function search(args: any?, guard: any?): any
  return ops:execute({id = "source-search", method = "script.search", args = args or {root = "Workspace", query = "needle"}}, guard or function() end)
end
local function refuses(code: string, args: any, guard: any?): ()
  local ok, err = pcall(function() return search(args, guard) end)
  assert(not ok and type(err) == "table" and err.code == code, tostring(err))
end
`;

async function run(checks) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-script-search-'));
  try {
    const [engine, ...sources] = await Promise.all([
      readFile(join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(name => readFile(join(repository, `plugin/src/${name}.luau`), 'utf8')),
    ]);
    const loader = `
local sourceModules, sourceCache = {}, {}
local script: any = {Parent = {}}
local function require(module: any): any
  if sourceCache[module.Name] == nil then sourceCache[module.Name] = sourceModules[module.Name]() end
  return sourceCache[module.Name]
end
` + modules.map((name, index) => `script.Parent.${name} = {Name = "${name}"}\nsourceModules["${name}"] = function()\n${sources[index]}\nend\n`).join('\n');
    const path = join(directory, 'script-search.luau');
    await writeFile(path, engine + '\n' + loader + '\n' + helpers + '\n' + checks + '\nprint("Arcane script search fixture passed")\n');
    if (compile) {
      const result = spawnSync(compile, ['--null', path], { encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const result = spawnSync(runtime, [path], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Arcane script search fixture passed/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('arcane-script-search-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('script search reads dirty editor sources with literal matches and exact line/byte columns', options, async () => {
  await run(`
local module = attach("ModuleScript", "persisted needle")
fixture.sources[module] = "-- dirty editor\\r\\nlocal 🧩 = 'needle .*'\\r\\nneedle needle\\n"
local scriptInstance = attach("Script", "Needle")
local localScript = attach("LocalScript", "needle")
local before = {fixture.writes, fixture.committed, fixture.cancelled}
local result = search()
assert(#result.items == 3 and not result.truncated and #result.reasons == 0)
assert(result.items[1].line == 2 and result.items[1].column == 15, "one-based UTF-8 byte column")
assert(result.items[2].line == 3 and result.items[2].column == 1, "one match per line")
assert(ops.registry:resolve(result.items[1].ref) == module)
assert(ops.registry:resolve(result.items[3].ref) == localScript, "same display names have distinct real refs")
assert(result.sourceKind == "editor" and result.literal and result.caseSensitive and not result.atomicSnapshot)
assert(result.columnEncoding == "utf8-bytes" and result.scriptsRead == 3 and result.nodesVisited == 4)
local literal = search({root = "Workspace", query = ".*"})
assert(#literal.items == 1 and literal.items[1].line == 2, "regex punctuation is literal")
local folded = search({root = "Workspace", query = "NEEDLE", caseSensitive = false})
assert(#folded.items == 4 and folded.caseSensitive == false)
assert(V.equal(before, {fixture.writes, fixture.committed, fixture.cancelled}), "search has no writes or history changes")
assert(module.Source == "persisted needle" and fixture.sources[module] ~= module.Source)
`);
});

test('script search narrows to a genuine subtree, including its parent script, and enforces root/session scope', options, async () => {
  await run(`
local folder = attach("Folder", "")
local inside = attach("ModuleScript", "needle", folder)
attach("ModuleScript", "needle")
local result = search({root = "Workspace", query = "needle", ref = ops.registry:ref(folder)})
assert(#result.items == 1 and ops.registry:resolve(result.items[1].ref) == inside and result.nodesVisited == 2)
local own = search({root = "Workspace", query = "needle", ref = result.items[1].ref})
assert(#own.items == 1 and own.nodesVisited == 1)
refuses("GRANT", {root = "ServerStorage", query = "needle"})
local wrong = table.clone(result.items[1].ref); wrong.sessionId = "foreign"
refuses("SESSION", {root = "Workspace", query = "needle", ref = wrong})
local removed = result.items[1].ref; inside.Parent = nil
refuses("REF", {root = "Workspace", query = "needle", ref = removed})
`);
});

test('script search rejects malformed queries, unknown fields and unbounded controls in production Luau', options, async () => {
  await run(`
for _, query in ipairs({"", "x\\n", "x\\r", string.char(0), string.char(127), string.char(255), string.rep("🧩", 65)}) do
  refuses("INPUT", {root = "Workspace", query = query})
end
for _, limit in ipairs({0, 101, 1.5, "1"}) do refuses("INPUT", {root = "Workspace", query = "x", limit = limit}) end
refuses("INPUT", {root = "Workspace", query = "x", caseSensitive = 1})
refuses("INPUT", {root = "Workspace", query = "x", regex = true})
refuses("INPUT", {root = "Workspace", query = "x", ref = false})
attach("ModuleScript", string.rep("🧩", 64))
assert(#search({root = "Workspace", query = string.rep("🧩", 64)}).items == 1)
`);
});

test('script search reports complete empty results and only truncates a match limit when another match exists', options, async () => {
  await run(`
local empty = search()
assert(#empty.items == 0 and not empty.truncated and empty.scriptsRead == 0 and empty.nodesVisited == 1)
local instance = attach("ModuleScript", "needle\\nnot a match")
local exact = search({root = "Workspace", query = "needle", limit = 1})
assert(#exact.items == 1 and not exact.truncated)
fixture.sources[instance] = "needle\\nneedle"
local bounded = search({root = "Workspace", query = "needle", limit = 1})
assert(#bounded.items == 1 and bounded.truncated and V.equal(bounded.reasons, V.array({"matches"})))
`);
});

test('script search produces bounded valid UTF-8 excerpts around late matches without exposing full source', options, async () => {
  await run(`
local instance = attach("ModuleScript", string.rep("🧩", 1000) .. "needle" .. string.rep("é", 1000))
local result = search()
local item = result.items[1]
assert(#item.excerpt <= 512 and utf8.len(item.excerpt) ~= nil and item.excerptTruncated)
assert(item.column == 4001 and item.excerptStartColumn > 1 and string.find(item.excerpt, "needle", 1, true))
assert(item.source == nil and result.source == nil and result.sourceBytes == #instance.Source)
`);
});

test('script search reports unreadable and oversized sources as incomplete and limits aggregate source work', options, async () => {
  await run(`
attach("ModuleScript", string.rep("x", 100 * 1024 + 1))
local good = attach("ModuleScript", "needle")
local result = search()
assert(result.truncated and result.skippedScripts == 1 and result.scriptsRead == 1 and #result.items == 1)
assert(V.equal(result.reasons, V.array({"unreadable-source"})))
local original = editor.GetEditorSource
editor.GetEditorSource = function(self: any, instance: any): string
  if instance == good then error("synthetic editor unavailable") end
  return original(self, instance)
end
local unavailable = search()
assert(unavailable.skippedScripts == 2 and #unavailable.items == 0 and unavailable.truncated)
editor.GetEditorSource = original
for _, child in ipairs(workspace:GetChildren()) do child.Parent = nil end
for _ = 1, 22 do attach("ModuleScript", string.rep("x", 100 * 1024)) end
local limited = search()
assert(limited.sourceBytes == 20 * 100 * 1024 and limited.scriptsRead == 21 and limited.truncated)
assert(V.equal(limited.reasons, V.array({"source-bytes"})))
`);
});

test('script search bounds script count and hierarchy traversal without claiming an exhaustive result', options, async () => {
  await run(`
for _ = 1, 129 do attach("ModuleScript", "absent") end
local scripts = search()
assert(scripts.scriptsRead == 128 and scripts.truncated and V.equal(scripts.reasons, V.array({"scripts"})))
for _, child in ipairs(workspace:GetChildren()) do child.Parent = nil end
for _ = 1, 5000 do attach("Folder", "") end
local nodes = search()
assert(nodes.nodesVisited == 5000 and nodes.scriptsRead == 0 and nodes.truncated)
assert(V.equal(nodes.reasons, V.array({"nodes"})))
`);
});

test('script search caps expanded reference/result bytes before the wire receipt limit', options, async () => {
  await run(`
local parent = workspace
for _ = 1, 30 do
  local next = attach("Folder", "", parent)
  next.Name = string.rep("x", 256); parent = next
end
for _ = 1, 100 do attach("ModuleScript", "needle", parent) end
local result = search({root = "Workspace", query = "needle", limit = 100})
assert(result.truncated and #result.items > 0 and #result.items < 100)
assert(V.equal(result.reasons, V.array({"result-bytes"})) and #V.encode(result, http) < V.RESULT_BYTES)
`);
});

test('script search retires on grant loss or scope changes during an editor read', options, async () => {
  await run(`
local instance = attach("ModuleScript", "needle")
local original = editor.GetEditorSource
local retired = false
editor.GetEditorSource = function(self: any, scriptInstance: any): string
  local source = original(self, scriptInstance); retired = true; return source
end
refuses("SESSION", {root = "Workspace", query = "needle"}, function()
  if retired then V.fail("SESSION", "retired during read") end
end)
editor.GetEditorSource = function(self: any, scriptInstance: any): string
  local source = original(self, scriptInstance); scriptInstance.Parent = game:GetService("ServerStorage"); return source
end
refuses("GRANT", {root = "Workspace", query = "needle"})
`);
});

test('production transport admits script search under a read-only grant without a mutation receipt', options, async () => {
  await run(`
attach("ModuleScript", "needle")
local before = {fixture.writes, fixture.committed, fixture.cancelled}
local command = {protocolVersion = 1, id = "search-wire", requestId = "search-wire-request", sessionId = transport.pair.sessionId,
  clientSessionId = transport.clientSessionId, method = "script.search", args = {root = "Workspace", query = "needle"},
  allowedRoots = {"Workspace"}, allowWrites = false, leaseEpoch = 1, expiresAt = "2099-01-01T00:00:00.000Z", state = "dispatched"}
transport:dispatch(command)
local receipt = transport.pending.body
assert(receipt.state == "succeeded" and #receipt.result.items == 1, tostring(receipt.error))
assert(receipt.commandId == command.id and ops.mutations[command.id] == nil)
assert(V.equal(before, {fixture.writes, fixture.committed, fixture.cancelled}))
`);
});
