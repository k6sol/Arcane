import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createWindowsInstallation } from '../../scripts/windows-installation.mjs';

// Compiles the ACTUAL installer/UninstallConsent.cs with its read-only dependencies via the in-box csc.exe into a SEPARATE
// owned STA harness. The harness uses the trusted Observe seam ONLY on its own dialog: at "load" it makes that dialog
// invisible and off the taskbar; at "shown" it performs clearly labelled SCRIPTED interaction on that dialog's own controls
// (PerformClick proves handler/AcceptButton/CancelButton wiring, NOT physical Enter/Esc keyboard delivery and NOT human
// acceptance). Roots and journals come from the ACTUAL engine and components. No global input, foreground selection,
// real Arcane, providers, Studio, user folders, registry, Start Menu or process queries. Windows-only.
const windows = { skip: process.platform !== 'win32' };
const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = text => createHash('sha256').update(text).digest('hex');
const HARNESS = String.raw`using System; using System.Collections.Generic; using System.Drawing; using System.Security.Cryptography; using System.Text; using System.Windows.Forms; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  static void Out(Dictionary<string, object> v) { Console.WriteLine(Json.Serialize(v)); Console.Out.Flush(); }
  static string Sha(byte[] b) { using (SHA256 s = SHA256.Create()) { StringBuilder x = new StringBuilder(); foreach (byte c in s.ComputeHash(b)) x.Append(c.ToString("x2")); return x.ToString(); } }
  [STAThread] static int Main(string[] a) {
    string root = a[0], mode = a[1]; Dictionary<string, object> seen = new Dictionary<string, object>(); int observations = 0;
    if (a.Length > 2 && a[2] == "journal") {
      // Create a real journal through the actual components before the dialog reads it.
      InstalledRecordSnapshot r0 = InstalledRecord.Read(root); byte[] b = Encoding.UTF8.GetBytes("owned launcher fixture");
      OwnedFileResult placed = OwnedFiles.Place(root, SetupOwnership.LauncherName, b, Sha(b), null);
      SetupOwnership.Save(SetupOwnership.Read(r0).Snapshot, placed.Descriptor, null);
    }
    UninstallConsent.Observe = delegate(Form form, string stage) {
      observations++;
      if (stage == "load") {
        // Harness-only native window properties on its OWN dialog, before it is first shown: invisible and off the taskbar.
        // (Setting ShowInTaskbar here would recreate the handle, which closes a modal dialog.)
        form.Opacity = 0; form.Location = new Point(-32000, -32000);
        long ex = GetWindowLongPtr(form.Handle, -20).ToInt64(); // GWL_EXSTYLE
        SetWindowLongPtr(form.Handle, -20, new IntPtr((ex & ~0x00040000L) | 0x00000080L)); // clear WS_EX_APPWINDOW, add WS_EX_TOOLWINDOW
        return; }
      Control cancel = form.Controls.Find("cancel", false)[0], uninstall = form.Controls.Find("uninstall", false)[0];
      seen["acceptButton"] = ((Control)form.AcceptButton).Name; seen["cancelButton"] = ((Control)form.CancelButton).Name; seen["focused"] = form.ActiveControl == null ? null : form.ActiveControl.Name;
      seen["heading"] = form.Controls.Find("heading", false)[0].Text; seen["location"] = form.Controls.Find("location", false)[0].Text; seen["kept"] = form.Controls.Find("kept", false)[0].Text;
      Control heading = form.Controls.Find("heading", false)[0]; Size preferred = heading.GetPreferredSize(new Size(heading.Width, 0));
      seen["headingFits"] = preferred.Width <= heading.Width && preferred.Height <= heading.Height;
      Control[] version = form.Controls.Find("version", false); seen["versionText"] = version.Length == 0 ? heading.Text : version[0].Text;
      TextBox versionBox = version.Length == 0 ? null : version[0] as TextBox;
      if (versionBox != null) {
        Point last = versionBox.GetPositionFromCharIndex(versionBox.TextLength - 1);
        int glyph = TextRenderer.MeasureText(versionBox.Text[versionBox.TextLength - 1].ToString(), versionBox.Font, Size.Empty, TextFormatFlags.NoPadding).Width;
        seen["versionVisible"] = versionBox.ReadOnly && versionBox.WordWrap && last.X >= 0 && last.Y >= 0 && last.X + glyph <= versionBox.ClientSize.Width && last.Y + versionBox.Font.Height <= versionBox.ClientSize.Height;
      }
      form.BeginInvoke(new Action(delegate {
        // SCRIPTED interaction on this owned dialog's own controls only.
        if (mode == "accept-button") form.AcceptButton.PerformClick();
        else if (mode == "cancel-button") form.CancelButton.PerformClick();
        else if (mode == "cancel") ((Button)cancel).PerformClick();
        else if (mode == "close") form.Close();
        else if (mode == "uninstall-twice") { ((Button)uninstall).PerformClick(); seen["uninstallEnabledAfterFirst"] = uninstall.Enabled; ((Button)uninstall).PerformClick(); }
        else if (mode == "wait-then-uninstall") { Out(new Dictionary<string, object> { { "op", "wait" } }); Console.In.ReadLine(); ((Button)uninstall).PerformClick(); }
        else ((Button)uninstall).PerformClick();
      }));
    };
    InstalledRecordSnapshot displayed = InstalledRecord.Read(root);
    if (mode == "wait-before-ask") { Out(new Dictionary<string, object> { { "op", "wait" } }); Console.In.ReadLine(); }
    ConsentResult result = UninstallConsent.Ask(null, displayed);
    UninstallConsent.Observe = null;
    Dictionary<string, object> v = new Dictionary<string, object>(seen); v["op"] = "consent"; v["state"] = result.State.ToString(); v["code"] = result.Code; v["authorized"] = result.Authorization != null; v["dialogObservations"] = observations;
    if (result.Authorization != null) { v["journalPresent"] = result.Authorization.JournalPresent; v["boundSha"] = result.Authorization.RecordSha256; }
    Out(v);
    UninstallAuthorization authorization = result.Authorization; OperationLease lease = null, other = null;
    for (int i = 3; i < a.Length; i++) {
      Dictionary<string, object> o = new Dictionary<string, object>(); o["op"] = a[i];
      switch (a[i]) {
        case "wait": Out(o); Console.In.ReadLine(); continue;
        case "acquire": { LeaseResult r = OperationLease.Acquire(InstalledRecord.Read(root)); lease = r.Lease; o["state"] = r.State.ToString(); break; }
        case "acquire-other": { LeaseResult r = OperationLease.Acquire(InstalledRecord.Read(a[++i])); other = r.Lease; o["state"] = r.State.ToString(); break; }
        case "release": o["state"] = lease.Release().State.ToString(); break;
        case "dispose": lease.Dispose(); o["state"] = "disposed"; break;
        case "consume": case "consume-null": case "consume-other": {
          ConsentConsume c = authorization.TryConsume(a[i] == "consume" ? lease : a[i] == "consume-other" ? other : null);
          o["ok"] = c.Ok; o["code"] = c.Code; o["record"] = c.Record != null; o["journal"] = c.Journal != null && c.Journal.Present; break; }
      }
      Out(o);
    }
    if (lease != null && lease.Live) lease.Release(); if (other != null && other.Live) other.Release();
    return 0;
  } }`;

let shared;
function setup() {
  if (shared) return shared;
  const boundary = fs.realpathSync.native(tmpdir()), root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-consent-test-')));
  process.on('exit', () => { const p = relative(boundary, root); if (p.startsWith('arcane-consent-test-') && !isAbsolute(p) && !p.includes(sep)) fs.rmSync(root, { recursive: true, force: true }); });
  const build = join(root, 'build'); fs.mkdirSync(build);
  const sources = ['UninstallConsent.cs', 'InstalledRecord.cs', 'OperationLease.cs', 'SetupOwnership.cs', 'OwnedFiles.cs', 'PayloadArchive.cs'];
  for (const name of sources) fs.copyFileSync(new URL('../../installer/' + name, import.meta.url), join(build, name));
  fs.writeFileSync(join(build, 'Harness.cs'), HARNESS);
  const harness = join(build, 'harness.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', ...[...sources, 'Harness.cs'].map(f => join(build, f))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(compiled.status, 0, 'csc failed: ' + compiled.stdout + compiled.stderr);
  let count = 0;
  const owned = name => { const dir = join(root, name + '-' + ++count); fs.mkdirSync(dir); return dir; };
  // SCRIPTED verifier (fixture hashes only); the actual engine writes the record the consent binds to.
  const engine = createWindowsInstallation({ verifyBundle: async directory => {
    const bytes = fs.readFileSync(join(directory, 'windows-manifest.json')), manifest = JSON.parse(bytes);
    return { manifestSha256: sha(bytes), files: manifest.fileCount, bytes: manifest.totalBytes };
  } });
  const bundle = (tag, version = '0.3.1') => {
    const dir = owned('bundle'); fs.mkdirSync(join(dir, 'resources', 'node'), { recursive: true }); const files = [];
    for (const [path, text] of [['Arcane.exe', 'fixture app ' + tag], ['resources/node/node.exe', 'fixture node']]) { fs.writeFileSync(join(dir, path), text); files.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text) }); }
    fs.writeFileSync(join(dir, 'windows-manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'arcane-windows-directory', version, platform: 'win32', arch: 'x64', fileCount: 2, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files }));
    return dir;
  };
  const installed = async (version = '0.3.1') => { const target = join(owned('install'), 'Arcane'); await engine.install({ bundle: bundle('one', version), installRoot: target }); return target; };
  const run = (target, mode, ops = [], actions = []) => new Promise((resolve, reject) => {
    const child = spawn(harness, [target, mode, ...ops], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let out = '', err = '', chain = Promise.resolve(), actionError, deadlineElapsed = false;
    child.stdout.on('data', d => {
      out += d; const lines = out.split(/\r?\n/); out = lines.pop();
      for (const line of lines) { const row = JSON.parse(line); rows.push(row); if (row.op === 'wait') { const action = actions.shift() ?? (() => {}); chain = chain.then(action).catch(error => { actionError ??= error; }).then(() => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write('go\n'); }); } }
    });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', error => { actionError ??= error; });
    // Expiry requests the end of any owned stdin handshake; it never claims the native process has exited.
    const deadline = setTimeout(() => { deadlineElapsed = true; child.stdin.end(); }, 60000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); chain.then(() => { child.stdin.destroy(); if (actionError) reject(actionError); else if (deadlineElapsed || err || code !== 0) reject(new Error('harness ' + code + ' ' + err + (deadlineElapsed ? ' observation deadline elapsed' : ''))); else resolve(rows.filter(r => r.op !== 'wait')); }); });
  });
  shared = { owned, engine, bundle, installed, run };
  return shared;
}
const tree = dir => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p)] = sha(fs.readFileSync(p)); } }; walk(dir); return out; };

test('the dialog defaults to Cancel; Enter/Esc mappings, Cancel and closing never authorize, and nothing changes', windows, async () => {
  const s = setup(), target = await s.installed(), before = tree(target);
  for (const mode of ['accept-button', 'cancel-button', 'cancel', 'close']) {
    const [consent] = await s.run(target, mode, ['-']);
    assert.deepEqual([consent.state, consent.code, consent.authorized], ['Cancelled', null, false], mode);
    assert.deepEqual([consent.acceptButton, consent.cancelButton, consent.focused], ['cancel', 'cancel', 'cancel'], 'actual default/cancel bindings and initial focus');
    assert.equal(consent.heading, 'Uninstall Arcane?'); assert.equal(consent.versionText, 'Version 0.3.1'); assert.equal(consent.location.replace(/\r\n/g, '\n'), 'Installed in:\n' + target);
    assert.match(consent.kept, /projects and app profiles are kept/);
  }
  assert.deepEqual(tree(target), before, 'no external side effects');
});

test('only the explicit Uninstall handler authorizes, once; consumption needs a live bound lease and is single-use', windows, async () => {
  const s = setup(), target = await s.installed(), second = await s.installed();
  let rows = await s.run(target, 'uninstall-twice', ['-', 'consume-null', 'consume', 'acquire', 'consume']);
  assert.deepEqual([rows[0].state, rows[0].authorized, rows[0].uninstallEnabledAfterFirst], ['Authorized', true, false], 'a second queued click cannot issue another authorization');
  assert.deepEqual(rows.filter(r => r.op.startsWith('consume')).map(r => [r.op, r.ok, r.code]), [['consume-null', false, 'LEASE'], ['consume', false, 'CONSUMED'], ['consume', false, 'CONSUMED']],
    'the first (failed) attempt consumed it: no replay even with a valid lease');
  rows = await s.run(target, 'uninstall', ['journal', 'acquire', 'consume', 'consume']);
  assert.deepEqual([rows[0].state, rows[0].journalPresent], ['Authorized', true]);
  assert.deepEqual(rows.filter(r => r.op === 'consume').map(r => [r.ok, r.code, r.record, r.journal]), [[true, null, true, true], [false, 'CONSUMED', false, false]]);
  for (const ops of [['-', 'acquire-other', second, 'consume-other'], ['-', 'acquire', 'release', 'consume'], ['-', 'acquire', 'dispose', 'consume']]) {
    rows = await s.run(target, 'uninstall', ops); if (fs.existsSync(join(target, 'installation.lock'))) fs.unlinkSync(join(target, 'installation.lock'));
    assert.deepEqual(rows.filter(r => r.op.startsWith('consume')).map(r => [r.ok, r.code]), [[false, 'LEASE']], ops.join(' '));
  }
});

test('record or journal changes before the click or before consumption are never silently approved', windows, async () => {
  const s = setup();
  let target = await s.installed();
  let rows = await s.run(target, 'wait-then-uninstall', ['-'], [async () => { await s.engine.install({ bundle: s.bundle('changed'), installRoot: target }); }]);
  assert.deepEqual([rows[0].state, rows[0].code, rows[0].authorized], ['Changed', 'RECORD', false], 'record changed while the dialog was open');
  target = await s.installed();
  rows = await s.run(target, 'wait-then-uninstall', ['journal'], [() => { const p = join(target, 'setup-ownership.json'), b = fs.readFileSync(p); fs.unlinkSync(p); fs.writeFileSync(p, b); }]);
  assert.deepEqual([rows[0].state, rows[0].code, rows[0].authorized], ['Changed', 'JOURNAL', false], 'journal replaced (same bytes, new identity) while the dialog was open');
  target = await s.installed();
  rows = await s.run(target, 'uninstall', ['-', 'wait', 'acquire', 'consume'], [async () => { await s.engine.install({ bundle: s.bundle('later'), installRoot: target }); }]);
  assert.deepEqual(rows.filter(r => r.op === 'consume').map(r => [r.ok, r.code]), [[false, 'RECORD_CHANGED']]);
  target = await s.installed();
  rows = await s.run(target, 'uninstall', ['journal', 'wait', 'acquire', 'consume'], [() => { const p = join(target, 'setup-ownership.json'), b = fs.readFileSync(p); fs.unlinkSync(p); fs.writeFileSync(p, b); }]);
  assert.deepEqual(rows.filter(r => r.op === 'consume').map(r => [r.ok, r.code]), [[false, 'JOURNAL_CHANGED']]);
  target = await s.installed();
  rows = await s.run(target, 'uninstall', ['-', 'wait', 'acquire', 'consume'], [() => { const p = join(target, 'setup-ownership.json'); fs.writeFileSync(p, 'manual'); }]);
  assert.deepEqual(rows.filter(r => r.op === 'consume').map(r => [r.ok, r.code]), [[false, 'JOURNAL_CHANGED']], 'a journal appearing after an absent-journal approval');
});

test('a stale record or kept journal is refused before any dialog opens', windows, async () => {
  const s = setup();
  let target = await s.installed();
  let [result] = await s.run(target, 'wait-before-ask', ['-'], [async () => {
    await s.engine.install({ bundle: s.bundle('before prompt'), installRoot: target });
  }]);
  assert.deepEqual([result.state, result.code, result.authorized, result.dialogObservations], ['Refused', 'RECORD', false, 0]);
  target = await s.installed(); const journal = join(target, 'setup-ownership.json'); fs.writeFileSync(journal, 'manual journal');
  [result] = await s.run(target, 'uninstall', ['-']);
  assert.deepEqual([result.state, result.code, result.authorized, result.dialogObservations], ['Refused', 'JOURNAL', false, 0]);
  assert.equal(fs.readFileSync(journal, 'utf8'), 'manual journal');
});

test('a maximum-length release version remains available without overflowing the confirmation heading', windows, async () => {
  const s = setup(), version = '0.3.1-' + 'W'.repeat(58); assert.equal(version.length, 64);
  const target = await s.installed(version), [result] = await s.run(target, 'cancel', ['-']);
  assert.equal(result.headingFits, true, 'native heading measurements fit the available control');
  assert.ok(result.versionText.includes(version), 'the complete selected version remains available');
  assert.equal(result.versionVisible, true, 'the native final-character position remains visible without scrolling');
  assert.equal(result.authorized, false);
});
