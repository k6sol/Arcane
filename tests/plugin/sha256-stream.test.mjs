import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modulePath = path.join(repository, 'plugin/src/Sha256Stream.luau');
const legacyPath = path.join(repository, 'plugin/src/Sha256.luau');
// Explicit injection only: no discovery, downloads, services, or product/Studio launches.
const runtime = process.env.ARCANE_LUAU_BIN;
const compiler = process.env.ARCANE_LUAU_COMPILE;
const offlineOptions = { skip: (!runtime || !compiler) && 'Inject both verified standalone Luau tools.' };
const toolHashes = {
  runtime: '4e86c0399aca661753d918bb775a152e35fd8f7a788b67076e1e03f81bc43703',
  compiler: '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8',
};
const MAX_UPDATE = 512 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const nodeDigest = bytes => createHash('sha256').update(bytes).digest('hex');
// Decimal escapes preserve source encoding, split UTF-8, NULs, and arbitrary bytes.
const luauBytes = bytes => `"${Array.from(bytes, byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
const streamCheck = (expression, bytes, sizes) =>
  `checkStream(${expression}, "${nodeDigest(bytes)}", {${sizes.join(',')}})`;

let verifiedTools;
function verifyTools() {
  return verifiedTools ??= Promise.all([
    [runtime, toolHashes.runtime], [compiler, toolHashes.compiler],
  ].map(async ([file, expected]) => {
    assert.equal(nodeDigest(await readFile(file)), expected, `Unverified offline executable: ${file}`);
  }));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const prelude = `
local function noYield(callback: any, ...: any): any
  local thread = coroutine.create(callback)
  local ok, result = coroutine.resume(thread, ...)
  assert(ok, tostring(result))
  assert(coroutine.status(thread) == "dead", "SHA-256 stream must not yield")
  return result
end
local function isolatedLoad(loader: any): any
  -- Only immutable copies of the pure builtins used by the module are available.
  local environment = table.freeze(setmetatable({
    bit32 = table.freeze(table.clone(bit32)),
    table = table.freeze(table.clone(table)),
    string = table.freeze(table.clone(string)), type = type, error = error,
  }, {__index = function(_, key) error("Unexpected module global: " .. tostring(key)) end}))
  setfenv(loader, environment)
  return noYield(loader)
end
`;
const helpers = `
local function rejected(callback: any, message: string): ()
  local ok, result = pcall(function() noYield(callback) end)
  assert(not ok, "invalid call must throw")
  assert(type(result) == "string" and string.find(result, message, 1, true), tostring(result))
end
local function checkStream(bytes: string, expected: string, sizes: {number}): ()
  local hasher = noYield(Sha256Stream.new)
  noYield(hasher.update, hasher, "")
  local offset, chunk = 1, 1
  while offset <= #bytes do
    local size = sizes[(chunk - 1) % #sizes + 1]
    assert(size > 0 and size <= ${MAX_UPDATE})
    noYield(hasher.update, hasher, string.sub(bytes, offset, offset + size - 1))
    offset += size
    chunk += 1
  end
  noYield(hasher.update, hasher, "")
  local result = noYield(hasher.digest, hasher)
  assert(type(result) == "string" and #result == 64 and string.match(result, "^[0-9a-f]+$"))
  assert(result == expected, "SHA-256 mismatch for " .. tostring(#bytes) .. " bytes: " .. result)
  assert(noYield(hasher.digest, hasher) == result, "repeat digest must be identical")
end
`;

async function runFixture(checks, includeLegacy = false) {
  await verifyTools();
  const source = await readFile(modulePath, 'utf8');
  const legacy = includeLegacy ? await readFile(legacyPath, 'utf8') : null;
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-sha256-stream-fixture-'));
  try {
    const harness = path.join(directory, 'stream-checks.luau');
    // Inject exact source into the verified VM; do not require an engine or plugin.
    await writeFile(harness, `${prelude}\nlocal Sha256Stream = isolatedLoad(function()\n${source}\nend)\n`
      + (legacy ? `local legacyDigest = isolatedLoad(function()\n${legacy}\nend)\n` : '')
      + `${helpers}\n${checks}\nprint("sha256 stream fixture passed")\n`);
    run(compiler, ['--null', harness]);
    assert.match(run(runtime, [harness]), /sha256 stream fixture passed/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-sha256-stream-fixture-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('stream reuses the existing SHA-256 constants and compression exactly', async () => {
  const [stream, legacy] = (await Promise.all([readFile(modulePath, 'utf8'), readFile(legacyPath, 'utf8')]))
    .map(source => source.replace(/\r\n/g, '\n'));
  for (const pattern of [/local ROUND_CONSTANTS[\s\S]*?\n\}\)/, /local function compress[\s\S]*?\nend/]) {
    const expected = legacy.match(pattern)?.[0];
    assert.ok(expected, 'Reference SHA-256 implementation must contain the shared logic.');
    assert.equal(stream.match(pattern)?.[0], expected);
  }
});

test('stream compiles with both explicitly injected, hash-verified offline tools', offlineOptions, async () => {
  await verifyTools();
  run(compiler, ['--null', modulePath]);
});

test('stream matches NIST empty, abc, multi-block, and million-a vectors', offlineOptions, async () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ];
  const checks = vectors.flatMap(([text, expected]) => {
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(nodeDigest(bytes), expected);
    return [[1], [55, 1, 64], [MAX_UPDATE]].map(sizes => streamCheck(luauBytes(bytes), bytes, sizes));
  });
  const million = Buffer.alloc(1_000_000, 97);
  assert.equal(nodeDigest(million), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  checks.push(streamCheck('string.rep("a", 1000000)', million, [MAX_UPDATE]),
    streamCheck('string.rep("a", 1000000)', million, [8191, 131071, 64]));
  await runFixture(checks.join('\n'));
});

test('stream preserves all padding boundaries, split UTF-8, NULs, and random bytes', offlineOptions, async () => {
  const checks = [];
  for (let length = 0; length <= 130; length++) {
    const bytes = Buffer.from(Array.from({ length }, (_, index) => (index * 73 + 19) & 255));
    for (const sizes of [[1], [55, 1, 8], [56, 7], [63, 64], [64]]) {
      checks.push(streamCheck(luauBytes(bytes), bytes, sizes));
    }
  }
  for (const text of ['caf\u00e9 \u4e16\u754c \ud83c\udf19\0tail', '\u00e9', 'e\u0301', '\ufeff\0\r\n']) {
    const bytes = Buffer.from(text, 'utf8');
    checks.push(streamCheck(luauBytes(bytes), bytes, [1]));
  }
  for (const length of [1, 55, 56, 63, 64, 65, 4097, 8193]) {
    const bytes = randomBytes(length);
    checks.push(streamCheck(luauBytes(bytes), bytes, [1, 17, 64, 511]));
  }
  await runFixture(checks.join('\n'));
});

test('actual 720 KiB binary stream exceeds the old cap with varying valid chunks', offlineOptions, async () => {
  const payload = randomBytes(720 * 1024);
  const checks = [`local payload = ${luauBytes(payload)}`];
  for (const sizes of [[MAX_UPDATE], [128 * 1024], [1, 63, 64, 65, 104729, MAX_UPDATE]]) {
    checks.push(streamCheck('payload', payload, sizes));
  }
  checks.push(`
local untouched = Sha256Stream.new()
rejected(function() untouched:update(payload) end, "524288-byte limit")
assert(untouched:digest() == "${nodeDigest(Buffer.alloc(0))}")
rejected(function() legacyDigest(payload) end, "524288-byte limit")
rejected(function() legacyDigest(string.rep("x", ${MAX_UPDATE + 1})) end, "524288-byte limit")
assert(legacyDigest(string.rep("x", ${MAX_UPDATE})) == "${nodeDigest(Buffer.alloc(MAX_UPDATE, 120))}")
`);
  await runFixture(checks.join('\n'), true);
});

test('private frozen handles isolate streams, cache finalization, and reject post-final updates', offlineOptions, async () => {
  await runFixture(`
assert(table.isfrozen(Sha256Stream) and getmetatable(Sha256Stream) == nil)
local moduleFields = 0
for key, value in pairs(Sha256Stream) do
  assert(key == "new" and type(value) == "function")
  moduleFields += 1
end
assert(moduleFields == 1)
local first, second = noYield(Sha256Stream.new), noYield(Sha256Stream.new)
assert(first ~= second and table.isfrozen(first) and getmetatable(first) == nil)
local handleFields = 0
for key, value in pairs(first) do
  assert((key == "update" or key == "digest") and type(value) == "function")
  handleFields += 1
end
assert(handleFields == 2, "no mutable state or serialized token may be exposed")
rejected(function() first.state = {} end, "readonly")
rejected(function() first.update = function() end end, "readonly")
rejected(function() setmetatable(first, {}) end, "readonly")
rejected(function() first.update(second, "bad") end, "original hasher")
rejected(function() first.digest({}) end, "original hasher")
noYield(first.update, first, "a")
noYield(second.update, second, "other")
noYield(first.update, first, "bc")
assert(noYield(first.digest, first) == "${nodeDigest(Buffer.from('abc'))}")
noYield(second.update, second, " stream")
assert(noYield(second.digest, second) == "${nodeDigest(Buffer.from('other stream'))}")
for _ = 1, 3 do
  assert(noYield(first.digest, first) == "${nodeDigest(Buffer.from('abc'))}")
end
rejected(function() first:update("") end, "finalized")
rejected(function() first:update("x") end, "finalized")
rejected(function() first:update(nil) end, "finalized")
rejected(function() first:update({data = "x"}) end, "finalized")
rejected(function() first:update(string.rep("x", ${MAX_UPDATE + 1})) end, "finalized")
assert(noYield(first.digest, first) == "${nodeDigest(Buffer.from('abc'))}")
${streamCheck('"fresh"', Buffer.from('fresh'), [1])}
`);
});

test('nonstring data, getter, and metatable inputs are rejected without invoking user code', offlineOptions, async () => {
  await runFixture(`
local hasher = Sha256Stream.new()
hasher:update("a")
local invoked = 0
local function trap(...: any): any
  invoked += 1
  error("input hooks must never run")
end
local function bad(value: any): ()
  rejected(function() hasher:update(value) end, "must be a string")
end
bad(nil)
for _, value in ipairs({0, true, false, {}, {data = "bc"}, {data = trap}, {getData = trap},
  trap, coroutine.create(trap), buffer.create(0), newproxy(),
  setmetatable({}, {__index = trap, __len = trap, __tostring = trap, __call = trap, __iter = trap})}) do
  bad(value)
end
local userdata = newproxy(true)
getmetatable(userdata).__tostring = trap
getmetatable(userdata).__index = trap
bad(userdata)
assert(invoked == 0)
rejected(function() hasher:update(string.rep("x", ${MAX_UPDATE + 1})) end, "524288-byte limit")
rejected(function() hasher:update(string.rep("\\240\\159\\140\\153", ${MAX_UPDATE / 4 + 1})) end, "524288-byte limit")
hasher:update("bc")
assert(hasher:digest() == "${nodeDigest(Buffer.from('abc'))}", "rejections must not change state")
`);
});

test('inclusive 32 MiB budget validates before mutation and encodes the full bit length', offlineOptions, async () => {
  const expected = nodeDigest(Buffer.alloc(MAX_TOTAL, 120));
  await runFixture(`
local hasher = Sha256Stream.new()
local chunk = string.rep("x", ${MAX_UPDATE})
for _ = 1, ${MAX_TOTAL / MAX_UPDATE - 1} do noYield(hasher.update, hasher, chunk) end
noYield(hasher.update, hasher, string.sub(chunk, 1, #chunk - 1))
rejected(function() hasher:update("xx") end, "33554432-byte cumulative limit")
rejected(function() hasher:update(chunk) end, "33554432-byte cumulative limit")
rejected(function() hasher:update({data = "x"}) end, "must be a string")
noYield(hasher.update, hasher, "x")
noYield(hasher.update, hasher, "")
rejected(function() hasher:update("x") end, "33554432-byte cumulative limit")
assert(noYield(hasher.digest, hasher) == "${expected}")
assert(noYield(hasher.digest, hasher) == "${expected}")
rejected(function() hasher:update("") end, "finalized")
`);
});
