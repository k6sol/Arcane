import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPlugin, renderPlugin, PLUGIN_SOURCES } from '../../scripts/build-plugin.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDir = path.join(repository, 'plugin/src');
const files = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) => ({ filename, source: await readFile(path.join(sourceDir, filename), 'utf8') })));
const byFile = Object.fromEntries(files.map(({ filename, source }) => [filename, source]));
const allSource = files.map(({ source }) => source).join('\n');
const contract = await readFile(path.join(repository, 'docs/build/BRIDGE_CONTRACT.md'), 'utf8');
const protocol = await readFile(path.join(repository, 'packages/protocol/src/studio.ts'), 'utf8');
const policy = await readFile(path.join(repository, 'packages/core/src/studio-policy.ts'), 'utf8');

// Independent XML subset reader. It checks nesting and reconstructs CDATA/source
// rather than comparing the builder's output to its own rendering function.
function parseBundle(xml) {
  const stack = [];
  const items = [];
  let currentSource;
  let currentName;
  const itemStack = [];
  let cursor = 0;
  while (cursor < xml.length) {
    if (xml.startsWith('<?xml ', cursor)) {
      const end = xml.indexOf('?>', cursor); assert.ok(end >= 0); cursor = end + 2; continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor); assert.ok(end >= 0);
      assert.equal(stack.at(-1), 'ProtectedString');
      currentSource.source += xml.slice(cursor + 9, end); cursor = end + 3; continue;
    }
    if (xml[cursor] !== '<') {
      let end = xml.indexOf('<', cursor); if (end < 0) end = xml.length;
      const value = xml.slice(cursor, end);
      assert.ok(!value.includes(']]>'));
      assert.ok(!/&(?!(?:amp|lt|gt|quot|apos);)/u.test(value));
      if (currentName) currentName.name = value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
      cursor = end; continue;
    }
    const end = xml.indexOf('>', cursor); assert.ok(end >= 0);
    const tag = xml.slice(cursor + 1, end);
    if (tag.startsWith('/')) {
      assert.equal(stack.pop(), tag.slice(1));
      if (tag === '/ProtectedString') currentSource = undefined;
      if (tag === '/string') currentName = undefined;
      if (tag === '/Item') itemStack.pop();
    } else {
      const match = /^([A-Za-z]+)(?:\s[^<>]*)?$/.exec(tag); assert.ok(match, tag);
      const name = match[1];
      stack.push(name);
      if (name === 'Item') {
        const className = /class="([^"]+)"/.exec(tag)?.[1];
        const referent = /referent="([^"]+)"/.exec(tag)?.[1];
        assert.ok(className && referent);
        const item = { className, referent, parent: itemStack.at(-1), depth: stack.filter(value => value === 'Item').length };
        items.push(item); itemStack.push(item);
      } else if (name === 'string' && /name="Name"/.test(tag)) {
        currentName = itemStack.at(-1);
      } else if (name === 'ProtectedString') {
        assert.match(tag, /name="Source"/); currentSource = items.at(-1); currentSource.source = '';
      }
    }
    cursor = end + 1;
  }
  assert.deepEqual(stack, []);
  return items;
}

test('portable bundle has one enabled Script and all strict ModuleScripts as children', () => {
  const { xml, manifest } = renderPlugin(files);
  const items = parseBundle(xml);
  assert.equal(items.length, 7);
  assert.equal(items[0].className, 'Script');
  assert.equal(items[0].name, 'ArcaneLocalBridge');
  items.forEach((item, index) => { assert.equal(item.name, PLUGIN_SOURCES[index][0]); if (index) assert.equal(item.parent, items[0]); });
  assert.equal(items[0].depth, 1);
  assert.match(xml, /<bool name="Disabled">false<\/bool>/);
  assert.equal(new Set(items.map(item => item.referent)).size, 7);
  items.slice(1).forEach(item => { assert.equal(item.className, 'ModuleScript'); assert.equal(item.depth, 2); });
  items.forEach((item, index) => assert.equal(item.source, files[index].source.replace(/\r\n?/g, '\n')));
  assert.equal(manifest.format, 'roblox-xml-v4');
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.artifacts[0].sha256, createHash('sha256').update(xml).digest('hex'));
});

test('render is deterministic across input order and line endings', () => {
  const first = renderPlugin(files);
  const second = renderPlugin([...files].reverse().map(item => ({ ...item, source: '\uFEFF' + item.source.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n') })));
  assert.equal(first.xml, second.xml);
  assert.equal(first.lua, second.lua);
  assert.deepEqual(first.manifest, second.manifest);
  assert.ok(!JSON.stringify(first.manifest).includes(repository));
});

test('CDATA terminators, XML markup, and Unicode survive the package', () => {
  const replacement = files.map((file, index) => index === 1 ? { ...file, source: '--!strict\n-- ]]> & <tag> "café 🧪"\nreturn {}\n' } : file);
  const output = renderPlugin(replacement);
  assert.equal(parseBundle(output.xml)[1].source, replacement[1].source);
  assert.match(output.xml, /\]\]\]\]><!\[CDATA\[>/);
});

test('malformed/incomplete/overlarge source is refused', () => {
  assert.throws(() => renderPlugin(files.slice(1)), /Incomplete/);
  for (const source of ['return {}\n', '--!strict\n\0\n', '--!strict\n\ud800\n', '--!strict\n' + 'a'.repeat(200000)]) {
    assert.throws(() => renderPlugin(files.map((file, index) => index ? file : { ...file, source })));
  }
});

test('builder and check mode use only a selected output directory and detect stale content', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'arcane-plugin-package-'));
  try {
    const first = await buildPlugin({ outDir });
    await buildPlugin({ outDir, check: true });
    assert.equal(await readFile(path.join(outDir, 'ArcaneLocalBridge.rbxm'), 'utf8'), first.xml);
    assert.equal(await readFile(path.join(outDir, 'ArcaneLocalBridge.rbxmx'), 'utf8'), first.xml);
    assert.equal(await readFile(path.join(outDir, 'ArcaneLocalBridge.lua'), 'utf8'), first.lua);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(outDir, 'ArcaneLocalBridge.rbxm'), 'stale');
    await assert.rejects(() => buildPlugin({ outDir, check: true }), /stale/);
  } finally {
    assert.equal(path.dirname(path.resolve(outDir)), path.resolve(tmpdir()), 'cleanup stays in the selected temporary directory');
    assert.ok(path.basename(outDir).startsWith('arcane-plugin-package-'), 'cleanup targets only this generated test directory');
    await rm(outDir, { recursive: true, force: true });
  }
});

test('Rojo source map resolves the same Script/module hierarchy', async () => {
  const project = JSON.parse(await readFile(path.join(repository, 'plugin/default.project.json'), 'utf8'));
  assert.equal(project.tree.$className, 'Script');
  assert.equal(project.tree.$path, 'src/Main.server.luau');
  for (const [name, , filename] of PLUGIN_SOURCES.slice(1)) assert.equal(project.tree[name].$path, `src/${filename}`);
  for (const { filename, source } of files) {
    for (const match of source.matchAll(/require\(script(?:\.Parent)?\.([A-Za-z]+)\)/g)) {
      assert.equal(match[0].includes('.Parent.'), filename !== 'Main.server.luau', 'require resolves at actual script hierarchy');
      assert.ok(PLUGIN_SOURCES.some(([name]) => name === match[1]), `${filename}: unresolved module ${match[1]}`);
    }
  }
});

function luaList(source, name) {
  const match = new RegExp(`${name} = table\\.freeze\\(\\{([^}]+)\\}\\)`).exec(source);
  assert.ok(match, name); return [...match[1].matchAll(/"([^"]+)"/g)].map(value => value[1]);
}
function tsList(source, name) {
  const match = new RegExp(`(?:const ${name}|${name}) = \\[([^\\]]+)\\]`).exec(source);
  assert.ok(match, name); return [...match[1].matchAll(/'([^']+)'/g)].map(value => value[1]);
}

test('method/root/class/material allowlists exactly match the shared protocol and daemon', () => {
  const validation = byFile['Validation.luau'];
  for (const list of ['ROOTS', 'READ_METHODS', 'WRITE_METHODS']) assert.deepEqual(luaList(validation, `Validation.${list}`), tsList(protocol, list));
  assert.deepEqual(luaList(byFile['Properties.luau'], 'Properties.CLASSES'), tsList(policy, 'CREATE_CLASSES'));
  assert.deepEqual(luaList(byFile['Properties.luau'], 'Properties.MATERIALS'), tsList(policy, 'MATERIALS'));
  for (const route of ['/v1/plugin/pair', '/v1/plugin/poll', '/v1/plugin/result', '/v1/plugin/disconnect']) {
    assert.ok(contract.includes(route)); assert.ok(byFile['Transport.luau'].includes(route));
  }
});

test('packaged source has no arbitrary evaluation, asset insertion, persistence or publishing API', () => {
  assert.doesNotMatch(allSource, /\b(?:loadstring|loadfile|dofile|getfenv|setfenv)\s*\(/);
  assert.doesNotMatch(allSource, /(?:InsertService|AssetService|DataStoreService|MemoryStoreService|MarketplaceService|PublishToRoblox|StartPlay|SetSetting|GetSetting)/);
  assert.doesNotMatch(allSource, /(?:SetAttribute|AddTag)\s*\(/);
  assert.doesNotMatch(allSource, /\.Source\s*=/);
  assert.doesNotMatch(allSource, /require\(\s*(?:\d|args\.|command\.)/);
  assert.equal((allSource.match(/:RequestAsync\(/g) ?? []).length, 1);
  assert.doesNotMatch(allSource, /:(?:GetAsync|PostAsync)\(/);
});

test('transport pins literal loopback routes, handles bounded backoff and fences sessions', () => {
  const transport = byFile['Transport.luau'];
  assert.match(byFile['Validation.luau'], /\^http:\/\/127%\.0%\.0%\.1:/);
  for (const defense of ['self.inFlight', 'Timeout = 10', 'StatusCode >= 300', 'self.generation ~= pair.generation', 'command.clientSessionId ~= self.clientSessionId', 'command.leaseEpoch <= self.highEpoch', 'expires.UnixTimestampMillis <= DateTime.now().UnixTimestampMillis', 'self.run:IsEdit()', 'MAX_CACHE_BYTES', 'MAX_RECEIPTS', 'cached.fingerprint ~= fingerprint', 'self.pending = cached', 'receipt.acknowledged = true', 'task.wait(delay)']) assert.ok(transport.includes(defense), defense);
  assert.match(transport, /POLL_SECONDS = 2/);
  assert.match(transport, /MAX_BACKOFF_SECONDS = 30/);
  assert.doesNotMatch(transport, /table\.remove\(self\.cache|self\.cache\[command\.id\]\s*=\s*nil/);
});

test('mutation code uses editor baseline callback, immutable receipts and guarded history', () => {
  const source = byFile['Operations.luau'];
  for (const defense of ['GetEditorSource(instance)', 'UpdateSourceAsync(instance', 'if current ~= expected then conflict = true end', 'if conflict then return nil end', 'TryBeginRecording', 'FinishRecording', 'progress.touched', 'partial = true', 'rollbackVerified = false', 'self.mutations[receiptId]', 'V.equal(original, args.mutation)', '#instance:GetChildren() == 0', 'instance.Parent == owned.parent', 'self:source(instance) == owned.source', 'instance.Disabled = true']) assert.ok(source.includes(defense), defense);
  const callback = source.slice(source.indexOf('function(current: string)'), source.indexOf('local observed ='));
  assert.doesNotMatch(callback, /task\.|:GetEditorSource|:RequestAsync/);
  assert.match(source, /before = \{properties = before\}, after = \{properties = P\.snapshot\(instance, names\)\}/);
  assert.match(byFile['Registry.luau'], /local instance = self\.byId\[ref\.instanceId\]/);
  assert.doesNotMatch(byFile['Registry.luau'], /FindFirstChild|WaitForChild|GetFullName/);
});

test('native Lua artifact contains the same trusted module bodies and Main with declared literal imports', () => {
  const output = renderPlugin(files);
  assert.equal(output.manifest.preferredArtifact, 'ArcaneLocalBridge.lua');
  assert.ok(output.lua.startsWith('--!strict\n'));
  assert.doesNotMatch(output.lua, /\brequire\s*\(|\b(?:loadstring|loadfile|dofile|getfenv|setfenv)\s*\(/);
  assert.doesNotMatch(output.lua, /\bscript(?:\.Parent)?\.(?:Validation|Transport|Registry|Properties|Operations|Types)\b/);
  for (const [index, file] of files.entries()) {
    const body = output.lua.split('-- BEGIN ' + file.filename + '\n')[1]?.split('-- END ' + file.filename + '\n')[0];
    assert.ok(body, file.filename);
    const expected = file.source.replace(/\r\n?/g, '\n').replace(/^--!strict\n/, '')
      .replace(/require\(script(?:\.Parent)?\.([A-Za-z]+)\)/g, '__arcaneRequire("$1")');
    const wrapper = index === 0 ? 'local function __arcaneMain(): ()\n' : '__arcaneFactories["' + PLUGIN_SOURCES[index][0] + '"] = function()\n';
    assert.equal(body, wrapper + expected + (index === 0 ? 'end\n__arcaneMain()\n' : 'end\n'));
  }
  assert.match(output.lua, /table\.freeze\(__arcaneFactories\)/);
  const native = output.manifest.artifacts.find(artifact => artifact.name === 'ArcaneLocalBridge.lua');
  assert.equal(native.format, 'luau-source');
  assert.equal(native.bytes, Buffer.byteLength(output.lua));
  assert.equal(native.sha256, createHash('sha256').update(output.lua).digest('hex'));
  const reordered = renderPlugin([...files].reverse());
  assert.equal(output.lua, reordered.lua);
});

test('native bundle rejects dynamic, undeclared and incorrectly parented module imports at build time', () => {
  for (const invalid of ['require(12345)', 'require(args.module)', 'require(script.Unknown)', 'require(script.Parent.Validation)']) {
    const replacements = files.map((file, index) => index === 0
      ? { ...file, source: '--!strict\nlocal dependency = ' + invalid + '\n' }
      : file);
    assert.throws(() => renderPlugin(replacements), /requires|require/);
  }
});

test('native Main exposes only one masked API key field with compact Arcane styling and real status', () => {
  const main = byFile['Main.server.luau'];
  assert.equal((main.match(/Instance\.new\("TextBox"\)/g) ?? []).length, 1);
  assert.equal((main.match(/Instance\.new\("TextButton"\)/g) ?? []).length, 1);
  assert.doesNotMatch(main, /requestPair|pairing code|Daemon URL|local url|credits|quota/i);
  for (const feature of ['"API Key"', '"Arcane"', '"OrangeStroke"', '"WhiteStroke"', '"Divider"', '"Connect"', '"Disconnect"', 'TextTransparency = 1', 'MaxVisibleGraphemes = 0', 'local entered = keyInput.Text', 'clearInput()', 'requestConnect(entered)', 'status.sessionId ~= nil', 'status.state == "connected"']) assert.ok(main.includes(feature), feature);
  assert.ok(byFile['Transport.luau'].includes('"/v1/plugin/connect"'));
  assert.ok(byFile['Validation.luau'].includes('^arcane_local_v1_'));
  assert.doesNotMatch(allSource, /\/v1\/studio\/keys|SetSetting|SetAttribute|GetSetting/);
});
