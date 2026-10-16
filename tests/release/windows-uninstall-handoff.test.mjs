import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Actual staged process handoff between tiny owned executables, not Arcane or an installed provider.
// The observer opens only the exact child PID+creation time returned by our own ready protocol; no enumeration.
// Component cases exercise waiting only; host cases run actual entrypoint removal with SCRIPTED native consent
// on owned temporary installations. A fixture-only delete probe confirms the original image is no longer mapped.
const HARNESS = String.raw`using System; using System.Diagnostics; using System.Drawing; using System.IO; using System.Security.Cryptography; using System.Text; using System.Threading; using System.Windows.Forms; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h,int i);
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h,int i,IntPtr v);
  static JavaScriptSerializer json=new JavaScriptSerializer();
  static string Sha(byte[] b) { using(SHA256 h=SHA256.Create()) { StringBuilder s=new StringBuilder(); foreach(byte c in h.ComputeHash(b))s.Append(c.ToString("x2"));return s.ToString(); } }
  static void Out(object o) { Console.WriteLine(json.Serialize(o)); Console.Out.Flush(); }
  static ulong Birth(Process p) { ulong t; if(!UninstallHandoff.Creation(p.Handle,out t))throw new Exception("Owned process identity unavailable.");return t; }
  [STAThread] static int Main(string[] a) {
    if(a[0]=="host-parent")return UninstallEntry.Run(new string[0]);
    if(a[0]=="prepare") {
      var record=InstalledRecord.Read(a[1]);byte[] bytes=File.ReadAllBytes(typeof(Harness).Assembly.Location);
      var file=OwnedFiles.Place(a[1],SetupOwnership.UninstallerName,bytes,Sha(bytes),null);
      var journal=SetupOwnership.Save(SetupOwnership.Read(record).Snapshot,null,file.Descriptor);
      Out(new { state=journal.State.ToString() });return 0;
    }
    if(a[0]=="parent") {
      var record=InstalledRecord.Read(a[1]);var journal=SetupOwnership.Read(record).Snapshot;
      var stage=UninstallStage.Prepare(record,journal,a[1]+"\\"+SetupOwnership.UninstallerName,a[2]);
      if(stage.Stage==null)throw new Exception("Fixture stage "+stage.Code);
      var result=UninstallHandoff.Start(stage.Stage);var replay=UninstallHandoff.Start(stage.Stage);
      Out(new { state=result.State.ToString(),code=result.Code,id=result.ChildId,stage=result.RetainedStage,replay=replay.Code });
      Console.In.ReadLine();return 0;
    }
    if(a[0]=="observe") {
      // Only a private ready-acknowledged fixture child, kept alive by its own parent wait.
      using(Process p=Process.GetProcessById(int.Parse(a[1]))) {
        if(Birth(p).ToString("x16")!=a[2])throw new Exception("Owned child identity changed.");
        Out(new { ready=true });if(!p.WaitForExit(15000))throw new Exception("Owned child did not terminate.");
        Out(new { terminal=true,exitCode=p.ExitCode });return 0;
      }
    }
    if(a[0]=="invalid") { Out(new { accepted=UninstallParent.Read(new string[]{"--confirmed"})!=null });return 0; }
    if(a[0]=="foreign-handle") {
      string path=Path.Combine(a[1],"owned-handle.txt");File.WriteAllText(path,"owned file");
      using(FileStream file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        string[] hint={"--staged-root",a[1],"--parent-handle",file.SafeFileHandle.DangerousGetHandle().ToInt64().ToString("x16"),"--parent-id","4294967295","--parent-created","0000000000000001"};
        using(UninstallParent parent=UninstallParent.Read(hint)) {
          FileIdentity identity;FileAttributes attributes;uint links;long size;
          Out(new { accepted=parent!=null,originalValid=NativeFile.Describe(file.SafeFileHandle,out identity,out attributes,out links,out size) });
        }
      }return 0;
    }
    if(a[0]=="--staged-root" && File.ReadAllText(Path.Combine(Path.GetDirectoryName(a[1]),"fixture-timeout.txt")).StartsWith("host")) {
      string folder=Path.GetDirectoryName(a[1]), mode=File.ReadAllText(Path.Combine(folder,"fixture-timeout.txt"));
      using(Process self=Process.GetCurrentProcess())File.WriteAllText(Path.Combine(folder,"child-ready.json"),json.Serialize(new { id=self.Id,created=Birth(self).ToString("x16"),image=typeof(Harness).Assembly.Location }));
      DateTime until=DateTime.UtcNow.AddSeconds(10);while(!File.Exists(Path.Combine(folder,"proceed"))) { if(DateTime.UtcNow>until)return 4;Thread.Sleep(10); }
      int prompts=0;string outcome=null;
      UninstallConsent.Observe=delegate(Form f,string phase) {
        if(phase=="load") { f.Opacity=0;f.Location=new Point(-32000,-32000);long ex=GetWindowLongPtr(f.Handle,-20).ToInt64();SetWindowLongPtr(f.Handle,-20,new IntPtr((ex & ~0x00040000L)|0x00000080L));return; }
        prompts++;f.BeginInvoke(new Action(delegate { ((Button)f.Controls.Find(mode=="host-cancel"?"cancel":"uninstall",false)[0]).PerformClick(); }));
      };
      UninstallForm.Observe=delegate(UninstallForm f) { f.Opacity=0;f.Location=new Point(-32000,-32000);long ex=GetWindowLongPtr(f.Handle,-20).ToInt64();SetWindowLongPtr(f.Handle,-20,new IntPtr((ex & ~0x00040000L)|0x00000080L)); };
      Application.Idle+=delegate {
        foreach(Form open in Application.OpenForms) { UninstallForm progress=open as UninstallForm;if(progress==null)continue;
          if(progress.Result!=null) { outcome=progress.Result.State.ToString();progress.Close();return; } }
      };
      int code=UninstallEntry.Run(a);
      File.WriteAllText(Path.Combine(folder,"child-terminal.json"),json.Serialize(new { code=code,prompts=prompts,outcome=outcome }));return code;
    }
    using(UninstallParent parent=UninstallParent.Read(a)) {
      if(parent==null)return 3;
      string fixture=Path.GetDirectoryName(parent.TargetRoot), ready=Path.Combine(fixture,"child-ready.json"), terminal=Path.Combine(fixture,"child-terminal.json");
      int timeout=int.Parse(File.ReadAllText(Path.Combine(fixture,"fixture-timeout.txt")));
      using(Process self=Process.GetCurrentProcess())File.WriteAllText(ready,json.Serialize(new { id=self.Id,created=Birth(self).ToString("x16") }));
      var waited=parent.Wait(timeout);var replay=parent.Wait(timeout);bool unmapped=false;
      if(waited.State==ParentExitState.Exited) { File.Delete(parent.TargetRoot+"\\"+SetupOwnership.UninstallerName);unmapped=true; } // OWNED fixture image only; not product behaviour.
      File.WriteAllText(terminal,json.Serialize(new { state=waited.State.ToString(),code=waited.Code,replay=replay.Code,unmapped=unmapped }));
      return 0;
    }
  }
}`;
const windows = { skip: process.platform !== 'win32' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), owner = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-uninstall-handoff-test-')));
  process.on('exit', () => { const p = relative(boundary, owner); if (p.startsWith('arcane-uninstall-handoff-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(owner, { recursive: true, force: true }); });
  const sources = ['UninstallEntry.cs', 'UninstallHandoff.cs', 'UninstallStage.cs', 'UninstallForm.cs', 'UninstallTransaction.cs', 'UninstallConsent.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'StageDirectory.cs', 'OwnedFiles.cs', 'SetupOwnership.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'PayloadArchive.cs'];
  const build = join(owner, 'build'); fs.mkdirSync(build);
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const exe = join(build, 'fixture.exe'), csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + exe, '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', ...[...sources, 'Harness.cs'].map(name => join(build, name))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const bundle = join(owner, 'bundle'); fs.mkdirSync(join(bundle, 'resources', 'node'), { recursive: true }); const bytes = Buffer.from('owned handoff fixture');
  const files = ['Arcane.exe', 'resources/node/node.exe'].map(path => ({ path, bytes: bytes.length, sha256: sha(bytes) }));
  for (const f of files) fs.writeFileSync(join(bundle, f.path), bytes);
  fs.writeFileSync(join(bundle, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: files.length, totalBytes: bytes.length * files.length, files }));
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    for (const f of files) assert.equal(sha(fs.readFileSync(join(directory, f.path))), f.sha256);
    return { manifestSha256: sha(fs.readFileSync(join(directory, 'windows-manifest.json'))), files: files.length, bytes: bytes.length * files.length };
  } }); // Scripted verifier, actual installation engine.
  const command = (file, args) => {
    const process = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let pending = '', err = '', rows = [], next = [];
    process.stdout.on('data', chunk => { pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) { const row = JSON.parse(line); if (next.length) next.shift()(row); else rows.push(row); } });
    process.stderr.on('data', chunk => { err += chunk; });
    const terminal = new Promise((resolve, reject) => { process.once('error', reject); process.once('close', code => { if (code || err) reject(new Error('owned fixture ' + code + ': ' + err)); else resolve(); }); });
    return { process, terminal, row: () => rows.length ? Promise.resolve(rows.shift()) : new Promise(resolve => next.push(resolve)) };
  };
  const jsonFile = async file => {
    const until = Date.now() + 10000;
    while (Date.now() < until) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (!['ENOENT'].includes(e.code) && !(e instanceof SyntaxError)) throw e; await new Promise(resolve => setTimeout(resolve, 10)); } }
    throw new Error('Owned fixture ready acknowledgement missing: ' + file);
  };
  shared = { owner, exe, engine, bundle, command, jsonFile }; return shared;
}

for (const mode of ['exit', 'timeout']) test('native staged handoff waits for parent: ' + mode, windows, async () => {
  const s = setup(), folder = join(s.owner, mode); fs.mkdirSync(folder); const root = join(folder, 'Arcane'), temp = join(folder, 'temp'); fs.mkdirSync(temp);
  fs.writeFileSync(join(folder, 'fixture-timeout.txt'), mode === 'exit' ? '10000' : '3000');
  await s.engine.install({ bundle: s.bundle, installRoot: root });
  let prep = s.command(s.exe, ['prepare', root]); assert.equal((await prep.row()).state, 'Saved'); await prep.terminal;
  const executable = join(root, 'Uninstall Arcane.exe'), before = fs.readFileSync(executable);
  const parent = s.command(executable, ['parent', root, temp]); let observer;
  try {
    const start = await parent.row(); assert.deepEqual([start.state, start.code, start.replay], ['Started', null, 'CONSUMED']);
    const ready = await s.jsonFile(join(folder, 'child-ready.json')); assert.equal(ready.id, start.id);
    observer = s.command(s.exe, ['observe', String(ready.id), ready.created]); assert.equal((await observer.row()).ready, true);
    assert.equal(fs.existsSync(join(folder, 'child-terminal.json')), false, 'child has not claimed parent exit');
    if (mode === 'exit') parent.process.stdin.end('exit\n');
    await observer.terminal; const result = await s.jsonFile(join(folder, 'child-terminal.json'));
    assert.deepEqual([result.state, result.code, result.replay, result.unmapped], mode === 'exit' ? ['Exited', null, 'CONSUMED', true] : ['TimedOut', 'TIMEOUT', 'CONSUMED', false]);
    if (mode === 'timeout') assert.deepEqual(fs.readFileSync(executable), before, 'live parent image remains untouched');
    assert.equal(fs.existsSync(join(root, 'installation.json')), true); assert.equal(fs.existsSync(join(root, 'setup-ownership.json')), true);
    assert.equal(fs.existsSync(join(root, 'installation.lock')), false, 'handoff acquired no uninstall permission or lease');
    assert.equal(fs.existsSync(join(start.stage, 'Uninstall Arcane.exe')), true, 'the mapped staged image is retained explicitly');
  } finally { if (!parent.process.stdin.destroyed) parent.process.stdin.end('exit\n'); await parent.terminal; if (observer) await observer.terminal; }
});

test('handoff parser does not accept confirmation flags', windows, async () => {
  const s = setup(), p = s.command(s.exe, ['invalid']); assert.equal((await p.row()).accepted, false); await p.terminal;
});

test('a rejected command-line handle never closes an existing owned handle', windows, async () => {
  const s = setup(), root = join(s.owner, 'parser-root'); fs.mkdirSync(root);
  const p = s.command(s.exe, ['foreign-handle', root]);
  assert.deepEqual(await p.row(), { accepted: false, originalValid: true }); await p.terminal;
});

for (const mode of ['host', 'host-cancel']) test('actual installed entrypoint and staged native window: ' + mode, windows, async () => {
  const s = setup(), folder = join(s.owner, mode); fs.mkdirSync(folder); const root = join(folder, 'Arcane');
  fs.writeFileSync(join(folder, 'fixture-timeout.txt'), mode);
  await s.engine.install({ bundle: s.bundle, installRoot: root });
  const prep = s.command(s.exe, ['prepare', root]); assert.equal((await prep.row()).state, 'Saved'); await prep.terminal;
  const before = fs.readFileSync(join(root, 'installation.json')), original = fs.readFileSync(join(root, 'Uninstall Arcane.exe'));
  const parent = s.command(join(root, 'Uninstall Arcane.exe'), ['host-parent']); let observer, ready, imageIdentity, directoryIdentity;
  try {
    ready = await s.jsonFile(join(folder, 'child-ready.json'));
    const boundary = fs.realpathSync.native(tmpdir()), stageDirectory = join(ready.image, '..');
    const stageName = relative(boundary, stageDirectory);
    assert.match(stageName, /^ArcaneSetup-[0-9a-f]{32}$/); assert.equal(fs.realpathSync.native(ready.image), ready.image);
    assert.equal(sha(fs.readFileSync(ready.image)), sha(original));
    imageIdentity = fs.lstatSync(ready.image, { bigint: true }); directoryIdentity = fs.lstatSync(stageDirectory, { bigint: true });
    observer = s.command(s.exe, ['observe', String(ready.id), ready.created]); assert.equal((await observer.row()).ready, true);
    fs.writeFileSync(join(folder, 'proceed'), 'continue owned fixture');
    await observer.terminal; const exited = await observer.row(); assert.equal(exited.exitCode, 0);
    const result = await s.jsonFile(join(folder, 'child-terminal.json'));
    assert.deepEqual([result.code, result.prompts, result.outcome], mode === 'host' ? [0, 1, 'Removed'] : [0, 1, null], 'the actual host always asks once');
    if (mode === 'host') assert.equal(fs.existsSync(root), false, 'actual consent-bound transaction removed the owned installation');
    else { assert.deepEqual(fs.readFileSync(join(root, 'installation.json')), before); assert.deepEqual(fs.readFileSync(join(root, 'Uninstall Arcane.exe')), original); }
    assert.equal(fs.existsSync(join(root, 'installation.lock')), false);
    assert.equal(fs.existsSync(ready.image), true, 'the running staged image was retained, not claimed deleted');
  } finally {
    fs.writeFileSync(join(folder, 'proceed'), 'finish owned fixture'); await parent.terminal; if (observer) await observer.terminal;
    // Exact known fixture copy only, after its actual exit. No recursive or inferred directory cleanup.
    if (ready && imageIdentity && directoryIdentity) {
      const current = fs.lstatSync(ready.image, { bigint: true }), directory = join(ready.image, '..'), container = fs.lstatSync(directory, { bigint: true });
      assert.equal(current.ino, imageIdentity.ino); assert.equal(current.dev, imageIdentity.dev); assert.equal(current.nlink, 1n); assert.equal(current.isSymbolicLink(), false);
      assert.equal(container.ino, directoryIdentity.ino); assert.equal(container.dev, directoryIdentity.dev); assert.equal(sha(fs.readFileSync(ready.image)), sha(original));
      fs.unlinkSync(ready.image); fs.rmdirSync(directory);
    }
  }
});
