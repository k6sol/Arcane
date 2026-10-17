import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildPlugin, renderPlugin, PLUGIN_SOURCES } from '../../scripts/build-plugin.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDir = path.join(repository, 'plugin/src');
const expectedSources = [
  ['ArcaneLocalBridge', 'Script', 'Main.server.luau'],
  ['Types', 'ModuleScript', 'Types.luau'],
  ['Validation', 'ModuleScript', 'Validation.luau'],
  ['Registry', 'ModuleScript', 'Registry.luau'],
  ['Properties', 'ModuleScript', 'Properties.luau'],
  ['Operations', 'ModuleScript', 'Operations.luau'],
  ['Transport', 'ModuleScript', 'Transport.luau'],
  ['TestProof', 'ModuleScript', 'TestProof.luau'],
  ['Sha256', 'ModuleScript', 'Sha256.luau'],
  ['AssetMesh', 'ModuleScript', 'AssetMesh.luau'],
  ['Sha256Stream', 'ModuleScript', 'Sha256Stream.luau'],
  ['AssetTransfer', 'ModuleScript', 'AssetTransfer.luau'],
  ['AssetMaterials', 'ModuleScript', 'AssetMaterials.luau'],
  ['AssetUpload', 'ModuleScript', 'AssetUpload.luau'],
  ['Diagnostics', 'ModuleScript', 'Diagnostics.luau'],
  ['AssetPlacement', 'ModuleScript', 'AssetPlacement.luau'],
];
const files = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) => ({ filename, source: await readFile(path.join(sourceDir, filename), 'utf8') })));
const byFile = Object.fromEntries(files.map(({ filename, source }) => [filename, source]));
const allSource = files.map(({ source }) => source).join('\n');
const contract = await readFile(path.join(repository, 'docs/build/BRIDGE_CONTRACT.md'), 'utf8');
const protocol = await readFile(path.join(repository, 'packages/protocol/src/studio.ts'), 'utf8');
const policy = await readFile(path.join(repository, 'packages/core/src/studio-policy.ts'), 'utf8');

test('Git checkout keeps plugin source bytes intact with Windows line-ending settings', () => {
  const git = args => {
    const result = spawnSync('git', args, { cwd: repository, windowsHide: true,
      shell: false, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  };
  for (const file of [...PLUGIN_SOURCES.map(([, , name]) => 'plugin/src/' + name), 'plugin/build/ArcaneLocalBridge.rbxmx']) {
    const original = git(['cat-file', 'blob', 'HEAD:' + file]);
    for (const autocrlf of ['true', 'false']) {
      const checkedOut = git(['-c', 'core.autocrlf=' + autocrlf, '-c', 'core.eol=crlf',
        'cat-file', '--filters', '--path=' + file, 'HEAD:' + file]);
      assert.deepEqual(checkedOut, original, file + ' must retain its exact committed bytes.');
    }
  }
});

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
  assert.deepEqual(PLUGIN_SOURCES, expectedSources);
  assert.deepEqual(items.map(({ name, className }) => [name, className]), expectedSources.map(([name, className]) => [name, className]));
  assert.equal(items[0].className, 'Script');
  assert.equal(items[0].name, 'ArcaneLocalBridge');
  items.forEach((item, index) => { assert.equal(item.name, PLUGIN_SOURCES[index][0]); if (index) assert.equal(item.parent, items[0]); });
  assert.equal(items[0].depth, 1);
  assert.match(xml, /<bool name="Disabled">false<\/bool>/);
  assert.equal(new Set(items.map(item => item.referent)).size, PLUGIN_SOURCES.length);
  items.slice(1).forEach(item => { assert.equal(item.className, 'ModuleScript'); assert.equal(item.depth, 2); });
  items.forEach((item, index) => assert.equal(item.source, files[index].source.replace(/\r\n?/g, '\n')));
  assert.equal(manifest.format, 'roblox-xml-v4');
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.pluginVersion, '0.2.0');
  assert.match(byFile['Validation.luau'], /^Validation\.VERSION = "0\.2\.0"$/m);
  assert.deepEqual(manifest.sources, expectedSources.map(([, , filename], index) => ({
    path: `src/${filename}`, bytes: Buffer.byteLength(items[index].source),
    sha256: createHash('sha256').update(items[index].source).digest('hex'),
  })));
  for (const item of items) {
    for (const match of item.source.matchAll(/require\(script(\.Parent)?\.([A-Za-z][A-Za-z0-9_]*)\)/g)) {
      assert.equal(Boolean(match[1]), item.className === 'ModuleScript', `${item.name}: import owner`);
      const owner = match[1] ? item.parent : item;
      assert.ok(items.some(target => target.name === match[2] && target.className === 'ModuleScript' && target.parent === owner), `${item.name}: unresolved packaged module ${match[2]}`);
    }
  }
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
    await assert.rejects(access(path.join(outDir, 'ArcaneLocalBridge.lua')), { code: 'ENOENT' });
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
  assert.deepEqual(Object.keys(project.tree).filter(name => !name.startsWith('$')).sort(), expectedSources.slice(1).map(([name]) => name).sort());
  for (const [name, , filename] of PLUGIN_SOURCES.slice(1)) assert.equal(project.tree[name].$path, `src/${filename}`);
  for (const { filename, source } of files) {
    for (const match of source.matchAll(/require\(script(?:\.Parent)?\.([A-Za-z][A-Za-z0-9]*)\)/g)) {
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
  for (const list of ['ROOTS', 'READ_METHODS', 'WRITE_METHODS', 'ASSET_STAGE_METHODS']) assert.deepEqual(luaList(validation, `Validation.${list}`), tsList(protocol, list));
  assert.deepEqual(luaList(byFile['Properties.luau'], 'Properties.CLASSES'), tsList(policy, 'CREATE_CLASSES'));
  assert.deepEqual(luaList(byFile['Properties.luau'], 'Properties.MATERIALS'), tsList(policy, 'MATERIALS'));
  for (const route of ['/v1/plugin/pair', '/v1/plugin/poll', '/v1/plugin/result', '/v1/plugin/disconnect']) {
    assert.ok(contract.includes(route)); assert.ok(byFile['Transport.luau'].includes(route));
  }
});

test('packaged source has no arbitrary evaluation, asset insertion, unscoped persistence or publishing API', () => {
  assert.doesNotMatch(allSource, /\b(?:loadstring|loadfile|dofile|getfenv|setfenv)\s*\(/);
  assert.doesNotMatch(allSource, /(?:InsertService|DataStoreService|MemoryStoreService|MarketplaceService|PublishToRoblox|StartPlay)/);
  // The one production acquisition belongs only to the guarded host-owned
  // reconstruction operation. It grants no MeshPart/insertion/upload command.
  const acquisition=/GetService\s*\(\s*["']AssetService["']\s*\)/g;
  assert.deepEqual(files.flatMap(file=>[...file.source.matchAll(acquisition)].map(()=>file.filename)),['Operations.luau']);
  const operations=byFile['Operations.luau'],start=operations.indexOf('function Operations:reconstructAsset('),end=operations.indexOf('function Operations:source(',start);
  assert.ok(start>=0&&end>start);assert.equal([...operations.slice(start,end).matchAll(acquisition)].length,1);
  assert.doesNotMatch(operations.slice(0,start)+operations.slice(end),acquisition);
  assert.doesNotMatch(allSource, /:CreateMeshPartAsync\s*\(/);
  assert.doesNotMatch(files.filter(file=>file.filename!=='TestProof.luau').map(file=>file.source).join('\n'), /(?:SetAttribute|AddTag)\s*\(/);
  assert.doesNotMatch(byFile['TestProof.luau'], /AddTag|SetAttribute\([^\n]*(?:apiKey|token|password|credential)/i);
  assert.doesNotMatch(allSource, /\.Source\s*=/);
  assert.doesNotMatch(allSource, /require\(\s*(?:\d|args\.|command\.)/);
  assert.equal((allSource.match(/:RequestAsync\(/g) ?? []).length, 1);
  assert.doesNotMatch(allSource, /:(?:GetAsync|PostAsync)\(/);
  const main = byFile['Main.server.luau'];
  assert.doesNotMatch(files.filter(file => file.filename !== 'Main.server.luau').map(file => file.source).join('\n'), /SetSetting|GetSetting/);
  // The user explicitly authorized these two own-plugin settings. Any new
  // setting name or call shape requires a corresponding reviewed test change.
  const namespaces = Object.fromEntries([...main.matchAll(/local\s+([A-Z_]+)\s*=\s*"(Arcane\.[^"]+)"/g)].map(match => [match[1], match[2]]));
  assert.deepEqual(namespaces, { KEY_SETTING: 'Arcane.LocalApiKey.v1', STATE_SETTING: 'Arcane.LastConnection.v1' });
  const calls = [...main.matchAll(/plugin:(GetSetting|SetSetting)\(\s*([A-Z_]+)/g)].map(match => [match[1], namespaces[match[2]]]);
  assert.deepEqual(calls, [
    ['GetSetting', 'Arcane.LocalApiKey.v1'], ['GetSetting', 'Arcane.LastConnection.v1'],
    ['SetSetting', 'Arcane.LastConnection.v1'], ['SetSetting', 'Arcane.LocalApiKey.v1'],
    ['SetSetting', 'Arcane.LocalApiKey.v1'],
    ['SetSetting', 'Arcane.LocalApiKey.v1'],
  ]);
  assert.equal((main.match(/\b(?:GetSetting|SetSetting)\b/g) ?? []).length, calls.length, 'No alias or dynamic setting access escapes the namespace checks.');
  assert.match(main, /local record: any = \{connected = connected\}[\s\S]*if optOut then record\.autoConnect = false end[\s\S]*SetSetting\(STATE_SETTING, record\)/);
  assert.match(main, /function rememberState\(connected: boolean, allowed: boolean\?\)/);
});

test('transport pins literal loopback routes, handles bounded backoff and fences sessions', () => {
  const transport = byFile['Transport.luau'];
  assert.match(byFile['Validation.luau'], /\^http:\/\/127%\.0%\.0%\.1:/);
  for (const defense of ['self.inFlight', 'Timeout = 10', 'StatusCode >= 300', 'self.generation ~= pair.generation', 'command.clientSessionId ~= self.clientSessionId', 'command.leaseEpoch <= self.highEpoch', 'expires.UnixTimestampMillis <= DateTime.now().UnixTimestampMillis', 'self:isEdit()', 'MAX_CACHE_BYTES', 'MAX_RECEIPTS', 'cached.fingerprint ~= fingerprint', 'self.pending = cached', 'receipt.acknowledged = true', 'task.wait(delay)']) assert.ok(transport.includes(defense), defense);
  assert.match(transport, /POLL_SECONDS = 2/);
  assert.match(transport, /MAX_BACKOFF_SECONDS = 30/);
  assert.doesNotMatch(transport, /table\.remove\(self\.cache|self\.cache\[command\.id\]\s*=\s*nil/);
});

test('panel visibility has no transport lifecycle path and saved health never overrides explicit reconnect intent', () => {
  const main = byFile['Main.server.luau'];
  const transport = byFile['Transport.luau'];
  assert.match(main, /widget:GetPropertyChangedSignal\("Enabled"\):Connect\(function\(\) button:SetActive\(widget\.Enabled\) end\)/);
  assert.match(main, /button\.Click:Connect\(function\(\) widget\.Enabled = not widget\.Enabled end\)/);
  assert.doesNotMatch(transport, /widget|\.Enabled/);
  assert.match(main, /autoConnect = previousState\.autoConnect ~= false/);
  assert.match(main, /if savedKey ~= nil and autoConnect then/);
  assert.doesNotMatch(main, /savedKey ~= nil and lastKnownConnected/);
  assert.match(transport, /route == ROUTES\.poll or route == ROUTES\.result[\s\S]*StatusCode == 404 or response\.StatusCode == 410/);
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

test('offline VM representation retains trusted source bodies but is never a shipped artifact', () => {
  const output = renderPlugin(files);
  assert.equal(output.manifest.preferredArtifact, 'ArcaneLocalBridge.rbxmx');
  assert.ok(output.lua.startsWith('--!strict\n'));
  assert.doesNotMatch(output.lua, /\brequire\s*\(|\b(?:loadstring|loadfile|dofile|getfenv|setfenv)\s*\(/);
  assert.doesNotMatch(output.lua, new RegExp(`\\bscript(?:\\.Parent)?\\.(?:${expectedSources.slice(1).map(([name]) => name).join('|')})\\b`));
  for (const [index, file] of files.entries()) {
    const body = output.lua.split('-- BEGIN ' + file.filename + '\n')[1]?.split('-- END ' + file.filename + '\n')[0];
    assert.ok(body, file.filename);
    const expected = file.source.replace(/\r\n?/g, '\n').replace(/^--!strict\n/, '')
      .replace(/require\(script(?:\.Parent)?\.([A-Za-z][A-Za-z0-9]*)\)/g, '__arcaneRequire("$1")');
    const wrapper = index === 0 ? 'local function __arcaneMain(): ()\n' : '__arcaneFactories["' + PLUGIN_SOURCES[index][0] + '"] = function()\n';
    assert.equal(body, wrapper + expected + (index === 0 ? 'end\n__arcaneMain()\n' : 'end\n'));
  }
  assert.match(output.lua, /table\.freeze\(__arcaneFactories\)/);
  assert.ok(output.manifest.artifacts.every(artifact => artifact.format === 'roblox-xml-v4' && !artifact.name.endsWith('.lua')));
  const reordered = renderPlugin([...files].reverse());
  assert.equal(output.lua, reordered.lua);
});

test('aggregate source can exceed one script while every delivered Script remains bounded', () => {
  const expanded = files.map(file => ({ ...file, source: file.source + '-- ' + 'x'.repeat(18000) + '\n' }));
  const output = renderPlugin(expanded), items = parseBundle(output.xml);
  assert.ok(Buffer.byteLength(output.lua) > 199999);
  assert.ok(items.reduce((total, item) => total + Buffer.byteLength(item.source), 0) > 199999);
  assert.ok(items.every(item => Buffer.byteLength(item.source) <= 199999));
  assert.equal(output.manifest.preferredArtifact, 'ArcaneLocalBridge.rbxmx');
});

test('CDATA expansion cannot produce an artifact beyond the daemon delivery bound', () => {
  const expanded = files.map(file => ({ ...file, source: '--!strict\n--[=[' + ']]>'.repeat(60000) + ']=]\nreturn {}\n' }));
  assert.ok(expanded.every(file => Buffer.byteLength(file.source) <= 199999));
  assert.throws(() => renderPlugin(expanded), /bounded artifact size/);
});

test('rebuild removes only an owned legacy bundle and check mode refuses mixed deliveries', async t => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'arcane-plugin-package-'));
  t.after(async () => { assert.equal(path.dirname(outDir), path.resolve(tmpdir())); await rm(outDir, { recursive: true, force: true }); });
  const output = await buildPlugin({ outDir }), legacyPath = path.join(outDir, 'ArcaneLocalBridge.lua');
  await writeFile(legacyPath, output.lua);
  await assert.rejects(buildPlugin({ outDir, check: true }), /Stale single-script/);
  await buildPlugin({ outDir });
  await assert.rejects(access(legacyPath), { code: 'ENOENT' });
  await writeFile(legacyPath, '-- Unrelated file; preserve me.\n');
  await assert.rejects(buildPlugin({ outDir }), /unrecognized legacy/);
  assert.equal(await readFile(legacyPath, 'utf8'), '-- Unrelated file; preserve me.\n');
});

test('native bundle rejects dynamic, undeclared and incorrectly parented module imports at build time', () => {
  for (const [filename, invalidImports] of [
    ['Main.server.luau', ['require(12345)', 'require(args.module)', 'require(script.Unknown)', 'require(script.Parent.Validation)']],
    ['AssetTransfer.luau', ['require(12345)', 'require(args.module)', 'require(script.Parent.Unknown)', 'require(script.AssetMesh)']],
  ]) {
    for (const invalid of invalidImports) {
      const replacements = files.map(file => file.filename === filename
        ? { ...file, source: '--!strict\nlocal dependency = ' + invalid + '\n' }
        : file);
      assert.throws(() => renderPlugin(replacements), /requires|require/);
    }
  }
});

test('Main exposes the red Arcane brand, editable key, Connect/Reconnect/Connected/Failed and live ACK color', () => {
  const main = byFile['Main.server.luau'];
  assert.equal((main.match(/Instance\.new\("TextBox"\)/g) ?? []).length, 1);
  assert.equal((main.match(/Instance\.new\("TextButton"\)/g) ?? []).length, 1);
  assert.doesNotMatch(main, /requestPair|pairing code|Daemon URL|local url|credits|quota/i);
  assert.doesNotMatch(main, /"(?:OrangeStroke|WhiteStroke|Crossbar|Subtitle|Divider|ConnectionDot|ConnectionStatus|Footer|Grants|Detail|Disconnect)"|Instance\.new\("(?:ImageLabel|ImageButton)"\)/);
  for (const feature of ['"Arcane"', '"Connect"', '"Reconnect"', '"Connected"', '"Failed"', '"Enter a new API key"', 'TextTransparency = 0', 'MaxVisibleGraphemes = -1', 'keyInput.Text = savedKey or ""', 'requestConnect(value)', 'status.sessionId ~= nil', 'status.state == "connected"', 'if live and not keyFailed then colors.green else colors.red']) assert.ok(main.includes(feature), feature);
  assert.match(main, /header[^\n]*UDim2\.new\(1, 0, 0, 48\)/);
  assert.match(main, /connectButton\.Position = UDim2\.new\(0, 14, 0, 100\)/);
  assert.match(main, /inputPanel[^\n]*UDim2\.new\(0, 14, 0, 54\)/);
  assert.match(main, /red = Color3\.fromRGB\(255, 51, 64\)/);
  assert.match(main, /for row = 0, 63 do/);
  assert.doesNotMatch(main, /\b(?:print|warn)\s*\(/);
  assert.ok(byFile['Transport.luau'].includes('"/v1/plugin/connect"'));
  assert.ok(byFile['Validation.luau'].includes('^arcane_local_v1_'));
  assert.doesNotMatch(allSource, /\/v1\/studio\/keys/);
  assert.doesNotMatch(main, /SetAttribute/);
  assert.doesNotMatch(byFile['TestProof.luau'], /SetAttribute\([^\n]*(?:apiKey|token|password|credential)/i);
});

test('native Main auto-opens a compact floating popup with an unobstructed standard key input', () => {
  const main = byFile['Main.server.luau'];
  assert.match(main, /DockWidgetPluginGuiInfo\.new\(Enum\.InitialDockState\.Float, true, true, 260, 184, 230, 176\)/);
  assert.match(main, /panelPadding\.PaddingBottom = UDim\.new\(0, 18\)/);
  assert.match(main, /content = frame\("Content", panel, UDim2\.new\(0, 0, 0\.5, -71\), UDim2\.new\(1, 0, 0, 152\)/);
  assert.match(main, /panelPadding\.Parent = content/);
  assert.match(main, /connectButton\.Parent = content/);
  assert.doesNotMatch(main, /ScrollingFrame|AutomaticCanvasSize|CanvasSize/);
  assert.match(main, /CreateDockWidgetPluginGuiAsync\("ArcaneLocalBridgeFloatingV3", info\)/);
  assert.match(main, /keyInput\.Position = UDim2\.new\(\)/);
  assert.match(main, /keyInput\.Size = UDim2\.fromScale\(1, 1\)/);
  for (const property of ['ZIndex = 3', 'Active = true', 'Selectable = true', 'TextEditable = true']) assert.ok(main.includes('keyInput.' + property), property);
  assert.doesNotMatch(main, /MaskedKey|mask\.ZIndex|TextTransparency = 1|MaxVisibleGraphemes = 0/);
  assert.match(main, /button:SetActive\(widget\.Enabled\)/);
  assert.doesNotMatch(main, /(?:GenerateGUID|math\.random).*ArcaneLocalBridge|CaptureFocus\(/, 'No accumulating random widgets or forced typing focus.');
});

test('native Main scanline polygons exactly match the existing desktop SVG paths and opacity', async () => {
  const html = await readFile(path.join(repository, 'apps/desktop/public/studio.html'), 'utf8');
  const svg = html.match(/<svg class="arcane-logo"[^>]*viewBox="0 0 64 64"[^>]*>([\s\S]*?)<\/svg>/)?.[1];
  assert.ok(svg, 'Use the actual desktop Arcane mark as the reference.');
  const paths = [...svg.matchAll(/<path d="([^"]+)"[^>]*?(?:opacity="([^"]+)")?\s*\/>/g)];
  const polygons = [...byFile['Main.server.luau'].matchAll(/^polygon\("([^"]+)",\s*\{([^\n]+)\},\s*([\d.]+)\)/gm)];
  assert.equal(paths.length, 3); assert.equal(polygons.length, paths.length);
  for (let index = 0; index < paths.length; index++) {
    const points = [...polygons[index][2].matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*\}/g)].map(match => [+match[1], +match[2]]);
    assert.deepEqual(points, svgPolygon(paths[index][1]), polygons[index][1] + ' uses the exact existing SVG polygon.');
    const opacity = /opacity="([^"]+)"/.exec(paths[index][0]);
    assert.ok(Math.abs(+polygons[index][3] - (1 - +(opacity?.[1] ?? 1))) < 1e-12, 'Preserve the SVG facet opacity.');
  }
});

// Independent parser for the reference mark's straight-line SVG path commands.
function svgPolygon(d) {
  const tokens = d.match(/[MmLlHhVvZz]|-?\d+(?:\.\d+)?/g);
  const points = []; let cursor = 0, command, x = 0, y = 0;
  while (cursor < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[cursor])) command = tokens[cursor++];
    if (command.toUpperCase() === 'Z') break;
    const relative = command === command.toLowerCase();
    const first = +tokens[cursor++]; assert.ok(Number.isFinite(first));
    if ('MmLl'.includes(command)) {
      const second = +tokens[cursor++]; assert.ok(Number.isFinite(second));
      x = (relative ? x : 0) + first; y = (relative ? y : 0) + second;
      if (command === 'm') command = 'l'; else if (command === 'M') command = 'L';
    } else if ('Hh'.includes(command)) x = (relative ? x : 0) + first;
    else if ('Vv'.includes(command)) y = (relative ? y : 0) + first;
    else assert.fail('Unsupported reference SVG command: ' + command);
    points.push([x, y]);
  }
  if (points.length > 1 && points.at(-1).every((value, index) => value === points[0][index])) points.pop();
  return points;
}

test('explicit clicks preserve raw keys and save before connecting; text edits fence old access without credential fallback', () => {
  const main = byFile['Main.server.luau'];
  const click = main.slice(main.indexOf('connectButton.Activated:Connect(function()'), main.indexOf('plugin.Unloading:Connect(function()'));
  assert.ok(click.indexOf('invalidateInput()') < click.indexOf('V.keyOrigin(entered)'));
  assert.match(click, /local entered = keyInput\.Text/);
  assert.doesNotMatch(click, /clearInput\(\)|else savedKey/);
  assert.ok(click.indexOf('V.keyOrigin(entered)') < click.indexOf('plugin:SetSetting(KEY_SETTING, value)'));
  assert.ok(click.indexOf('plugin:SetSetting(KEY_SETTING, value)') < click.indexOf('transport:requestConnect(value)'));
  assert.equal((main.match(/requestConnect\(/g) ?? []).length, 2, 'Only explicit input and saved-key recovery queue authentication.');
  assert.match(main, /if savedKey ~= nil and autoConnect then[\s\S]*transport:requestConnect\(savedKey, true\)/);
  const malformed = /if not valid then([\s\S]*?)\n\tend/.exec(click)?.[1];
  assert.ok(malformed);
  assert.match(malformed, /rejectKey\(\)[\s\S]*transport:requestDisconnect\(\)[\s\S]*return/);
  assert.equal((main.match(/requestDisconnect\(/g) ?? []).length, 3, 'Text edits, invalid keys and locally refused connects fence old access; there is no Disconnect control.');
  const rejection = main.slice(main.indexOf('local function rejectKey()'), main.indexOf('local transport:'));
  assert.match(rejection, /savedKey, hint = true, nil, "Enter a new API key"/);
  assert.match(rejection, /plugin:SetSetting\(KEY_SETTING, ""\)/);
  assert.match(rejection, /clearInput\(\)/, 'A current rejection clears the rejected text for replacement guidance.');
  const invalidation = main.slice(main.indexOf('local function invalidateInput()'), main.indexOf('transport = Transport.new'));
  assert.match(invalidation, /keyInput\.Text == inputText then return false/);
  assert.match(invalidation, /savedKey = nil[\s\S]*SetSetting\(KEY_SETTING, ""\)[\s\S]*requestDisconnect\(\)/);
  assert.match(main, /if invalidateInput\(\) then return end[\s\S]*status\.state == "failed"/);
  assert.match(main, /local guard = transport\.guard[\s\S]*transport\.guard = function[\s\S]*invalidateInput\(\)[\s\S]*guard\(client, command, pair\)/, 'Deferred input still advances generation before the original editor callback guard.');
  assert.match(main, /pcall\(function\(\) V\.keyOrigin\(previousKey\) end\)/);
  assert.match(main, /previousKey = nil/);
  assert.match(main, /count == 1 or[\s\S]*count == 2[\s\S]*type\(previousState\.autoConnect\) == "boolean"/);
  const unload = main.slice(main.indexOf('plugin.Unloading:Connect(function()'), main.indexOf('-- Queue safe recovery'));
  assert.match(unload, /savedKey = nil[\s\S]*clearInput\(\)[\s\S]*transport:stop\(\)/);
  assert.doesNotMatch(unload, /SetSetting|GetSetting|requestConnect|requestDisconnect/);
});
