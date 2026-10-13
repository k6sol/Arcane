import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, sep, win32 } from 'node:path';
import { createNativeCliResolver, locateNativeCli } from '../../packages/model-adapters/src/process.js';

type Entry = { full: string; kind: 'file' | 'directory'; mode: number; target?: string; denied?: boolean };
function fixture(platform: NodeJS.Platform = 'win32', arch = 'x64') {
  const p = platform === 'win32' ? win32 : posix;
  const home = platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture';
  const tools = platform === 'win32' ? 'C:\\Tools' : '/tools';
  const local = p.join(home, 'AppData', 'Local'), installed = p.join(local, 'OpenAI', 'Codex', 'bin');
  const entries = new Map<string, Entry>(), probes: string[] = [], scans: string[] = [];
  const inventory = { yielded: 0, closed: 0, failAfter: -1 };
  const key = (value: string) => platform === 'win32' ? p.normalize(value).toLowerCase() : p.normalize(value);
  function put(value: string, kind: Entry['kind'] = 'directory', attributes: Partial<Entry> = {}) {
    const full = p.normalize(value), parent = p.dirname(full);
    if (full !== parent && !entries.has(key(parent))) put(parent);
    entries.set(key(full), { full, kind, mode: 0o755, ...attributes });
  }
  function get(value: string) {
    const entry = entries.get(key(value));
    if (!entry) throw new Error('Fixture path is absent.');
    return entry;
  }
  const fs = {
    async realpath(value: string) { probes.push(value); const entry = get(value); return entry.target ?? entry.full; },
    async stat(value: string) { const entry = get(value); return { isFile: () => entry.kind === 'file', mode: entry.mode }; },
    async access(value: string, _mode: number) { if (get(value).denied) throw new Error('Fixture access denied.'); },
    async opendir(value: string) {
      scans.push(value); assert.equal(get(value).kind, 'directory');
      return (async function* () {
        try {
          for (const entry of entries.values()) {
            if (key(entry.full) === key(value) || key(p.dirname(entry.full)) !== key(value)) continue;
            if (inventory.yielded === inventory.failAfter) throw new Error('Fixture inventory failed.');
            inventory.yielded++;
            yield { name: p.basename(entry.full), isDirectory: () => entry.kind === 'directory' };
          }
        } finally { inventory.closed++; }
      })();
    },
  };
  const resolve = createNativeCliResolver({ fs, platform, arch, homedir: () => home });
  const env = { PATH: tools, LOCALAPPDATA: local };
  const filename = (name: 'codex' | 'claude') => name + (platform === 'win32' ? '.exe' : '');
  function payload(layout: 'nested' | 'sibling' | 'legacy', directory = tools, payloadArch = arch) {
    const base = p.join(directory, 'node_modules', '@openai');
    const root = layout === 'nested' ? p.join(base, 'codex', 'node_modules', '@openai', 'codex-win32-' + payloadArch) :
      layout === 'sibling' ? p.join(base, 'codex-win32-' + payloadArch) : p.join(base, 'codex');
    return p.join(root, 'vendor', payloadArch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc', 'codex', 'codex.exe');
  }
  return { p, home, tools, local, installed, entries, probes, scans, inventory, key, put, resolve, env, filename, payload };
}

test('PATH keeps first-match precedence, balanced quotes, Path alias and canonical native result', async () => {
  const f = fixture(), first = f.p.join(f.tools, 'codex.exe'), second = 'D:\\Tools\\codex.exe';
  f.put(first, 'file'); f.put(second, 'file');
  f.put(f.p.join(f.home, '.local', 'bin', 'codex.exe'), 'file');
  assert.equal(await f.resolve('codex', { Path: '"' + f.tools + '";D:\\Tools' }), first);
  assert.deepEqual(f.probes, [first]); assert.deepEqual(f.scans, []);
});

test('official home .local/bin resolves Codex and Claude on Windows, Linux and macOS', async () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) for (const name of ['codex', 'claude'] as const) {
    const f = fixture(platform), executable = f.p.join(f.home, '.local', 'bin', f.filename(name));
    f.put(executable, 'file');
    assert.equal(await f.resolve(name, f.env), executable);
    assert.deepEqual(f.scans, []);
  }
});

test('Codex installed bin accepts exactly one valid lowercase 16-hex directory candidate', async () => {
  const f = fixture(), executable = f.p.join(f.installed, '2e5e00daee91c61d', 'codex.exe');
  for (const name of ['abcdef012345678', 'abcdef01234567890', 'ABCDEF0123456789', 'latest', '..build']) {
    f.put(f.p.join(f.installed, name, 'codex.exe'), 'file');
  }
  f.put(f.p.join(f.installed, '1111111111111111'), 'file');
  f.put(f.p.join(f.installed, '2222222222222222', 'codex.cmd'), 'file');
  f.put(executable, 'file');
  assert.equal(await f.resolve('codex', f.env), executable);
  assert.deepEqual(f.scans, [f.installed]); assert.equal(f.inventory.closed, 1);
  assert.equal(f.probes.filter(value => value.startsWith(f.installed)).length, 2);
});

test('ambiguous native builds fail closed even with an npm fallback, without choosing a build ID', async () => {
  const f = fixture();
  for (const build of ['ffffffffffffffff', '0000000000000000']) f.put(f.p.join(f.installed, build, 'codex.exe'), 'file');
  f.put(f.payload('nested'), 'file');
  assert.equal(await f.resolve('codex', f.env), null);
  assert.ok(!f.probes.some(value => value.includes('node_modules'))); assert.equal(f.inventory.closed, 1);
});

test('native inventory accepts 32 entries but rejects a 33rd sentinel and closes its iterator', async () => {
  for (const count of [32, 33]) {
    const f = fixture(), executable = f.p.join(f.installed, '1111111111111111', 'codex.exe');
    f.put(executable, 'file');
    for (let i = 1; i < count; i++) f.put(f.p.join(f.installed, 'ignored-' + i));
    f.put(f.payload('nested'), 'file');
    assert.equal(await f.resolve('codex', f.env), count === 32 ? executable : null);
    assert.equal(f.inventory.yielded, count); assert.equal(f.inventory.closed, 1);
    assert.ok(!f.probes.some(value => /ignored-|node_modules/.test(value)));
  }
});

test('partial native enumeration fails closed instead of accepting its sole observed candidate', async () => {
  const f = fixture();
  f.put(f.p.join(f.installed, '1111111111111111', 'codex.exe'), 'file');
  f.put(f.p.join(f.installed, 'another-entry')); f.put(f.payload('nested'), 'file'); f.inventory.failAfter = 1;
  assert.equal(await f.resolve('codex', f.env), null);
  assert.equal(f.inventory.closed, 1); assert.ok(!f.probes.some(value => value.includes('node_modules')));
});

test('npm resolves all three fixed direct payload layouts for x64 and arm64, ignoring shims', async () => {
  for (const arch of ['x64', 'arm64']) for (const layout of ['nested', 'sibling', 'legacy'] as const) {
    const f = fixture('win32', arch), executable = f.payload(layout);
    for (const shim of ['codex', 'codex.cmd', 'codex.ps1', 'codex.js']) f.put(f.p.join(f.tools, shim), 'file');
    f.put(executable, 'file');
    assert.equal(await f.resolve('codex', f.env), executable);
    assert.ok(!f.probes.some(value => /\.(?:cmd|ps1|js)$/.test(value)));
  }
});

test('empty installed inventory falls through to npm; Claude never scans Codex installs or npm', async () => {
  const f = fixture(), executable = f.payload('sibling');
  f.put(f.installed); f.put(executable, 'file');
  assert.equal(await f.resolve('codex', f.env), executable);
  f.probes.length = 0; f.scans.length = 0;
  assert.equal(await f.resolve('claude', f.env), null);
  assert.deepEqual(f.scans, []); assert.ok(!f.probes.some(value => value.includes('node_modules')));
});

test('npm never guesses another architecture, platform or arbitrary vendor layout', async () => {
  for (const [platform, arch] of [['win32', 'ia32'], ['linux', 'x64'], ['darwin', 'arm64']] as const) {
    const f = fixture(platform, arch); f.put(f.payload('nested', f.tools, 'x64'), 'file');
    assert.equal(await f.resolve('codex', f.env), null);
    assert.ok(!f.probes.some(value => value.includes('node_modules')));
  }
  const f = fixture();
  f.put(f.payload('nested', f.tools, 'arm64'), 'file');
  f.put(f.p.join(f.tools, 'node_modules', '@openai', 'codex', 'random', 'codex.exe'), 'file');
  assert.equal(await f.resolve('codex', f.env), null);
});

test('invalid Windows PATH and native roots are rejected before filesystem access', async () => {
  const f = fixture();
  const invalid = ['', '.', 'C:relative', '\\root-relative', '\\\\server\\share', '\\\\?\\C:\\Tools',
    ' C:\\Tools', 'C:\\Tools ', 'C:\\bad\npath', 'C:\\bad\u0000path', 'C:\\bad\u202epath',
    'C:\\Tools:stream', 'C:\\bad.', 'C:\\con', 'C:\\lpt1.txt', 'C:\\bad?path', '"C:\\Tools', 'C:\\' + 'x'.repeat(2048)];
  assert.equal(await f.resolve('codex', { PATH: invalid.join(';'), LOCALAPPDATA: '\\\\server\\share' }), null);
  assert.deepEqual(f.probes, [f.p.join(f.home, '.local', 'bin', 'codex.exe')]); assert.deepEqual(f.scans, []);
});

test('canonical targets must remain absolute regular accessible native files', async () => {
  for (const target of ['relative\\codex.exe', '\\\\server\\share\\codex.exe', 'C:\\Tools\\codex.cmd', 'C:\\Tools\\bad\n\\codex.exe']) {
    const f = fixture(), source = f.p.join(f.tools, 'codex.exe');
    f.put(target, 'file'); f.put(source, 'file', { target });
    assert.equal(await f.resolve('codex', f.env), null);
  }
  for (const attributes of [{ kind: 'directory' as const }, { denied: true }]) {
    const f = fixture(); f.put(f.p.join(f.tools, 'codex.exe'), 'file', attributes);
    assert.equal(await f.resolve('codex', f.env), null);
  }
  const f = fixture(), target = 'D:\\Native\\CODEX.EXE';
  f.put(target, 'file'); f.put(f.p.join(f.tools, 'codex.exe'), 'file', { target });
  assert.equal(await f.resolve('codex', f.env), target);
});

test('POSIX native symlinks can resolve versioned Claude files but require executable permission', async () => {
  for (const mode of [0o644, 0o755]) {
    const f = fixture('linux'), target = '/home/fixture/.local/share/claude/versions/1.2.3';
    f.put(target, 'file', { mode });
    f.put(f.p.join(f.home, '.local', 'bin', 'claude'), 'file', { target });
    assert.equal(await f.resolve('claude', f.env), mode === 0o755 ? target : null);
  }
});

test('PATH is limited to 64 entries and 32768 characters, with Windows duplicate directories collapsed', async () => {
  for (const count of [64, 65]) {
    const f = fixture(), directories = Array.from({ length: count }, (_, i) => 'C:\\Tools' + i);
    const executable = f.p.join(directories[count - 1]!, 'codex.exe'); f.put(executable, 'file');
    assert.equal(await f.resolve('codex', { PATH: directories.join(';') }), count === 64 ? executable : null);
    assert.equal(f.probes.length, count === 64 ? 64 : 1);
  }
  const f = fixture();
  assert.equal(await f.resolve('claude', { PATH: 'C:\\' + 'x'.repeat(32768) }), null); assert.equal(f.probes.length, 1);
  f.probes.length = 0;
  assert.equal(await f.resolve('claude', { PATH: 'C:\\Tools;c:\\tools;"C:\\Tools"' }), null);
  assert.equal(f.probes.length, 2);
});

test('worst-case metadata search is bounded to 289 candidate paths and 32 build entries', async () => {
  const f = fixture();
  const directories = Array.from({ length: 64 }, (_, i) => 'C:\\Tools' + i);
  for (let i = 0; i < 32; i++) f.put(f.p.join(f.installed, i.toString(16).padStart(16, '0')));
  assert.equal(await f.resolve('codex', { PATH: directories.join(';'), LOCALAPPDATA: f.local }), null);
  assert.equal(f.probes.length, 64 + 1 + 32 + 64 * 3);
  assert.equal(f.inventory.yielded, 32); assert.deepEqual(f.scans, [f.installed]);
});

test('resolution only reads routing environment fields, and never walks provider state', async () => {
  const f = fixture(), reads: PropertyKey[] = [];
  const env = new Proxy<NodeJS.ProcessEnv>({}, { get(_target, key) {
    reads.push(key); assert.ok(['PATH', 'Path', 'LOCALAPPDATA'].includes(String(key))); return undefined;
  } });
  assert.equal(await f.resolve('codex', env), null);
  assert.deepEqual(reads, ['PATH', 'Path', 'LOCALAPPDATA']);
  assert.deepEqual(f.probes, [f.p.join(f.home, '.local', 'bin', 'codex.exe')]); assert.deepEqual(f.scans, []);
});

test('production resolver preserves its two-argument contract using only owned empty native files', async t => {
  const boundary = await realpath(tmpdir()), directory = await mkdtemp(join(boundary, 'arcane-provider-executable-'));
  t.after(async () => {
    const owned = relative(boundary, directory);
    assert.ok(owned.startsWith('arcane-provider-executable-') && !isAbsolute(owned) && !owned.includes(sep));
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of ['codex', 'claude'] as const) {
    const executable = join(directory, name + (process.platform === 'win32' ? '.exe' : ''));
    await writeFile(executable, '', { flag: 'wx' });
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    assert.equal(await locateNativeCli(name, { PATH: directory }), await realpath(executable));
  }
  // Exercise real filesystem native-home fallback without inspecting the host's home.
  const resolve = createNativeCliResolver({ homedir: () => directory });
  await mkdir(join(directory, '.local', 'bin'), { recursive: true });
  const native = join(directory, '.local', 'bin', 'claude' + (process.platform === 'win32' ? '.exe' : ''));
  await writeFile(native, '', { flag: 'wx' });
  if (process.platform !== 'win32') await chmod(native, 0o755);
  assert.equal(await resolve('claude', { PATH: '' }), await realpath(native));
});
