import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/UninstallStage.cs with its read-only dependencies via the in-box csc.exe into a SEPARATE owned
// op-script console harness (ready/terminal exit over its own stdio). Roots come from the ACTUAL engine with a labelled SCRIPTED
// verifier; the journaled root uninstaller is placed through the ACTUAL OwnedFiles/SetupOwnership. The staged copy is NEVER
// executed. The temporary parent is an owned folder. UninstallStage.Barrier is used only here for deterministic interleavings.
// No real Arcane, providers, Studio, user folders, registry, Start Menu, process queries or termination. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.IO; using System.Security.Cryptography; using System.Text; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(Dictionary<string, object> v) { Console.WriteLine(Json.Serialize(v)); Console.Out.Flush(); }
  static string Sha(byte[] b) { using (SHA256 s = SHA256.Create()) { StringBuilder x = new StringBuilder(); foreach (byte c in s.ComputeHash(b)) x.Append(c.ToString("x2")); return x.ToString(); } }
  static void Wait(string at) { Dictionary<string, object> w = new Dictionary<string, object>(); w["op"] = "wait"; w["at"] = at; Out(w); Console.In.ReadLine(); }
  static object C(UninstallStageCleanup c) { if (c == null) return null; Dictionary<string, object> v = new Dictionary<string, object>();
    v["complete"] = c.Complete; v["code"] = c.Code; v["file"] = c.File == null ? null : (object)new object[] { c.File.State.ToString(), c.File.Code };
    v["directory"] = new object[] { c.Directory.ToString(), c.DirectoryCode }; return v; }
  static int Main(string[] a) {
    string root = a[0]; InstalledRecordSnapshot record = null; SetupOwnershipSnapshot ownership = null; UninstallStage stage = null; UninstallStagePin pin = null;
    Out(new Dictionary<string, object> { { "op", "ready" } });
    for (int i = 1; i < a.Length; i++) {
      string op = a[i]; Dictionary<string, object> v = new Dictionary<string, object>(); v["op"] = op;
      switch (op) {
        case "journal": {
          InstalledRecordSnapshot r0 = InstalledRecord.Read(root); byte[] u = File.ReadAllBytes(a[++i]);
          OwnedFileResult placed = OwnedFiles.Place(root, SetupOwnership.UninstallerName, u, Sha(u), null);
          v["state"] = SetupOwnership.Save(SetupOwnership.Read(r0).Snapshot, null, placed.Descriptor).State.ToString(); break; }
        case "read": record = InstalledRecord.Read(root); ownership = SetupOwnership.Read(record).Snapshot; v["present"] = ownership.Present; break;
        case "wait": Wait("op"); continue;
        case "barrier": { string at = a[++i]; UninstallStage.Barrier = delegate(string s) { if (s == at) Wait(s); }; continue; }
        case "prepare": case "prepare-from": {
          string parent = a[++i], source = op == "prepare-from" ? a[++i] : root + "\\" + SetupOwnership.UninstallerName;
          UninstallStageResult r = UninstallStage.Prepare(record, ownership, source, parent); stage = r.Stage ?? stage;
          v["state"] = r.State.ToString(); v["code"] = r.Code; v["retained"] = r.RetainedDirectory; v["cleanup"] = C(r.Cleanup);
          if (r.Stage != null) { v["directory"] = r.Stage.Directory; v["executable"] = r.Stage.Executable; v["target"] = r.Stage.TargetRoot; }
          break; }
        case "pin": case "cleanup": if (stage == null) { v["state"] = "NO_STAGE"; break; } if (op == "cleanup") goto case "do-cleanup"; { UninstallStagePinResult r = stage.TryPin(); if (r.Pin != null) pin = r.Pin; v["state"] = r.State.ToString(); v["code"] = r.Code;
          v["live"] = r.Pin != null && r.Pin.Live; if (r.Pin != null) { v["executable"] = r.Pin.Executable; v["target"] = r.Pin.TargetRoot; } break; }
        case "unpin": pin.Dispose(); v["live"] = pin.Live; break;
        case "do-cleanup": { Dictionary<string, object> c = (Dictionary<string, object>)C(stage.Cleanup()); foreach (KeyValuePair<string, object> e in c) v[e.Key] = e.Value; break; }
      }
      Out(v);
    }
    UninstallStage.Barrier = null; if (pin != null) pin.Dispose();
    Out(new Dictionary<string, object> { { "op", "terminal" } });
    return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-uninstall-stage-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-uninstall-stage-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['UninstallStage.cs', 'StageDirectory.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
    ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine writes the record.
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
  const uninstaller = join(build, 'uninstaller.bin'); fs.writeFileSync(uninstaller, randomBytes(4096));
  /** An engine root with a journaled root uninstaller, an owned temp parent holding a sibling file, and an owned profile. */
  const installed = async () => {
    const parentOfRoot = owned('install'), target = join(parentOfRoot, 'Arcane');
    await engine.install({ bundle: bundle('one'), installRoot: target });
    const temp = owned('temp'); fs.writeFileSync(join(temp, 'sibling.txt'), 'sibling');
    const profile = owned('profile'); fs.writeFileSync(join(profile, 'project.txt'), 'user work');
    const [row] = await run(target, ['journal', uninstaller]); assert.equal(row.state, 'Saved');
    return { target, temp, profile };
  };
  const run = (target, ops, actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, ...ops], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let out = '', err = '', chain = Promise.resolve(), actionError, deadlineElapsed = false;
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) { const row = JSON.parse(line); rows.push(row); if (row.op === 'wait') { const action = actions.shift() ?? (() => {}); chain = chain.then(() => action(row)).catch(error => { actionError ??= error; }).then(() => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write('go\n'); }); } }
    });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', error => { actionError ??= error; });
    // Expiry only ends the owned stdin handshake; it never claims the native process has exited.
    const deadline = setTimeout(() => { deadlineElapsed = true; child.stdin.end(); }, 60000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); chain.then(() => {
      child.stdin.destroy();
      if (actionError) reject(actionError);
      else if (deadlineElapsed || err || code !== 0 || rows[0]?.op !== 'ready' || rows.at(-1)?.op !== 'terminal') reject(new Error('harness ' + code + ' ' + err + (deadlineElapsed ? ' observation deadline elapsed' : '')));
      else resolve(rows.filter(r => !['wait', 'ready', 'terminal'].includes(r.op)));
    }); });
  });
  shared = { owned, engine, bundle, installed, run, uninstaller };
  return shared;
}
const exists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
const tree = dir => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isSymbolicLink()) out[relative(dir, p)] = 'link'; else if (e.isDirectory()) { out[relative(dir, p) + sep] = 'dir'; walk(p); } else out[relative(dir, p)] = sha(fs.readFileSync(p)); } }; if (exists(dir)) walk(dir); return out; };
const stages = temp => fs.readdirSync(temp).filter(n => n.startsWith('ArcaneSetup-'));
const by = (rows, op) => rows.filter(r => r.op === op || r.op === op + '-from');
// Sharing denial surfaces as EBUSY or EPERM depending on the operation; either way the change did not happen.
const blocked = fn => { try { fn(); return 'allowed'; } catch (error) { return ['EBUSY', 'EPERM'].includes(error.code) ? 'denied' : error.code; } };
const replace = path => { const bytes = fs.readFileSync(path); fs.unlinkSync(path); fs.writeFileSync(path, bytes); };

test('a verified copy is staged in a fresh container, pinned against mutation, and cleaned once without touching anything else', windows, async () => {
  const s = setup(), f = await s.installed(), source = join(f.target, 'Uninstall Arcane.exe');
  const sourceStat = fs.statSync(source, { bigint: true }), sourceSha = sha(fs.readFileSync(source)), rootBefore = tree(f.target), profile = tree(f.profile);
  let attempts;
  const rows = await s.run(f.target, ['read', 'prepare', f.temp, 'pin', 'cleanup', 'pin', 'wait', 'unpin', 'cleanup', 'cleanup', 'pin'], [({}) => {
    const dir = join(f.temp, stages(f.temp)[0]), copy = join(dir, 'Uninstall Arcane.exe');
    attempts = { write: blocked(() => fs.writeFileSync(copy, 'x')), unlink: blocked(() => fs.unlinkSync(copy)), renameCopy: blocked(() => fs.renameSync(copy, copy + '.moved')),
      renameDir: blocked(() => fs.renameSync(dir, dir + '-moved')) };
  }]);
  const [prepared] = by(rows, 'prepare');
  assert.deepEqual([prepared.state, prepared.code, prepared.retained, prepared.cleanup, prepared.target], ['Prepared', null, null, null, f.target]);
  assert.match(prepared.directory, /\\ArcaneSetup-[0-9a-f]{32}$/); assert.equal(prepared.executable, prepared.directory + '\\Uninstall Arcane.exe');
  assert.equal(prepared.directory.startsWith(f.temp + '\\'), true);
  const [pinned, again] = by(rows, 'pin');
  assert.deepEqual([pinned.state, pinned.code, pinned.live, pinned.executable], ['Pinned', null, true, prepared.executable]);
  assert.deepEqual([again.state, again.code], ['Refused', 'PINNED'], 'one live pin at a time');
  assert.deepEqual(attempts, { write: 'denied', unlink: 'denied', renameCopy: 'denied', renameDir: 'denied' }, 'the live pin denies writing, deleting and renaming the copy and its container');
  const [whilePinned, cleaned, replay] = by(rows, 'cleanup');
  assert.deepEqual([whilePinned.complete, whilePinned.code, whilePinned.file, whilePinned.directory], [false, 'PINNED', null, ['NotReached', null]], 'refused without consuming');
  assert.deepEqual(by(rows, 'unpin')[0].live, false);
  assert.deepEqual([cleaned.complete, cleaned.code, cleaned.file, cleaned.directory], [true, null, ['Deleted', null], ['Deleted', null]]);
  assert.deepEqual([replay.complete, replay.code, replay.file], [false, 'CONSUMED', null], 'exactly one cleanup attempt');
  assert.deepEqual(pick(by(rows, 'pin')[2]), ['Refused', 'CONSUMED']);
  assert.deepEqual(tree(f.temp), { 'sibling.txt': sha('sibling') }, 'only the issued container was removed');
  assert.deepEqual(tree(f.target), rootBefore); assert.deepEqual(tree(f.profile), profile);
  const after = fs.statSync(source, { bigint: true });
  assert.deepEqual([after.ino, after.nlink, sha(fs.readFileSync(source))], [sourceStat.ino, 1n, sourceSha], 'the source is unchanged');
});
const pick = r => [r.state, r.code];

test('the staged copy has the exact bytes, its own identity and a single link', windows, async () => {
  const s = setup(), f = await s.installed(), source = join(f.target, 'Uninstall Arcane.exe');
  let copy;
  await s.run(f.target, ['read', 'prepare', f.temp, 'wait', 'cleanup'], [() => {
    const path = join(f.temp, stages(f.temp)[0], 'Uninstall Arcane.exe'), stat = fs.statSync(path, { bigint: true });
    copy = { sha: sha(fs.readFileSync(path)), ino: stat.ino, nlink: stat.nlink, size: stat.size };
  }]);
  const stat = fs.statSync(source, { bigint: true });
  assert.deepEqual([copy.sha, copy.nlink, copy.size], [sha(fs.readFileSync(s.uninstaller)), 1n, 4096n]);
  assert.notEqual(copy.ino, stat.ino, 'a copy, never a link to the source');
  assert.deepEqual(stages(f.temp), []);
});

test('stale or changed sources, the wrong source path and a non-canonical parent are refused before anything is created', windows, async () => {
  const s = setup();
  const cases = [
    ['record changed', f => s.engine.install({ bundle: s.bundle('two'), installRoot: f.target }), 'SOURCE_CHANGED'],
    ['journal replaced', f => replace(join(f.target, 'setup-ownership.json')), 'SOURCE_CHANGED'],
    ['source bytes changed', f => { const p = join(f.target, 'Uninstall Arcane.exe'), b = fs.readFileSync(p); b[7] ^= 0xff; fs.writeFileSync(p, b); }, 'SOURCE_CHANGED'],
    ['source replaced', f => replace(join(f.target, 'Uninstall Arcane.exe')), 'SOURCE_CHANGED'],
    ['operation running', f => fs.writeFileSync(join(f.target, 'installation.lock'), 'other operation'), 'SOURCE_CHANGED'],
  ];
  for (const [name, mutate, code] of cases) {
    const f = await s.installed(); let before;
    const [r] = await s.run(f.target, ['read', 'wait', 'prepare', f.temp], [async () => { await mutate(f); before = tree(f.target); }]).then(rows => by(rows, 'prepare'));
    assert.deepEqual([r.state, r.code, r.retained, r.cleanup], ['Refused', code, null, null], name);
    assert.deepEqual(stages(f.temp), [], name + ': nothing created'); assert.deepEqual(tree(f.target), before, name);
  }
  const f = await s.installed();
  for (const [name, args, code] of [
    ['launcher path', ['prepare-from', f.temp, f.target + '\\Arcane.exe'], 'SOURCE'],
    ['case variant', ['prepare-from', f.temp, f.target + '\\uninstall arcane.exe'], 'SOURCE'],
    ['trailing separator', ['prepare', f.temp + '\\'], 'PARENT'],
    ['missing parent', ['prepare', join(f.temp, 'missing')], 'PARENT'],
  ]) {
    const [r] = by(await s.run(f.target, ['read', ...args]), 'prepare');
    assert.deepEqual([r.state, r.code, r.retained], ['Refused', code, null], name);
  }
  assert.deepEqual(stages(f.temp), []);
});

test('the newly created container cannot be swapped or removed while staging holds it, and is never adopted', windows, async () => {
  const s = setup(), f = await s.installed(); let attempts, created;
  const rows = await s.run(f.target, ['barrier', 'created', 'read', 'prepare', f.temp, 'cleanup'], [() => {
    [created] = stages(f.temp); const dir = join(f.temp, created);
    assert.deepEqual(fs.readdirSync(dir), [], 'created empty');
    attempts = { rename: blocked(() => fs.renameSync(dir, dir + '-moved')), remove: blocked(() => fs.rmdirSync(dir)) };
  }]);
  assert.deepEqual(attempts, { rename: 'denied', remove: 'denied' }, 'the exclusive creation handle denies delete and rename');
  const [r] = by(rows, 'prepare');
  assert.deepEqual([r.state, r.code, r.directory], ['Prepared', null, join(f.temp, created)], JSON.stringify(r));
  assert.deepEqual(by(rows, 'cleanup')[0].complete, true); assert.deepEqual(stages(f.temp), []);
});

test('a tampered, replaced or hard-linked copy is refused for pinning and kept by cleanup', windows, async () => {
  const s = setup();
  for (const [name, mutate, fileCode] of [
    ['tampered', p => { const b = fs.readFileSync(p); b[11] ^= 0xff; fs.writeFileSync(p, b); }, 'CHANGED'],
    ['replaced', p => replace(p), 'CHANGED'],
    ['hard-linked', p => fs.linkSync(p, p + '.link'), 'LINKED'],
  ]) {
    const f = await s.installed(); let path, before;
    const rows = await s.run(f.target, ['read', 'prepare', f.temp, 'wait', 'pin', 'cleanup'], [() => { path = join(f.temp, stages(f.temp)[0], 'Uninstall Arcane.exe'); mutate(path); before = tree(f.temp); }]);
    assert.deepEqual(pick(by(rows, 'pin')[0]), ['Refused', 'COPY_CHANGED'], name);
    const [c] = by(rows, 'cleanup');
    assert.deepEqual([c.complete, c.file, c.directory], [false, ['Kept', fileCode], ['NotReached', null]], name);
    assert.deepEqual(tree(f.temp), before, name + ': the changed copy and its container stay');
  }
});

test('a stale source after staging refuses the pin; cleanup still removes only the issued copy', windows, async () => {
  const s = setup();
  for (const mutate of [
    f => replace(join(f.target, 'setup-ownership.json')),
    f => { const path = join(f.target, 'Uninstall Arcane.exe'), bytes = fs.readFileSync(path); bytes[7] ^= 0xff; fs.writeFileSync(path, bytes); },
    f => replace(join(f.target, 'Uninstall Arcane.exe')),
  ]) {
    const f = await s.installed();
    const rows = await s.run(f.target, ['read', 'prepare', f.temp, 'wait', 'pin', 'cleanup'], [() => mutate(f)]);
    assert.deepEqual(pick(by(rows, 'pin')[0]), ['Refused', 'SOURCE_CHANGED']);
    assert.deepEqual(by(rows, 'cleanup')[0].complete, true); assert.deepEqual(stages(f.temp), []);
  }
});

test('an unknown child is retained and the copy deletion evidence is kept', windows, async () => {
  const s = setup(), f = await s.installed(); let child;
  const rows = await s.run(f.target, ['read', 'prepare', f.temp, 'wait', 'cleanup', 'cleanup'], [() => { child = join(f.temp, stages(f.temp)[0], 'manual.txt'); fs.writeFileSync(child, 'manual'); }]);
  const [c, replay] = by(rows, 'cleanup');
  assert.deepEqual([c.complete, c.code, c.file, c.directory], [false, 'NOT_EMPTY', ['Deleted', null], ['Kept', 'NOT_EMPTY']]);
  assert.deepEqual(pick({ state: replay.complete, code: replay.code }), [false, 'CONSUMED'], 'no retry');
  assert.equal(fs.readFileSync(child, 'utf8'), 'manual'); assert.equal(exists(join(f.temp, stages(f.temp)[0], 'Uninstall Arcane.exe')), false);
});

test('a source change during staging fails truthfully with its own cleanup evidence, retaining anything unproven', windows, async () => {
  const s = setup();
  let f = await s.installed();
  let [r] = by(await s.run(f.target, ['barrier', 'placed', 'read', 'prepare', f.temp], [() => replace(join(f.target, 'setup-ownership.json'))]), 'prepare');
  assert.deepEqual([r.state, r.code, r.retained, r.cleanup], ['Refused', 'SOURCE_CHANGED', null, { complete: true, code: null, file: ['Deleted', null], directory: ['Deleted', null] }]);
  assert.deepEqual(stages(f.temp), []);
  f = await s.installed(); let dir;
  [r] = by(await s.run(f.target, ['barrier', 'placed', 'read', 'prepare', f.temp], [() => {
    dir = join(f.temp, stages(f.temp)[0]); fs.writeFileSync(join(dir, 'manual.txt'), 'manual'); replace(join(f.target, 'setup-ownership.json'));
  }]), 'prepare');
  assert.deepEqual([r.state, r.code, r.retained, r.cleanup], ['Unknown', 'SOURCE_CHANGED', dir, { complete: false, code: 'NOT_EMPTY', file: ['Deleted', null], directory: ['Kept', 'NOT_EMPTY'] }]);
  assert.deepEqual(fs.readdirSync(dir), ['manual.txt'], 'the unknown child is retained; only the issued copy was removed');
});
