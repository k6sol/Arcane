import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';

// Compiles the ACTUAL installer sources via the in-box csc.exe into a SEPARATE owned console harness that calls the actual
// PRIVATE directory-pin helpers through reflection (OwnedFiles.PinRoot, StageDirectory+Session.Pin, ReleaseRemoval.Pin) on
// owned EMPTY temp directories. Nothing is open inside the pinned directory, so no child handle can protect it incidentally:
// only the pin's own access mask and deny-delete share mode can. This node process, a separate process, then tries to rename
// and remove the directory while the pin is held and after it is released. Owned temp only; Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.Reflection; using Microsoft.Win32.SafeHandles; using Arcane.Installer;
internal static class Harness {
  const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Static;
  static void Out(string op, bool value) { Console.WriteLine("{\"op\":\"" + op + "\",\"value\":" + (value ? "true" : "false") + "}"); Console.Out.Flush(); }
  static int Main(string[] a) {
    string kind = a[0], dir = a[1]; SafeFileHandle pin = null;
    FileIdentity identity = NativeFile.DirectoryIdentity(dir);
    if (kind == "owned") { object[] args = { dir, null }; pin = (SafeFileHandle)typeof(OwnedFiles).GetMethod("PinRoot", Private).Invoke(null, args); }
    else if (kind == "stage") pin = (SafeFileHandle)typeof(StageDirectory).GetNestedType("Session", BindingFlags.NonPublic).GetMethod("Pin", Private).Invoke(null, new object[] { dir, identity });
    else if (kind == "release") {
      Dictionary<string, SafeFileHandle> pins = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
      bool ok = (bool)typeof(ReleaseRemoval).GetMethod("Pin", Private).Invoke(null, new object[] { pins, dir, identity, false });
      if (ok) pin = pins[dir];
    }
    Out("pinned", pin != null && !pin.IsInvalid); Console.In.ReadLine();
    if (pin != null) pin.Dispose();
    Out("released", true); Console.In.ReadLine();
    return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-directory-pins-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-directory-pins-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['OwnedFiles.cs', 'StageDirectory.cs', 'ReleaseRemoval.cs', 'InstalledRecord.cs', 'PayloadArchive.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'OperationLease.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
    ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = () => { const dir = join(root, 'pinned-' + ++count); fs.mkdirSync(dir); return dir; };
  /** Runs the harness; at each step calls observe() from this separate process, then lets the harness continue. */
  const run = (kind, dir, observe) => new Promise((resolve, reject) => {
    const child = spawn(harness, [kind, dir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let out = '', err = '';
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) { const row = JSON.parse(line); row.observed = observe(row); rows.push(row); child.stdin.write('go\n'); }
    });
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => (code === 0 && !err && rows.length === 2) ? resolve(rows) : reject(new Error('harness ' + code + ' ' + err)));
  });
  shared = { owned, run };
  return shared;
}
/** Attempts from this separate process; a successful change is undone at once so the directory stays in place. */
const attempt = dir => {
  const result = {};
  try { fs.renameSync(dir, dir + '-moved'); fs.renameSync(dir + '-moved', dir); result.rename = 'allowed'; } catch (error) { result.rename = error.code; }
  try { fs.rmdirSync(dir); fs.mkdirSync(dir); result.remove = 'allowed'; } catch (error) { result.remove = error.code; }
  return result;
};

for (const [kind, label] of [['owned', 'OwnedFiles.PinRoot'], ['stage', 'StageDirectory.Session.Pin'], ['release', 'ReleaseRemoval.Pin (non-deletable)']]) {
  test(label + ' itself denies rename and removal of the pinned directory until it is released', windows, async () => {
    const s = setup(), dir = s.owned();
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing inside could protect the directory incidentally');
    const [held, released] = await s.run(kind, dir, () => attempt(dir));
    assert.equal(held.value, true, 'the actual helper issued a pin');
    assert.deepEqual(held.observed, { rename: 'EBUSY', remove: 'EBUSY' }, 'denied by the pin while held');
    assert.deepEqual(released.observed, { rename: 'allowed', remove: 'allowed' }, 'permitted once released');
  });
}
