import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/OperationLease.cs + InstalledRecord.cs + PayloadArchive.cs (and Launcher.cs, test-only, for
// the launcher refusal) with the in-box csc.exe into a SEPARATE owned op-script harness that holds one lease across steps
// while this test acts from outside at private "wait" acknowledgements. Roots come from the ACTUAL engine with a labelled
// SCRIPTED verifier. Every harness process is a tracked child whose actual exit is awaited; nothing is killed, launched
// (the launcher refuses before any start) or queried globally. No user folders, registry or Start Menu. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = text => createHash('sha256').update(text).digest('hex');
const HARNESS = String.raw`using System; using System.Collections.Generic; using Arcane.Installer;
internal static class Harness {
  static void Out(string op, string state, string code) { Console.WriteLine("{\"op\":\"" + op + "\",\"state\":" + (state == null ? "null" : "\"" + state + "\"") + ",\"code\":" + (code == null ? "null" : "\"" + code + "\"") + "}"); Console.Out.Flush(); }
  static string Try(Func<string> body) { try { return body(); } catch (InstalledRecordException e) { return "throw:" + e.Code; } }
  static int Main(string[] a) {
    string root = a[0]; InstalledRecordSnapshot snapshot = null; OperationLease lease = null, other = null;
    for (int i = 1; i < a.Length; i++) {
      string op = a[i];
      switch (op) {
        case "snapshot": Out(op, Try(delegate { snapshot = InstalledRecord.Read(root); return "ok"; }), null); break;
        case "read": Out(op, Try(delegate { InstalledRecord.Read(root); return "ok"; }), null); break;
        case "read-lease": Out(op, Try(delegate { InstalledRecordSnapshot s = InstalledRecord.Read(root, lease); return s.RecordSha256 == snapshot.RecordSha256 ? "ok" : "different"; }), null); break;
        case "read-other": Out(op, Try(delegate { InstalledRecord.Read(root, other); return "ok"; }), null); break;
        case "current": Out(op, InstalledRecord.StillCurrent(snapshot) ? "true" : "false", null); break;
        case "current-lease": Out(op, InstalledRecord.StillCurrent(snapshot, lease) ? "true" : "false", null); break;
        case "current-other": Out(op, InstalledRecord.StillCurrent(snapshot, other) ? "true" : "false", null); break;
        case "acquire": { LeaseResult r = OperationLease.Acquire(snapshot); if (r.Lease != null) lease = r.Lease; Out(op, r.State.ToString(), r.Code); break; }
        case "acquire-again": { LeaseResult r = OperationLease.Acquire(snapshot); Out(op, r.State.ToString(), r.Code); break; }
        case "acquire-other": { LeaseResult r = OperationLease.Acquire(InstalledRecord.Read(a[++i])); other = r.Lease; Out(op, r.State.ToString(), r.Code); break; }
        case "launch": { LaunchOutcome o = InstalledLauncher.Launch(root); Out(op, o.Started ? "started" : "refused", o.Code); break; }
        case "release": { LeaseRelease r = lease.Release(); Out(op, r.State.ToString(), r.Code); break; }
        case "release-other": { LeaseRelease r = other.Release(); Out(op, r.State.ToString(), r.Code); break; }
        case "dispose": lease.Dispose(); Out(op, lease.Retained ? "retained" : "not-retained", null); break;
        case "live": Out(op, lease.Live ? "live" : "ended", null); break;
        case "wait": Out(op, null, null); Console.In.ReadLine(); break;
      }
    }
    return 0; // exits WITHOUT releasing whatever lease is still live (handles close with the process)
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-lease-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-lease-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['OperationLease.cs', 'InstalledRecord.cs', 'PayloadArchive.cs', 'Launcher.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness, '/reference:System.Web.Extensions.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.Windows.Forms.dll', ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine writes and locks the installation.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = tag => {
    const dir = owned('bundle'); fs.mkdirSync(join(dir, 'resources', 'node'), { recursive: true }); const files = [];
    for (const [path, text] of [['Arcane.exe', 'fixture app ' + tag], ['resources/node/node.exe', 'fixture node']]) { fs.writeFileSync(join(dir, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) }); }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: 2, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  const installed = async () => { const target = join(owned('install'), 'Arcane'); await engine.install({ bundle: bundle('one'), installRoot: target }); return target; };
  /** Runs an op script; at each "wait" the next (sync or async) action runs, then the harness continues. Resolves after actual exit. */
  const run = (target, ops, actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, ...ops], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let out = '', err = '', chain = Promise.resolve();
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) { const row = JSON.parse(line); rows.push(row); if (row.op === 'wait') { const action = actions.shift() ?? (() => {}); chain = chain.then(action).then(() => child.stdin.write('go\n'), reject); } }
    });
    child.stderr.on('data', d => { err += d; });
    child.once('error', reject);
    child.once('close', code => chain.then(() => { child.stdin.destroy(); if (err || code !== 0) reject(new Error('harness ' + code + ' ' + err)); else resolve(rows.filter(r => r.op !== 'wait')); }));
  });
  shared = { owned, engine, bundle, installed, run };
  return shared;
}
const pick = (rows, op) => rows.filter(r => r.op === op).map(r => [r.state, r.code]);
const lockOf = target => join(target, 'installation.lock');

test('an acquired lease binds the authorized record; ordinary readers, the launcher and the actual engine refuse while it is held', windows, async () => {
  const s = setup(), target = await s.installed(), recordBefore = fs.readFileSync(join(target, 'installation.json'));
  let engineError, lockText, blocked = [];
  const rows = await s.run(target, ['snapshot', 'acquire', 'read', 'read-lease', 'current', 'current-lease', 'launch', 'acquire-again', 'wait', 'live', 'release', 'live', 'read'], [async () => {
    lockText = fs.readFileSync(lockOf(target), 'utf8');
    for (const act of [() => fs.writeFileSync(lockOf(target), 'x'), () => fs.unlinkSync(lockOf(target)), () => fs.renameSync(lockOf(target), lockOf(target) + '.moved'), () => fs.renameSync(target, target + '-moved')]) {
      try { act(); blocked.push('allowed'); } catch (error) { blocked.push(error.code); }
    }
    try { await s.engine.install({ bundle: s.bundle('two'), installRoot: target }); engineError = 'installed'; } catch (error) { engineError = error.code; }
  }]);
  assert.deepEqual(pick(rows, 'acquire'), [['Acquired', null]]);
  assert.deepEqual(pick(rows, 'read'), [['throw:LOCKED', null], ['ok', null]], 'ordinary read refuses during the lease and works after release');
  assert.deepEqual([pick(rows, 'read-lease'), pick(rows, 'current'), pick(rows, 'current-lease')], [[['ok', null]], [['false', null]], [['true', null]]]);
  assert.deepEqual(pick(rows, 'launch'), [['refused', 'LOCKED']]);
  assert.deepEqual(pick(rows, 'acquire-again'), [['Refused', 'LOCKED']], 'no second lease');
  assert.deepEqual(pick(rows, 'live'), [['live', null], ['ended', null]]); assert.deepEqual(pick(rows, 'release'), [['Released', null]]);
  assert.ok(blocked.every(code => ['EBUSY', 'EPERM', 'EACCES'].includes(code)), 'lock overwrite/delete/rename and root rename are blocked: ' + blocked.join(','));
  assert.equal(engineError, 'LOCKED', 'the actual engine refuses with its typed LOCKED');
  assert.deepEqual(fs.readFileSync(join(target, 'installation.json')), recordBefore, 'the record was never rewritten');
  const lease = JSON.parse(lockText);
  assert.deepEqual(Object.keys(lease), ['schemaVersion', 'kind', 'operation', 'installationId', 'recordSha256']);
  assert.deepEqual([lease.kind, lease.recordSha256, lease.installationId], ['arcane-operation-lease', sha(recordBefore), JSON.parse(recordBefore).installationId]);
  assert.match(lease.operation, /^[0-9a-f]{32}$/); assert.ok(lockText.endsWith('}\n'));
  assert.equal(fs.existsSync(lockOf(target)), false, 'released through its own handle');
  await s.engine.install({ bundle: s.bundle('three'), installRoot: target });
  assert.notDeepEqual(fs.readFileSync(join(target, 'installation.json')), recordBefore, 'the engine works again after release');
});

test('foreign locks, other or ended capabilities and record or root changes are refused; nothing is taken over', windows, async () => {
  const s = setup();
  // A pre-existing foreign lock is never adopted.
  let target = await s.installed();
  let rows = await s.run(target, ['snapshot', 'wait', 'acquire', 'read'], [() => fs.writeFileSync(lockOf(target), 'someone else')]);
  assert.deepEqual([pick(rows, 'snapshot'), pick(rows, 'acquire'), pick(rows, 'read')], [[['ok', null]], [['Refused', 'LOCKED']], [['throw:LOCKED', null]]],
    'a foreign lock appearing after authorization refuses the lease');
  assert.equal(fs.readFileSync(lockOf(target), 'utf8'), 'someone else', 'the foreign lock is untouched'); fs.unlinkSync(lockOf(target));
  // A lease for another root, a released lease and a disposed lease are all refused as capabilities.
  target = await s.installed(); const second = await s.installed();
  rows = await s.run(target, ['snapshot', 'acquire', 'acquire-other', second, 'read-other', 'current-other', 'release-other', 'release', 'read-lease', 'current-lease', 'release']);
  assert.deepEqual(pick(rows, 'acquire-other'), [['Acquired', null]]);
  assert.deepEqual([pick(rows, 'read-other'), pick(rows, 'current-other')], [[['throw:LEASE', null]], [['false', null]]], 'another root\'s lease grants nothing here');
  assert.deepEqual([pick(rows, 'read-lease'), pick(rows, 'current-lease')], [[['throw:LEASE', null]], [['false', null]]], 'a released lease grants nothing');
  assert.deepEqual(pick(rows, 'release'), [['Released', null], ['Kept', 'CONSUMED']]);
  target = await s.installed();
  rows = await s.run(target, ['snapshot', 'acquire', 'dispose', 'read-lease', 'release']);
  assert.deepEqual([pick(rows, 'dispose'), pick(rows, 'read-lease'), pick(rows, 'release')], [[['retained', null]], [['throw:LEASE', null]], [['Kept', 'DISPOSED']]]);
  assert.equal(fs.existsSync(lockOf(target)), true, 'dispose retains the unreleased lock'); fs.unlinkSync(lockOf(target));
  // A record replaced (same bytes, new identity) during the lease is fenced.
  target = await s.installed();
  rows = await s.run(target, ['snapshot', 'acquire', 'wait', 'read-lease', 'current-lease', 'release'], [() => {
    const p = join(target, 'installation.json'), bytes = fs.readFileSync(p); fs.renameSync(p, p + '.old'); fs.writeFileSync(p, bytes); }]);
  assert.deepEqual([pick(rows, 'read-lease'), pick(rows, 'current-lease'), pick(rows, 'release')], [[['throw:LEASE', null]], [['false', null]], [['Released', null]]]);
  // A record changed between authorization and acquisition: no lease is issued and no lock is left.
  target = await s.installed();
  rows = await s.run(target, ['snapshot', 'wait', 'acquire'], [async () => { await s.engine.install({ bundle: s.bundle('changed'), installRoot: target }); }]);
  assert.deepEqual(pick(rows, 'acquire'), [['Refused', 'RECORD_CHANGED']]); assert.equal(fs.existsSync(lockOf(target)), false);
});

test('a holder that exits without releasing leaves a stale lock that blocks the engine and is never taken over', windows, async () => {
  const s = setup(), target = await s.installed();
  let holder;
  // A second process authorizes first; while it waits, the holder acquires and exits without releasing.
  const after = await s.run(target, ['snapshot', 'wait', 'acquire', 'read'], [async () => {
    holder = await s.run(target, ['snapshot', 'acquire']); // the holder harness exits here without releasing
  }]);
  assert.deepEqual(pick(holder, 'acquire'), [['Acquired', null]]);
  assert.equal(fs.existsSync(lockOf(target)), true, 'the unreleased lock survives its holder');
  assert.deepEqual([pick(after, 'snapshot'), pick(after, 'acquire'), pick(after, 'read')], [[['ok', null]], [['Refused', 'LOCKED']], [['throw:LOCKED', null]]],
    'no new lease over a stale lock, even with a valid prior authorization');
  let engineError; try { await s.engine.install({ bundle: s.bundle('blocked'), installRoot: target }); } catch (error) { engineError = error.code; }
  assert.equal(engineError, 'LOCKED');
  assert.equal(JSON.parse(fs.readFileSync(lockOf(target), 'utf8')).kind, 'arcane-operation-lease', 'the stale lock is retained, not adopted');
});
