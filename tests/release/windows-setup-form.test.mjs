import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';

// Actual setup controls and message dispatch, hidden in a separate owned STA harness. Reflection sets the
// precise late-callback interleaving; no GUI input, install, application launch, registry or user-folder access.
const HARNESS = String.raw`using System; using System.Reflection; using System.Threading; using System.Windows.Forms; using System.Web.Script.Serialization; using Arcane.Installer;
internal static class Harness {
  [STAThread] private static int Main(string[] a) {
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
    int errors = 0; Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { errors++; };
    using (SetupForm form = new SetupForm()) using (CancellationTokenSource operation = new CancellationTokenSource()) {
      IntPtr handle = form.Handle;
      Type type = typeof(SetupForm); BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Instance;
      FieldInfo active = type.GetField("operation", flags); type.GetField("busy", flags).SetValue(form, true);
      if (a[0] != "no-operation") active.SetValue(form, operation);
      if (a[0] == "cancelled") operation.Cancel();
      Exception reportError = null;
      Thread reporter = new Thread(delegate() {
        try { type.GetMethod("Report", flags).Invoke(form, new object[] { new InstallProgress("copying", 1, 2, 3, 4) }); }
        catch (Exception error) { reportError = error; }
      });
      reporter.IsBackground = true; reporter.Start();
      if (!reporter.Join(5000)) throw new Exception("Report did not acknowledge completion.");
      if (reportError != null) throw reportError;
      // A completed install clears its operation; opening sets busy again before a previously posted update dispatches.
      if (a[0] == "queued-old-operation") active.SetValue(form, null);
      Application.DoEvents();
      string text = ((Label)type.GetField("status", flags).GetValue(form)).Text;
      int value = ((ProgressBar)type.GetField("progress", flags).GetValue(form)).Value;
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { errors = errors, status = text, progress = value }));
    }
    return 0;
  }
}`;

test('setup progress belongs only to its live installation operation, including queued callbacks during Open', { skip: process.platform !== 'win32' }, () => {
  const boundary = fs.realpathSync.native(tmpdir()), owner = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-setup-form-')));
  try {
    // Compile all shipped native components together with one explicitly selected harness entry point.
    const sourceDirectory = new URL('../../installer/', import.meta.url);
    const names = fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.cs'));
    assert.ok(names.includes('SetupForm.cs'));
    for (const name of names) fs.copyFileSync(new URL(name, sourceDirectory), join(owner, name));
    fs.writeFileSync(join(owner, 'Harness.cs'), HARNESS);
    fs.writeFileSync(join(owner, 'SetupPins.cs'), 'namespace Arcane.Installer { internal static class SetupPins { public const string PayloadSha256="' + '0'.repeat(64) + '"; public const string KitManifestSha256="' + '0'.repeat(64) + '"; public const int MaximumRelativePathChars=134; public const long LauncherBytes=1; public const string LauncherSha256="' + '0'.repeat(64) + '"; public const long UninstallerBytes=1; public const string UninstallerSha256="' + '0'.repeat(64) + '"; } }');
    const harness = join(owner, 'harness.exe'), compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const built = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:Harness', '/out:' + harness,
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll',
      ...[...names, 'Harness.cs', 'SetupPins.cs'].map(name => join(owner, name))], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const observations = [];
    for (const mode of ['no-operation', 'queued-old-operation', 'cancelled', 'active']) {
      const result = spawnSync(harness, [mode], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stderr, '');
      observations.push({ mode, ...JSON.parse(result.stdout.trim()) });
    }
    assert.deepEqual(observations, [
      { mode: 'no-operation', errors: 0, status: 'Install for your Windows account.', progress: 0 },
      { mode: 'queued-old-operation', errors: 0, status: 'Install for your Windows account.', progress: 0 },
      { mode: 'cancelled', errors: 0, status: 'Install for your Windows account.', progress: 0 },
      { mode: 'active', errors: 0, status: 'Installing Arcane...', progress: 750 },
    ]);
  } finally {
    const child = relative(boundary, owner);
    assert.ok(child.startsWith('arcane-setup-form-') && !isAbsolute(child) && !child.includes(sep));
    fs.rmSync(owner, { recursive: true, force: true });
  }
});
