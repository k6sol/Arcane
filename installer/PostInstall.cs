// Setup completion binds launcher placement to the confirmed engine result and installation journal.
// It neither retries partial publication nor adopts unrecorded files. Launch is a separate human UI action.
using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace Arcane.Installer
{
    internal sealed class LauncherSetupOutcome
    {
        public readonly bool Ready;
        public readonly string Code, Root, InstallationId;
        public readonly OwnedFileResult Placement;
        public readonly OwnershipSave Journal;
        internal LauncherSetupOutcome(bool ready, string code, string root, string installationId, OwnedFileResult placement, OwnershipSave journal)
        {
            Ready = ready; Code = code; Root = root; InstallationId = installationId; Placement = placement; Journal = journal;
        }
    }

    internal static class PostInstall
    {
        private static LauncherSetupOutcome Result(bool ready, string code, string root, string id, OwnedFileResult placement, OwnershipSave journal)
        { return new LauncherSetupOutcome(ready, code, root, id, placement, journal); }

        /// <summary>Reads only the compiled resource; verifies its exact size and pin before returning any bytes.</summary>
        public static byte[] LauncherResource(Assembly assembly, long bytes, string sha256)
        {
            if (assembly == null || bytes < 1 || bytes > OwnedFiles.MaxBytes) throw new IOException("Launcher unavailable.");
            using (Stream stream = assembly.GetManifestResourceStream("Arcane.Launcher"))
            {
                if (stream == null || stream.Length != bytes) throw new IOException("Launcher unavailable.");
                byte[] value = new byte[(int)bytes]; int read = 0;
                while (read < value.Length) { int count = stream.Read(value, read, value.Length - read); if (count == 0) throw new IOException("Launcher unavailable."); read += count; }
                if (stream.ReadByte() != -1 || Sha(value) != sha256) throw new IOException("Launcher unavailable.");
                return value;
            }
        }

        /// <summary>Places and records the approved launcher only after a confirmed successful installation.
        /// A failure here does not change the engine result. Partial files remain explicit and are never adopted on retry.</summary>
        public static LauncherSetupOutcome CompleteLauncher(string root, InstallOutcome installation, byte[] launcher, long bytes, string sha256)
        {
            OwnedFileResult placement = null; OwnershipSave saved = null;
            string id = installation == null ? null : installation.InstallationId;
            try
            {
                if (installation == null || (installation.State != InstallState.Installed && installation.State != InstallState.AlreadyActive) ||
                    !installation.Started || installation.ExitCode != 0 || !installation.Published.HasValue || installation.LockRetained ||
                    installation.Code != null || installation.StderrBytes != 0) return Result(false, "INSTALLATION", root, id, null, null);
                if (launcher == null || bytes < 1 || bytes > OwnedFiles.MaxBytes || launcher.LongLength != bytes)
                    return Result(false, "SOURCE", root, id, null, null);
                byte[] approved = (byte[])launcher.Clone();
                if (Sha(approved) != sha256) return Result(false, "SOURCE", root, id, null, null);
                InstalledRecordSnapshot record = InstalledRecord.Read(root);
                if (record.InstallationId != installation.InstallationId || record.ActiveReleaseId != installation.ActiveReleaseId)
                    return Result(false, "RECORD_CHANGED", root, id, null, null);
                OwnershipRead ownership = SetupOwnership.Read(record);
                if (ownership.State == OwnershipReadState.Kept) return Result(false,
                    ownership.Code == "RECORD_CHANGED" ? "RECORD_CHANGED" : "JOURNAL_" + ownership.Code, root, id, null, null);
                if (!InstalledRecord.StillCurrent(record)) return Result(false, "RECORD_CHANGED", root, id, null, null);
                placement = OwnedFiles.Place(record.Root, SetupOwnership.LauncherName, approved, sha256, ownership.Snapshot.Launcher);
                if (placement.State != OwnedFileState.Placed && placement.State != OwnedFileState.Replaced && placement.State != OwnedFileState.Unchanged)
                    return Result(false, "PLACEMENT", root, id, placement, null);
                saved = SetupOwnership.Save(ownership.Snapshot, placement.Descriptor, ownership.Snapshot.Uninstaller);
                if (saved.State != OwnershipSaveState.Saved && saved.State != OwnershipSaveState.Unchanged)
                    return Result(false, "JOURNAL", root, id, placement, saved);
                if (!InstalledRecord.StillCurrent(record)) return Result(false, "RECORD_CHANGED", root, id, placement, saved);
                return Result(true, placement.RetainedBackup != null || (saved.Placement != null && saved.Placement.RetainedBackup != null) ? "BACKUP_RETAINED" : null,
                    record.Root, id, placement, saved);
            }
            catch (InstalledRecordException error) { return Result(false, error.Code, root, id, placement, saved); }
            catch (Exception) { return Result(false, "IO", root, id, placement, saved); }
        }

        /// <summary>Called only by the separate Open action. Re-verifies the current release instead of executing a mutable root stub.</summary>
        public static LaunchOutcome Open(LauncherSetupOutcome completed)
        {
            try
            {
                if (completed == null || !completed.Ready) return CannotOpen("CHANGED");
                InstalledRecordSnapshot record = InstalledRecord.Read(completed.Root);
                if (record.InstallationId != completed.InstallationId) return CannotOpen("CHANGED");
                using (PreparedLaunch prepared = InstalledLauncher.Prepare(record)) return InstalledLauncher.Start(prepared);
            }
            catch (InstalledRecordException error) { return CannotOpen(error.Code); }
            catch (Exception) { return CannotOpen("IO"); }
        }

        private static LaunchOutcome CannotOpen(string code) { return new LaunchOutcome(false, code, false, false, false, null, null, null, null); }
        private static string Sha(byte[] bytes)
        {
            using (SHA256 hash = SHA256.Create())
            { StringBuilder text = new StringBuilder(64); foreach (byte value in hash.ComputeHash(bytes)) text.Append(value.ToString("x2")); return text.ToString(); }
        }
    }
}
