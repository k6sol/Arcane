import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_SOURCES = Object.freeze([
  ['ArcaneLocalBridge', 'Script', 'Main.server.luau'],
  ['Types', 'ModuleScript', 'Types.luau'],
  ['Validation', 'ModuleScript', 'Validation.luau'],
  ['Registry', 'ModuleScript', 'Registry.luau'],
  ['Properties', 'ModuleScript', 'Properties.luau'],
  ['Operations', 'ModuleScript', 'Operations.luau'],
  ['Transport', 'ModuleScript', 'Transport.luau'],
]);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cdata = value => '<![CDATA[' + value.replaceAll(']]>', ']]]]><![CDATA[>') + ']]>';

function item({ name, className, source }, index, children = '') {
  return `<Item class="${className}" referent="RBXArcane${index}">\n<Properties>\n`
    + `<string name="Name">${xmlText(name)}</string>\n`
    + `<bool name="Archivable">true</bool>\n`
    + (className === 'Script' ? '<bool name="Disabled">false</bool>\n' : '')
    + `<ProtectedString name="Source">${cdata(source)}</ProtectedString>\n`
    + `</Properties>\n${children}</Item>\n`;
}

/** Trusted source factories, assembled at build time; no runtime source evaluator. */
export function renderLuaBundle(ordered) {
  const moduleNames = new Set(ordered.slice(1).map(source => source.name));
  const rewrite = ({ source, filename, className }) => {
    if (source.includes('__arcane')) throw new Error(`${filename} uses a reserved bundle identifier.`);
    let rewritten = source.replace(/^local ([A-Za-z][A-Za-z0-9_]*) = require\(script(\.Parent)?\.([A-Za-z][A-Za-z0-9_]*)\)$/gm,
      (call, binding, parent, name) => {
        if (!moduleNames.has(name) || Boolean(parent) !== (className === 'ModuleScript')) throw new Error(`${filename}: unresolved module require ${call}.`);
        return `local ${binding} = __arcaneRequire("${name}")`;
      });
    if (/\brequire\s*\(/.test(rewritten)) throw new Error(`${filename}: only literal declared script-module requires are supported.`);
    return rewritten.replace(/^--!strict\n/, '');
  };
  const prelude = `--!strict
-- Generated from plugin/src; install exactly one Arcane artifact.
-- Factories below contain trusted source code, never strings evaluated at runtime.
local __arcaneFactories: {[string]: () -> any} = {}
local __arcaneCache: {[string]: any} = {}
local __arcaneLoaded: {[string]: boolean} = {}
local __arcaneLoading: {[string]: boolean} = {}
local function __arcaneRequire(name: string): any
\tlocal factory = __arcaneFactories[name]
\tif factory == nil then error("Arcane bundle: undeclared module", 0) end
\tif __arcaneLoaded[name] then return __arcaneCache[name] end
\tif __arcaneLoading[name] then error("Arcane bundle: cyclic module dependency", 0) end
\t__arcaneLoading[name] = true
\tlocal ok, value = pcall(factory)
\t__arcaneLoading[name] = nil
\tif not ok then error(value, 0) end
\tif value == nil then error("Arcane bundle: module returned nil", 0) end
\t__arcaneCache[name] = value
\t__arcaneLoaded[name] = true
\treturn value
end
`;
  const factories = ordered.slice(1).map(module =>
    `-- BEGIN ${module.filename}\n__arcaneFactories["${module.name}"] = function()\n${rewrite(module)}end\n-- END ${module.filename}\n`).join('\n');
  const main = `-- BEGIN ${ordered[0].filename}\nlocal function __arcaneMain(): ()\n${rewrite(ordered[0])}end\n__arcaneMain()\n-- END ${ordered[0].filename}\n`;
  const lua = prelude + factories + '\ntable.freeze(__arcaneFactories)\n\n' + main;
  if (Buffer.byteLength(lua) > 199999) throw new Error('Native Lua bundle exceeds the portable per-script source bound.');
  return lua;
}

/** Pure rendering; never invokes Rojo, Studio, a shell, or third-party code. */
export function renderPlugin(sources) {
  if (!Array.isArray(sources) || sources.length !== PLUGIN_SOURCES.length) throw new Error('Incomplete plugin source hierarchy.');
  const ordered = PLUGIN_SOURCES.map(([name, className, filename]) => {
    const found = sources.filter(source => source.filename === filename);
    if (found.length !== 1 || typeof found[0].source !== 'string') throw new Error(`Missing or duplicate ${filename}.`);
    let source = found[0].source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!source.startsWith('--!strict\n')) throw new Error(`${filename} must start with --!strict.`);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(source)) throw new Error(`${filename} contains an invalid XML character.`);
    if (!source.endsWith('\n')) source += '\n';
    if (Buffer.byteLength(source) > 199999) throw new Error(`${filename} exceeds the portable per-script source bound.`);
    return { name, className, filename, source };
  });
  const modules = ordered.slice(1).map((source, index) => item(source, index + 1)).join('');
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="4">\n'
    + '<External>null</External>\n<External>nil</External>\n'
    + item(ordered[0], 0, modules) + '</roblox>\n';
  const lua = renderLuaBundle(ordered);
  const artifacts = ['ArcaneLocalBridge.rbxm', 'ArcaneLocalBridge.rbxmx', 'ArcaneLocalBridge.lua'];
  const manifest = {
    schemaVersion: 1,
    protocolVersion: 1,
    pluginVersion: '0.1.3',
    format: 'roblox-xml-v4',
    preferredArtifact: 'ArcaneLocalBridge.lua',
    entry: 'ArcaneLocalBridge',
    sources: ordered.map(({ filename, source }) => ({ path: `src/${filename}`, bytes: Buffer.byteLength(source), sha256: sha256(source) })),
    artifacts: artifacts.map(name => {
      const content = name.endsWith('.lua') ? lua : xml;
      return { name, format: name.endsWith('.lua') ? 'luau-source' : 'roblox-xml-v4', bytes: Buffer.byteLength(content), sha256: sha256(content) };
    }),
  };
  return { xml, lua, manifest, artifacts, sources: ordered };
}

export async function buildPlugin({ sourceDir = path.join(repository, 'plugin', 'src'), outDir = path.join(repository, 'plugin', 'build'), check = false } = {}) {
  const sourceFiles = await Promise.all(PLUGIN_SOURCES.map(async ([, , filename]) => ({ filename, source: await readFile(path.join(sourceDir, filename), 'utf8') })));
  const rendered = renderPlugin(sourceFiles);
  const files = [...rendered.artifacts.map(name => [name, name.endsWith('.lua') ? rendered.lua : rendered.xml]), ['manifest.json', JSON.stringify(rendered.manifest, null, 2) + '\n']];
  if (check) {
    for (const [name, expected] of files) {
      if (await readFile(path.join(outDir, name), 'utf8') !== expected) throw new Error(`Plugin artifact is missing or stale: ${name}`);
    }
  } else {
    await mkdir(outDir, { recursive: true });
    for (const [name, content] of files) await writeFile(path.join(outDir, name), content, 'utf8');
  }
  return { ...rendered, outDir: path.resolve(outDir) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let outDir;
    let check = false;
    for (let index = 2; index < process.argv.length; index++) {
      const arg = process.argv[index];
      if (arg === '--check') check = true;
      else if (arg === '--out-dir' && process.argv[index + 1]) outDir = path.resolve(process.argv[++index]);
      else throw new Error('Usage: node scripts/build-plugin.mjs [--out-dir DIRECTORY] [--check]');
    }
    const result = await buildPlugin({ outDir, check });
    process.stdout.write(`${check ? 'Verified' : 'Built'} Arcane local plugin (native Lua + Roblox XML v4, protocol 1): ${result.outDir}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
