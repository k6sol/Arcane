import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.ARCANE_LUAU_BIN;
const modules = ['Validation', 'Registry', 'Properties', 'Sha256Stream', 'AssetMesh', 'AssetTransfer', 'AssetUpload', 'AssetPlacement', 'TestProof', 'TerrainGen', 'Operations', 'Transport'];

async function runLuau(checks, marker) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-build-perf-'));
  try {
    const sources = await Promise.all([
      readFile(path.join(repository, 'plugin/fixtures/MockEngine.luau'), 'utf8'),
      ...modules.map(async name => `local ${name} = (function()\n${(await readFile(path.join(repository, `plugin/src/${name}.luau`), 'utf8')).replace(/require\(script\.Parent\.(\w+)\)/g, '$1')}\nend)()\n`),
    ]);
    const harness = path.join(directory, 'build-perf.luau');
    await writeFile(harness, sources.join('\n') + '\n' + checks);
    const result = spawnSync(runtime, [harness], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, marker);
  } finally {
    assert.ok(path.basename(directory).startsWith('arcane-build-perf-'));
    await rm(directory, { recursive: true, force: true });
  }
}

const checks = `
local V = Validation
local checks = 0
local function check(condition: boolean, label: string): () assert(condition, label); checks += 1 end
local function refuses(code: string, callback: () -> any): ()
  local ok, err = pcall(callback)
  check(not ok and type(err) == "table" and err.code == code, "expected " .. code .. ": " .. V.safeError(err))
end

-- Protocol decoder fast path: unescaped strings are raw slices, escaped strings still use the engine unescaper.
local engineDecodes = 0
local countingHttp = setmetatable({JSONDecode = function(_self: any, text: string): any engineDecodes += 1; return http:JSONDecode(text) end,
  JSONEncode = function(_self: any, value: any): string return http:JSONEncode(value) end}, {})
local decoded = V.decode('{"plain":"abc def","esc":"a\\\\"b\\\\\\\\c\\\\u0041\\\\n","del":"x\\127y","utf":"caf\\u{e9}","list":[1,-2.5,"q"]}', countingHttp)
check(decoded.plain == "abc def" and decoded.esc == 'a"b\\\\cA\\n' and decoded.del == "x\\127y" and decoded.utf == "caf\\u{e9}" and decoded.list[3] == "q", "decoded values")
check(engineDecodes == 1, "only the escaped string reaches the engine unescaper")
refuses("PROTOCOL", function() return V.decode('{"bad":"a\\nb"}', countingHttp) end)
refuses("PROTOCOL", function() return V.decode('{"bad":"a\\\\qb"}', countingHttp) end)
refuses("PROTOCOL", function() return V.decode('{"bad":"\\\\u12"}', countingHttp) end)
refuses("PROTOCOL", function() return V.decode('{"open":"abc', countingHttp) end)
refuses("PROTOCOL", function() return V.decode('{"a":1} x', countingHttp) end)

-- Encoder fast paths stay valid JSON and round-trip through the decoder.
local engineEncodes = 0
local encodeHttp = setmetatable({JSONDecode = function(_self: any, text: string): any return http:JSONDecode(text) end,
  JSONEncode = function(_self: any, value: any): string engineEncodes += 1; return http:JSONEncode(value) end}, {})
local value = {plain = "Tree_01 [x]", slash = "a/b", quote = 'say "hi"', int = 42, neg = -7, frac = 0.25, big = 9007199254740992, zero = -0.0}
local text = V.encode(value, encodeHttp)
local back = V.decode(text, http)
check(back.plain == value.plain and back.slash == "a/b" and back.quote == value.quote and back.int == 42 and back.neg == -7 and back.frac == 0.25 and back.big == value.big, "encoded values round-trip")
check(string.find(text, '"int":42', 1, true) ~= nil and string.find(text, '"plain":"Tree_01 [x]"', 1, true) ~= nil, "plain strings and safe integers are encoded directly")
check(engineEncodes == 5, "slash/quote strings, fractions, unsafe integers and -0 keep the engine encoder (object keys use the same fast path)")

-- Transport envelope: the 256 KiB bound is measured once per args table; every other check re-runs.
local transport = Transport.new(game, function() end)
transport.pair = {sessionId = "s", allowedRoots = {"Workspace"}, allowWrites = true}
local args = {path = "a/b", n = 1}
local command = {protocolVersion = V.PROTOCOL, sessionId = "s", clientSessionId = transport.clientSessionId, state = "dispatched", id = "c1", requestId = "r1",
  leaseEpoch = 1, allowedRoots = V.array({"Workspace"}), allowWrites = true, method = "scene.children", expiresAt = "2099-01-01T00:00:00.000Z", args = args}
transport.http = encodeHttp
engineEncodes = 0
transport:envelope(command)
check(engineEncodes == 1 and transport.sizedArgs[args] == true, "first envelope sizes the args")
transport:envelope(command); transport:envelope(command)
check(engineEncodes == 1, "later guards do not re-encode the same args")
command.allowWrites = false
refuses("GRANT", function() transport:envelope(command) end)
command.allowWrites = true
local huge = {blob = string.rep("x", V.ARGUMENT_BYTES)}
command.args = huge
refuses("BODY_LIMIT", function() transport:envelope(command) end)
check(transport.sizedArgs[huge] == nil, "oversize args are never marked sized")
refuses("BODY_LIMIT", function() transport:envelope(command) end)

-- Slicer: no yield before the budget is spent; a forced yield always re-guards; a guard failure stops the work.
local ops = Operations.new({sessionId = "slice", allowedRoots = {"Workspace"}}, game, http)
local waits, guards = 0, 0
task.wait = function(): () waits += 1 end
ops.sliceSeconds = math.huge
local slice = ops:slicer(function() guards += 1 end)
for _ = 1, 1000 do slice() end
check(waits == 0 and guards == 0, "an unspent budget never yields")
slice(0)
check(waits == 1 and guards == 1 and ops.slices == 1, "a forced yield re-runs the guard")
ops.sliceSeconds = 0
for _ = 1, Operations.SLICE_CHECK * 3 do slice() end
check(waits == 4 and guards == 4, "a spent budget yields once per SLICE_CHECK steps")
slice(Operations.SLICE_CHECK)
check(waits == 5, "a weighted step counts as many steps")
local stopped = ops:slicer(function() V.fail("LEASE", "Command lease has expired.") end)
refuses("LEASE", function() stopped(0) end)
print("Arcane build performance checks passed: " .. checks)
`;

test('real Luau: decoder/encoder fast paths, once-per-args envelope sizing and the cooperative slicer', { skip: !runtime && 'Set ARCANE_LUAU_BIN to run the Luau VM checks.' }, async () => {
  await runLuau(checks, /Arcane build performance checks passed: \d+/);
});
