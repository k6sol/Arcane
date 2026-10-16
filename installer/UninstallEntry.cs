using System;
using System.IO;
using System.Security.Cryptography;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal static class UninstallEntry
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            return Run(args);
        }

        /// <summary>Normal entry stages the journal-owned image and exits. Staged entry waits for that actual process,
        /// validates the image and installation anew, then always asks for a fresh human decision.</summary>
        internal static int Run(string[] args)
        {
            try
            {
                string self = SetupPath.CanonicalExecutable(Application.ExecutablePath);
                if (Path.GetFileName(self) != SetupOwnership.UninstallerName) return Refused("Start uninstall from the installed Arcane folder.");
                if (args == null || args.Length == 0) return Stage(self);
                using (UninstallParent parent = UninstallParent.Read(args))
                {
                    if (parent == null) return Refused("Start uninstall from the installed Arcane folder.");
                    if (parent.Wait(30000).State != ParentExitState.Exited) return Refused("Uninstall preparation has not finished. Please try again.");
                    string directory = Path.GetDirectoryName(self);
                    if (directory == parent.TargetRoot || !StageName(Path.GetFileName(directory))) return Refused("Start uninstall from the installed Arcane folder.");
                    InstalledRecordSnapshot displayed = InstalledRecord.Read(parent.TargetRoot);
                    OwnershipRead ownership = SetupOwnership.Read(displayed);
                    if (ownership.State != OwnershipReadState.Valid || ownership.Snapshot == null || !ownership.Snapshot.Present || ownership.Snapshot.Uninstaller == null)
                        return Refused("The installation changed. Start uninstall again to review it.");
                    OwnedFileDescriptor source = ownership.Snapshot.Uninstaller;
                    using (SafeFileHandle image = Verify(self, source, false))
                    {
                        if (image == null) return Refused("The uninstall files changed. Start uninstall again.");
                        ConsentResult consent;
                        // The root source is checked before the person decides, then closed so it cannot obstruct removal.
                        using (SafeFileHandle original = Verify(displayed.Root + "\\" + SetupOwnership.UninstallerName, source, true))
                        {
                            if (original == null) return Refused("The uninstall files changed. Start uninstall again.");
                            consent = UninstallConsent.Ask(null, displayed);
                        }
                        if (consent.State == ConsentState.Cancelled) return 0;
                        if (consent.Authorization == null) return Refused("The installation changed. Start uninstall again to review it.");
                        using (UninstallForm form = new UninstallForm(displayed, consent.Authorization))
                        {
                            Application.Run(form);
                            if (form.Failed || form.Result == null) return 3;
                            return form.Result.State == UninstallState.Removed || form.Result.State == UninstallState.Cancelled ? 0 : 2;
                        }
                    }
                }
            }
            catch (Exception) { return Refused("Uninstall could not confirm the installation. The remaining files have been kept."); }
        }

        private static int Stage(string self)
        {
            string root = Path.GetDirectoryName(self);
            InstalledRecordSnapshot record = InstalledRecord.Read(root);
            OwnershipRead ownership = SetupOwnership.Read(record);
            if (ownership.State != OwnershipReadState.Valid || ownership.Snapshot == null) return Refused("The installation changed. Start uninstall again to review it.");
            UninstallStageResult prepared = UninstallStage.Prepare(record, ownership.Snapshot, self, StageDirectory.CanonicalTempParent(SetupOwnership.UninstallerName.Length));
            if (prepared.Stage == null) return Refused("Uninstall could not prepare its files. Please try again.");
            UninstallHandoffResult started = UninstallHandoff.Start(prepared.Stage);
            if (started.State != HandoffState.Started) return Refused("Uninstall could not finish preparation. The remaining files have been kept.");
            // The child owns its inherited process wait. Waiting for it here would prevent this image from being released.
            return 0;
        }

        private static bool StageName(string name)
        {
            if (name == null || name.Length != StageDirectory.StageNameChars || !name.StartsWith("ArcaneSetup-", StringComparison.Ordinal)) return false;
            foreach (char c in name.Substring(12)) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'f')) return false;
            return true;
        }

        private static SafeFileHandle Verify(string path, OwnedFileDescriptor expected, bool identityRequired)
        {
            if (expected == null || expected.Bytes < 1 || expected.Bytes > OwnedFiles.MaxBytes || SetupPath.CanonicalExecutable(path) != path) return null;
            SafeFileHandle file = NativeFile.Open(path, NativeFile.GenericRead, NativeFile.ShareRead, false);
            if (file == null) return null;
            try
            {
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (!NativeFile.Describe(file, out identity, out attributes, out links, out size) || (identityRequired && !identity.SameAs(expected.Identity)) ||
                    links != 1 || size != expected.Bytes || (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                { file.Dispose(); return null; }
                using (FileStream stream = new FileStream(new SafeFileHandle(file.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
                using (SHA256 hash = SHA256.Create())
                    if (stream.Length != size || InstalledRecord.Hex(hash.ComputeHash(stream)) != expected.Sha256) { file.Dispose(); return null; }
                return file;
            }
            catch (Exception) { file.Dispose(); return null; }
        }
        private static int Refused(string message)
        {
            MessageBox.Show(message, "Arcane", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 2;
        }
    }
}
