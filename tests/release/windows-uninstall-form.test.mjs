import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Actual native progress window and transaction, in a hidden owned STA fixture. Consent uses its accepted
// scripted modal handler, not physical input. Cancellation closes the real form while an acknowledged
// fixture barrier holds the worker; the window must wait for the worker's actual terminal result.
const HARNESS = String.raw`using System; using System.Drawing; using System.IO; using System.Reflection; using System.Threading; using System.Windows.Forms; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  static void Hide(Form f) { f.Opacity=0; f.Location=new Point(-32000,-32000); long ex=GetWindowLongPtr(f.Handle,-20).ToInt64(); SetWindowLongPtr(f.Handle,-20,new IntPtr((ex & ~0x00040000L)|0x00000080L)); }
  [STAThread] static int Main(string[] args) {
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException); int errors=0; Application.ThreadException+=delegate { errors++; };
    InstalledRecordSnapshot record=InstalledRecord.Read(args[0]); string mode=args[1];
    UninstallConsent.Observe=delegate(Form f,string stage) { if(stage=="load") { Hide(f); return; } f.BeginInvoke(new Action(delegate { ((Button)f.Controls.Find("uninstall",false)[0]).PerformClick(); })); };
    ConsentResult decision=UninstallConsent.Ask(null,record); UninstallConsent.Observe=null;
    if(decision.Authorization==null) throw new Exception("Fixture consent unavailable: "+decision.State+" "+decision.Code);
    bool cancelSent=false, heldOpen=false, staleUnchanged=true, terminal=false, expired=false;
    using(ManualResetEvent entered=new ManualResetEvent(false)) using(ManualResetEvent proceed=new ManualResetEvent(false)) {
      if(mode=="cancel") ReleaseRemoval.Barrier=delegate(string stage) { if(stage=="before-files") { entered.Set(); if(!proceed.WaitOne(15000)) throw new IOException("Fixture barrier deadline."); } };
      using(UninstallForm form=new UninstallForm(record,mode=="missing"?null:decision.Authorization)) using(System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer()) {
        Hide(form); DateTime until=DateTime.UtcNow.AddSeconds(30); string title=null, detail=null;
        timer.Interval=10;
        timer.Tick+=delegate {
          if(DateTime.UtcNow>until) { expired=true; proceed.Set(); form.Close(); }
          if(mode=="cancel" && entered.WaitOne(0) && !cancelSent) { cancelSent=true; form.Close(); heldOpen=!form.IsDisposed && form.Visible; proceed.Set(); }
          if(form.Result==null && !form.Failed) return;
          terminal=true; timer.Stop(); title=form.Controls.Find("status",false)[0].Text; detail=form.Controls.Find("detail",false)[0].Text;
          // A report from an ended operation must not overwrite its terminal message.
          Exception reportError=null; Thread reporter=new Thread(delegate() { try { typeof(UninstallForm).GetMethod("Report",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(form,new object[]{new UninstallProgress(UninstallPhase.Activity,0,1)}); } catch(Exception e) { reportError=e; } });
          reporter.Start(); if(!reporter.Join(5000) || reportError!=null) throw new Exception("Fixture report failed."); Application.DoEvents();
          staleUnchanged=title==form.Controls.Find("status",false)[0].Text && detail==form.Controls.Find("detail",false)[0].Text;
          form.Close();
        };
        timer.Start(); Application.Run(form); ReleaseRemoval.Barrier=null;
        UninstallResult r=form.Result;
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { terminal=terminal, expired=expired, failed=form.Failed, errors=errors, cancelled=cancelSent, heldOpen=heldOpen, staleUnchanged=staleUnchanged,
          state=r==null?null:r.State.ToString(),code=r==null?null:r.Code,lease=r==null?null:r.LeaseCleanup.ToString(), title=title, detail=detail }));
      }
    }
    return 0;
  }
}`;

const windows = { skip: process.platform !== 'win32' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let fixture;
function setup() {
  if (fixture) return fixture;
  const boundary = fs.realpathSync.native(tmpdir()), owner = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-uninstall-form-test-')));
  process.on('exit', () => { const path = relative(boundary, owner); if (path.startsWith('arcane-uninstall-form-test-') && !isAbsolute(path) && !path.includes(sep)) fs.rmSync(owner, { recursive: true, force: true }); });
  const sources = ['UninstallForm.cs', 'UninstallTransaction.cs', 'UninstallConsent.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'ReleaseRemoval.cs', 'InstallationActivity.cs', 'SetupPath.cs', 'PayloadArchive.cs'];
  const build = join(owner, 'build'); fs.mkdirSync(build);
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), exe = join(build, 'fixture.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + exe, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', ...sources.map(name => join(build, name)), join(build, 'Harness.cs')], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const bundle = join(owner, 'bundle'); fs.mkdirSync(join(bundle, 'resources', 'node'), { recursive: true });
  const bytes = Buffer.from('owned fixture application'), files = ['Arcane.exe', 'resources/node/node.exe'].map(path => ({ path, bytes: bytes.length, sha256: sha(bytes) }));
  for (const file of files) fs.writeFileSync(join(bundle, file.path), bytes);
  fs.writeFileSync(join(bundle, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version: '0.1.0', platform: 'win32', arch: 'x64', fileCount: 2, totalBytes: bytes.length * 2, files }));
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const inventory = fs.readFileSync(join(directory, 'windows-manifest.json'));
    for (const file of files) assert.equal(sha(fs.readFileSync(join(directory, file.path))), file.sha256);
    return { manifestSha256: sha(inventory), files: 2, bytes: bytes.length * 2 };
  } }); // Labelled scripted verifier; actual engine installation and native removal.
  const run = (target, mode) => new Promise((resolve, reject) => {
    const child = spawn(exe, [target, mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; }); child.once('error', reject);
    child.once('close', code => { if (code !== 0 || err) reject(new Error('fixture ' + code + ': ' + err)); else { try { resolve(JSON.parse(out.trim())); } catch (error) { reject(error); } } });
  });
  fixture = { owner, bundle, engine, run }; return fixture;
}

for (const mode of ['complete', 'missing', 'cancel']) test('native uninstall window: ' + mode, windows, async () => {
  const s = setup(), target = join(s.owner, mode); await s.engine.install({ bundle: s.bundle, installRoot: target });
  const before = fs.readFileSync(join(target, 'installation.json'));
  const r = await s.run(target, mode);
  assert.deepEqual([r.terminal, r.expired, r.failed, r.errors, r.staleUnchanged], [true, false, false, 0, true]);
  if (mode === 'complete') { assert.deepEqual([r.state, r.code, r.lease, r.title], ['Removed', null, 'Released', 'Arcane is uninstalled']); assert.equal(fs.existsSync(target), false); }
  else if (mode === 'missing') { assert.deepEqual([r.state, r.code, r.title], ['Refused', 'CONSENT', 'Installation files kept']); assert.deepEqual(fs.readFileSync(join(target, 'installation.json')), before); }
  else { assert.deepEqual([r.cancelled, r.heldOpen, r.state, r.code, r.lease, r.title], [true, true, 'Partial', 'CANCELLED', 'Released', 'Some installation files remain']); assert.deepEqual(fs.readFileSync(join(target, 'installation.json')), before); }
  assert.equal(fs.existsSync(join(target, 'installation.lock')), false);
});
