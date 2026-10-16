import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';

// Compiles the ACTUAL installer/InstallationActivity.cs (+ SetupPath.cs, read-only dependency) with the in-box .NET
// Framework csc.exe into a SEPARATE owned harness, plus a tiny OWNED console peer. Only exact owned TEMP files are
// registered with Restart Manager; the peer is a tracked child with a private stdin ready/exit handshake and its actual
// exit is awaited. No global process queries, termination, real Arcane, providers or Studio. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const HARNESS = String.raw`using System; using System.Text; using System.Runtime.InteropServices; using Arcane.Installer;
internal static class Harness {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetShortPathNameW(string p, StringBuilder b, uint n);
  private static int Main(string[] a) {
    if (a[0] == "short") { StringBuilder s = new StringBuilder(1024); GetShortPathNameW(a[1], s, 1024); Console.WriteLine("\"" + s.ToString().Replace("\\", "\\\\") + "\""); return 0; }
    string[] paths = null;
    if (a[0] == "inspect") { paths = new string[a.Length - 1]; for (int i = 1; i < a.Length; i++) paths[i - 1] = a[i] == "<null>" ? null : a[i]; }
    ActivityResult r = InstallationActivity.Inspect(paths);
    Console.WriteLine("{\"state\":\"" + r.State + "\",\"code\":" + (r.Code == null ? "null" : "\"" + r.Code + "\"") + ",\"users\":" + r.Users + "}");
    return 0;
  } }`;
const PEER = String.raw`using System; using System.IO;
internal static class Peer { private static int Main(string[] a) {
  FileStream held = a.Length == 2 && a[0] == "hold" ? new FileStream(a[1], FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete) : null;
  Console.WriteLine("ready"); Console.Out.Flush(); Console.In.ReadLine(); if (held != null) held.Dispose(); return 0; } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-activity-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-activity-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  for (const name of ['InstallationActivity.cs', 'SetupPath.cs']) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS); fs.writeFileSync(join(build, 'Peer.cs'), PEER);
  const compile = (out, files) => { const r = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + out, ...files], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, 'csc failed: ' + r.stdout + r.stderr); return out; };
  const harness = compile(join(build, 'harness.exe'), ['InstallationActivity.cs', 'SetupPath.cs', 'Harness.cs'].map(f => join(build, f)));
  const peer = compile(join(build, 'peer.exe'), [join(build, 'Peer.cs')]);
  const install = join(root, 'Owned Install Folder'); fs.mkdirSync(install);
  const image = join(install, 'Arcane.exe'), holder = join(install, 'Uninstall Arcane.exe'), data = join(install, 'Owned Launcher.exe');
  fs.copyFileSync(peer, image); fs.copyFileSync(peer, holder); fs.writeFileSync(data, 'owned file, never executed');
  const call = args => { const r = spawnSync(harness, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 }); assert.equal(r.stderr, ''); return JSON.parse(r.stdout.trim()); };
  const inspect = (...paths) => call(['inspect', ...paths]);
  const start = (exe, args) => new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); let out = '';
    child.on('error', reject); child.stdout.on('data', d => { out += d; if (out.includes('ready')) resolve(child); });
  });
  const stop = child => new Promise(resolve => { child.once('exit', code => resolve(code)); child.stdin.end('exit\n'); });
  shared = { root, install, image, holder, data, call, inspect, start, stop };
  return shared;
}

test('idle, a running mapped image, a held ordinary file and after-exit snapshots report only fixed states and counts', windows, async () => {
  const s = setup();
  assert.deepEqual(s.inspect(s.image), { state: 'Idle', code: null, users: 0 });
  assert.deepEqual(s.inspect(s.image, s.holder, s.data), { state: 'Idle', code: null, users: 0 });
  let child = await s.start(s.image, ['wait']);
  try {
    assert.deepEqual(s.inspect(s.image), { state: 'Busy', code: null, users: 1 }, 'running mapped image');
    assert.deepEqual(s.inspect(s.data), { state: 'Idle', code: null, users: 0 }, 'an owned file the peer never opened');
    assert.deepEqual(s.inspect(s.image, s.data), { state: 'Busy', code: null, users: 1 });
  } finally { assert.equal(await s.stop(child), 0); }
  assert.deepEqual(s.inspect(s.image), { state: 'Idle', code: null, users: 0 }, 'after actual exit');
  child = await s.start(s.holder, ['hold', s.data]);
  try {
    assert.deepEqual(s.inspect(s.data), { state: 'Busy', code: null, users: 1 }, 'ordinary held handle');
    assert.deepEqual(s.inspect(s.image, s.holder, s.data), { state: 'Busy', code: null, users: 1 }, 'one process holding two registered files');
  } finally { assert.equal(await s.stop(child), 0); }
  assert.deepEqual(s.inspect(s.data, s.holder), { state: 'Idle', code: null, users: 0 }, 'after actual exit');
});

test('counts, duplicates and non-canonical, missing, redirected or directory paths are Unknown before any registration', windows, () => {
  const s = setup(), unknown = code => ({ state: 'Unknown', code, users: -1 });
  assert.deepEqual(s.call(['null-array']), unknown('COUNT')); assert.deepEqual(s.inspect(), unknown('COUNT'));
  assert.deepEqual(s.inspect(s.image, s.holder, s.data, s.image), unknown('COUNT'));
  assert.deepEqual(s.inspect(s.image, s.image), unknown('DUPLICATE'));
  assert.deepEqual(s.inspect(s.image, s.image.toUpperCase()), unknown('PATH'), 'a differently spelled path is not canonical');
  for (const path of ['<null>', 'Arcane.exe', join(s.install, 'Missing.exe'), s.install, s.image.replaceAll('\\', '/'), s.image + ':stream', '\\\\server\\share\\Arcane.exe'])
    assert.deepEqual(s.inspect(path), unknown('PATH'), path);
  const junction = join(s.root, 'junction'); fs.symlinkSync(s.install, junction, 'junction');
  assert.deepEqual(s.inspect(join(junction, 'Arcane.exe')), unknown('PATH'), 'redirected ancestor');
  const alias = s.call(['short', s.image]);
  if (alias && alias.toLowerCase() !== s.image.toLowerCase()) assert.deepEqual(s.inspect(alias), unknown('PATH'), '8.3 alias is not the canonical spelling');
});
