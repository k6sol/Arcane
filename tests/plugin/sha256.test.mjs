import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modulePath = path.join(repository, 'plugin/src/Sha256.luau');
const runtime = process.env.ARCANE_LUAU_BIN;
const compile = process.env.ARCANE_LUAU_COMPILE ?? (runtime ? path.join(path.dirname(runtime), process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile') : undefined);
const runtimeOptions = { skip: !runtime && 'Standalone Luau runtime not configured.' };
const MAX_BYTES = 512 * 1024;
const nodeDigest = bytes => createHash('sha256').update(bytes).digest('hex');

// Decimal byte escapes avoid source encoding, Unicode normalization, and NUL loss.
const luauBytes = bytes => `"${Array.from(bytes, byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
const checkVector = (expression, bytes, expected = nodeDigest(bytes)) =>
  `checkDigest(${expression}, "${expected}")`;

const prelude = `
local digest = require("./Sha256")
assert(type(digest) == "function", "requiring the module must return the digest function")
local function checkDigest(bytes: string, expected: string): ()
  local thread = coroutine.create(function() return digest(bytes) end)
  local ok, result = coroutine.resume(thread)
  assert(ok, tostring(result))
  assert(coroutine.status(thread) == "dead", "digest must finish without yielding")
  assert(type(result) == "string" and #result == 64 and string.match(result, "^[0-9a-f]+$"), "digest must be 64 lowercase hex characters")
  assert(result == expected, "SHA-256 mismatch for " .. tostring(#bytes) .. " bytes: " .. result)
end
local function checkRejected(value: any, message: string): ()
  local ok, result = pcall(digest, value)
  assert(not ok, "invalid input must throw")
  assert(type(result) == "string" and string.find(result, message, 1, true), "expected validation error: " .. tostring(result))
end
`;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function runFixture(checks) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arcane-sha256-fixture-'));
  try {
    // Require the unchanged module in the real VM, without any engine or plugin doubles.
    await writeFile(path.join(directory, 'Sha256.luau'), await readFile(modulePath, 'utf8'));
    const harness = path.join(directory, 'digest-checks.luau');
    await writeFile(harness, `${prelude}\n${checks}\nprint("sha256 fixture passed")\n`);
    if (compile) run(compile, ['--null', harness]);
    assert.match(run(runtime, [harness]), /sha256 fixture passed/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('arcane-sha256-fixture-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('standalone SHA-256 module compiles with the official Luau compiler', { skip: !compile }, () => {
  run(compile, ['--null', modulePath]);
});

test('SHA-256 matches published empty, abc, and multi-block vectors without yielding', runtimeOptions, async () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ];
  const checks = vectors.map(([text, expected]) => {
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(nodeDigest(bytes), expected);
    return checkVector(luauBytes(bytes), bytes, expected);
  });
  // Reuse one required function after different block counts to catch retained state.
  checks.push(checks[1], checks[0]);
  await runFixture(checks.join('\n'));
});

test('SHA-256 hashes UTF-8 and binary bytes exactly, including every padding boundary', runtimeOptions, async () => {
  const texts = ['caf\u00e9 \u4e16\u754c \ud83c\udf19', '\u00e9', 'e\u0301', '\ufeffline\r\nnext\0tail'];
  assert.notEqual(nodeDigest(Buffer.from(texts[1])), nodeDigest(Buffer.from(texts[2])));
  const checks = texts.map(text => {
    const bytes = Buffer.from(text, 'utf8');
    return checkVector(luauBytes(bytes), bytes);
  });
  // Exercise 55/56, 63/64, 119/120, 127/128 and all intervening lengths.
  for (let length = 0; length <= 130; length++) {
    const bytes = Buffer.from(Array.from({ length }, (_, index) => (index * 73 + 19) & 255));
    checks.push(checkVector(luauBytes(bytes), bytes));
  }
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  checks.push(checkVector(luauBytes(allBytes), allBytes));
  await runFixture(checks.join('\n'));
});

test('SHA-256 matches Node crypto on realistic 128 KiB source and the inclusive 512 KiB edge', runtimeOptions, async () => {
  const seed = Buffer.from('--!strict\nlocal label = "caf\u00e9 \u4e16\u754c \ud83c\udf19"\nlocal function identity(value: string): string\n\treturn value\nend\n', 'utf8');
  const checks = [128 * 1024, MAX_BYTES - 1, MAX_BYTES].map(length => {
    const repeats = Math.floor(length / seed.length);
    const remainder = length % seed.length;
    const bytes = Buffer.concat([...Array(repeats).fill(seed), Buffer.alloc(remainder, 32)]);
    assert.equal(bytes.length, length);
    return checkVector(`string.rep(${luauBytes(seed)}, ${repeats}) .. string.rep(" ", ${remainder})`, bytes);
  });
  // 131072 Unicode code points occupy exactly 524288 UTF-8 bytes.
  const emoji = Buffer.from('\ud83c\udf19', 'utf8');
  checks.push(checkVector(`string.rep(${luauBytes(emoji)}, ${MAX_BYTES / emoji.length})`, Buffer.alloc(MAX_BYTES, emoji)));
  checks.push(checkVector('"abc"', Buffer.from('abc')));
  await runFixture(checks.join('\n'));
});

test('SHA-256 rejects nonstrings and oversized byte input, including the million-a vector', runtimeOptions, async () => {
  // The published million-a vector exceeds this API's cap and must throw.
  assert.equal(nodeDigest(Buffer.alloc(1_000_000, 97)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  await runFixture(`
checkRejected(nil, "must be a string")
checkRejected(0, "must be a string")
checkRejected(true, "must be a string")
checkRejected(false, "must be a string")
checkRejected({}, "must be a string")
checkRejected(function() end, "must be a string")
checkRejected(coroutine.create(function() end), "must be a string")
checkRejected(buffer.create(0), "must be a string")
checkRejected(newproxy(), "must be a string")
checkRejected(setmetatable({}, {__len = function() error("length must not run") end}), "must be a string")
checkRejected(string.rep("a", ${MAX_BYTES + 1}), "524288-byte limit")
checkRejected(string.rep("a", 1000000), "524288-byte limit")
checkRejected(string.rep(${luauBytes(Buffer.from('\ud83c\udf19'))}, ${MAX_BYTES / 4 + 1}), "524288-byte limit")
${checkVector('"abc"', Buffer.from('abc'))}
`);
});
