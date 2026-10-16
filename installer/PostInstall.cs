// Setup completion binds root tools and the Start Menu shortcut to the confirmed engine result and installation journal.
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

    /// <summary>Immutable result of placing and recording both fixed root files under one operation lease. Null fields were not reached.</summary>
    internal sealed class SetupCompletionOutcome
    {
        public readonly bool Ready;
        /// <summary>null, BACKUP_RETAINED, INSTALLATION, SOURCE, RECORD_CHANGED, LOCKED, PATH, IO, JOURNAL_(read code), LAUNCHER,
        /// LAUNCHER_JOURNAL, JOURNAL_CHANGED, UNINSTALLER, UNINSTALLER_JOURNAL or LEASE.</summary>
        public readonly string Code, Root, InstallationId;
        /// <summary>The launcher placement and its own journal save.</summary>
        public readonly LauncherSetupOutcome Launcher;
        public readonly OwnedFileResult Uninstaller;
        /// <summary>The latest known journal save.</summary>
        public readonly OwnershipSave Journal;
        /// <summary>null when no lease was issued.</summary>
        public readonly LeaseReleaseState? LeaseCleanup;
        public readonly string LeaseCleanupCode, RetainedLock;
        internal SetupCompletionOutcome(bool ready, string code, string root, string installationId, LauncherSetupOutcome launcher, OwnedFileResult uninstaller,
            OwnershipSave journal, LeaseReleaseState? leaseCleanup, string leaseCleanupCode, string retainedLock)
        {
            Ready = ready; Code = code; Root = root; InstallationId = installationId; Launcher = launcher; Uninstaller = uninstaller; Journal = journal;
            LeaseCleanup = leaseCleanup; LeaseCleanupCode = leaseCleanupCode; RetainedLock = retainedLock;
        }
    }

    internal sealed class ShortcutSetupOutcome
    {
        public readonly bool Ready;
        public readonly string Code, RetainedLock;
        public readonly OwnedFileResult Placement;
        public readonly OwnershipSave Journal;
        public readonly LeaseReleaseState? LeaseCleanup;
        internal ShortcutSetupOutcome(bool ready, string code, OwnedFileResult placement, OwnershipSave journal, LeaseReleaseState? cleanup, string retainedLock)
        { Ready = ready; Code = code; Placement = placement; Journal = journal; LeaseCleanup = cleanup; RetainedLock = retainedLock; }
    }

    internal static class PostInstall
    {
        private static LauncherSetupOutcome Result(bool ready, string code, string root, string id, OwnedFileResult placement, OwnershipSave journal)
        { return new LauncherSetupOutcome(ready, code, root, id, placement, journal); }

        /// <summary>Reads only the compiled resource; verifies its exact size and pin before returning any bytes.</summary>
        public static byte[] LauncherResource(Assembly assembly, long bytes, string sha256) { return Resource(assembly, "Arcane.Launcher", bytes, sha256, "Launcher unavailable."); }

        /// <summary>Reads only the compiled uninstaller resource; verifies its exact size and pin before returning any bytes.</summary>
        public static byte[] UninstallerResource(Assembly assembly, long bytes, string sha256) { return Resource(assembly, "Arcane.Uninstaller", bytes, sha256, "Uninstaller unavailable."); }

        /// <summary>One of the fixed compiled resource names only, bounded and pinned.</summary>
        private static byte[] Resource(Assembly assembly, string name, long bytes, string sha256, string unavailable)
        {
            if (assembly == null || bytes < 1 || bytes > OwnedFiles.MaxBytes) throw new IOException(unavailable);
            using (Stream stream = assembly.GetManifestResourceStream(name))
            {
                if (stream == null || stream.Length != bytes) throw new IOException(unavailable);
                byte[] value = new byte[(int)bytes]; int read = 0;
                while (read < value.Length) { int count = stream.Read(value, read, value.Length - read); if (count == 0) throw new IOException(unavailable); read += count; }
                if (stream.ReadByte() != -1 || Sha(value) != sha256) throw new IOException(unavailable);
                return value;
            }
        }

        private static bool Confirmed(InstallOutcome installation)
        {
            return installation != null && (installation.State == InstallState.Installed || installation.State == InstallState.AlreadyActive) &&
                installation.Started && installation.ExitCode == 0 && installation.Published.HasValue && !installation.LockRetained &&
                installation.Code == null && installation.StderrBytes == 0;
        }

        /// <summary>A private verified copy of approved bytes, or null.</summary>
        private static byte[] Approved(byte[] source, long bytes, string sha256)
        {
            if (source == null || bytes < 1 || bytes > OwnedFiles.MaxBytes || source.LongLength != bytes || sha256 == null) return null;
            byte[] copy = (byte[])source.Clone();
            return Sha(copy) == sha256 ? copy : null;
        }

        private static bool Same(OwnedFileDescriptor a, OwnedFileDescriptor b)
        {
            if (a == null || b == null) return a == null && b == null;
            return a.Root == b.Root && a.Name == b.Name && a.Bytes == b.Bytes && a.Sha256 == b.Sha256 && a.RootIdentity.SameAs(b.RootIdentity) && a.Identity.SameAs(b.Identity);
        }

        /// <summary>A fresh leased read must still be exactly <paramref name="expected"/> (journal file and both descriptors) for the current record.</summary>
        private static bool Fenced(InstalledRecordSnapshot record, OperationLease lease, SetupOwnershipSnapshot expected)
        {
            if (expected == null || !InstalledRecord.StillCurrent(record, lease)) return false;
            OwnershipRead fresh = SetupOwnership.Read(record, lease);
            return fresh.State == OwnershipReadState.Valid && fresh.Snapshot != null && fresh.Snapshot.Present && expected.Present &&
                Same(fresh.Snapshot.Journal, expected.Journal) && Same(fresh.Snapshot.Launcher, expected.Launcher) && Same(fresh.Snapshot.Uninstaller, expected.Uninstaller) && Same(fresh.Snapshot.Shortcut, expected.Shortcut);
        }

        private static bool Accepted(OwnedFileResult placement)
        {
            return placement != null && placement.Descriptor != null &&
                (placement.State == OwnedFileState.Placed || placement.State == OwnedFileState.Replaced || placement.State == OwnedFileState.Unchanged);
        }

        private static bool Saved(OwnershipSave save)
        { return save != null && save.Snapshot != null && (save.State == OwnershipSaveState.Saved || save.State == OwnershipSaveState.Unchanged); }

        private static bool Retained(OwnedFileResult placement, OwnershipSave save)
        { return placement != null && placement.RetainedBackup != null || save != null && save.Placement != null && save.Placement.RetainedBackup != null; }

        private static byte[] VerifiedBytes(OwnedFileDescriptor descriptor)
        {
            if (descriptor == null || !InstalledRecord.Directory(InstalledRecord.DirectRoot(descriptor.Root)).SameAs(descriptor.RootIdentity)) return null;
            FileIdentity identity;
            byte[] bytes = InstalledRecord.ReadDirect(descriptor.Root + "\\" + descriptor.Name, OwnedFiles.MaxBytes, "FILE", out identity);
            return identity.SameAs(descriptor.Identity) && bytes.LongLength == descriptor.Bytes && Sha(bytes) == descriptor.Sha256 ? bytes : null;
        }

        /// <summary>The trusted host supplies the current user's Programs directory, never an argument from setup's CLI or
        /// the ownership journal. Creates no directory and never adopts an existing link. Root files remain a separate outcome.</summary>
        public static ShortcutSetupOutcome CompleteShortcut(SetupCompletionOutcome completion, string programsRoot)
        {
            bool ready = false; string code = null, retainedLock = null;
            OwnedFileResult placement = null; OwnershipSave saved = null;
            OperationLease lease = null; LeaseRelease released = null;
            try
            {
                if (completion == null || !completion.Ready || completion.Launcher == null || completion.Launcher.Placement == null || completion.Uninstaller == null || completion.Journal == null || completion.Journal.Snapshot == null)
                    code = "INSTALLATION";
                else
                {
                    string programs = InstalledRecord.DirectRoot(programsRoot);
                    InstalledRecordSnapshot record = InstalledRecord.Read(completion.Root);
                    if (record.InstallationId != completion.InstallationId || record.RecordSha256 != completion.Journal.Snapshot.Record.RecordSha256) code = "RECORD_CHANGED";
                    else
                    {
                        LeaseResult acquired = OperationLease.Acquire(record); retainedLock = acquired.RetainedLock;
                        if (acquired.State != LeaseState.Acquired || acquired.Lease == null) code = acquired.Code ?? "LEASE";
                        else
                        {
                            lease = acquired.Lease;
                            OwnershipRead read = SetupOwnership.Read(record, lease);
                            SetupOwnershipSnapshot current = read.Snapshot;
                            if (read.State != OwnershipReadState.Valid || current == null) code = "JOURNAL";
                            else if (!Same(current.Launcher, completion.Launcher.Placement.Descriptor) || !Same(current.Uninstaller, completion.Uninstaller.Descriptor) ||
                                VerifiedBytes(current.Launcher) == null || VerifiedBytes(current.Uninstaller) == null) code = "ROOT_FILES";
                            else if (current.Shortcut != null && (current.Shortcut.Root != programs || !InstalledRecord.Directory(programs).SameAs(current.Shortcut.RootIdentity))) code = "DESTINATION_CHANGED";
                            else
                            {
                                string launcherPath = record.Root + "\\" + SetupOwnership.LauncherName;
                                // Reuse a verified link's exact bytes: COM tracking metadata is not a reason to replace it.
                                byte[] bytes = current.Shortcut == null || !InstalledRecord.Exists(current.Shortcut.Root + "\\" + current.Shortcut.Name) ? null : VerifiedBytes(current.Shortcut);
                                ShellLinkResult link = bytes == null ? ArcaneShellLink.Create(launcherPath, record.Root) : ArcaneShellLink.Inspect(bytes);
                                if (!link.Ok || !ArcaneShellLink.Describes(link.Fields, launcherPath, record.Root)) code = "LINK";
                                else if (!Fenced(record, lease, current)) code = "JOURNAL_CHANGED";
                                else
                                {
                                    bytes = bytes ?? link.Bytes;
                                    placement = OwnedFiles.Place(programs, SetupOwnership.ShortcutName, bytes, Sha(bytes), current.Shortcut);
                                    if (!Accepted(placement)) code = "PLACEMENT";
                                    else if (!Fenced(record, lease, current)) code = "JOURNAL_CHANGED";
                                    else
                                    {
                                        saved = SetupOwnership.SaveShortcut(current, placement.Descriptor, lease);
                                        if (!Saved(saved)) code = "SHORTCUT_JOURNAL";
                                        else if (!Fenced(record, lease, saved.Snapshot) || VerifiedBytes(placement.Descriptor) == null ||
                                            VerifiedBytes(current.Launcher) == null || VerifiedBytes(current.Uninstaller) == null) code = "CHANGED";
                                        else { ready = true; if (Retained(placement, saved)) code = "BACKUP_RETAINED"; }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch (InstalledRecordException error) { code = error.Code; }
            catch (Exception) { code = "IO"; }
            finally
            {
                if (lease != null)
                {
                    try { released = lease.Release(); } catch (Exception) { released = new LeaseRelease(LeaseReleaseState.Unknown, "IO"); }
                    try { lease.Dispose(); } catch (Exception) { }
                    if (released.State != LeaseReleaseState.Released)
                    { retainedLock = lease.Root + "\\" + InstalledRecord.LockName; if (ready) { ready = false; code = "LEASE"; } }
                }
            }
            return new ShortcutSetupOutcome(ready, code, placement, saved, released == null ? (LeaseReleaseState?)null : released.State, retainedLock);
        }

        /// <summary>After a confirmed installation, places and records the approved launcher, then the approved uninstaller, under ONE
        /// operation lease for the current record. The launcher is recorded before the uninstaller is placed, so a later failure keeps
        /// its authority. Never adopts unrecorded files, retries, takes over a lock or rewrites the record. Ready only when both are
        /// recorded exactly, the record is unchanged and the lease was released.</summary>
        public static SetupCompletionOutcome CompleteRootFiles(string root, InstallOutcome installation, byte[] launcher, long launcherBytes, string launcherSha,
            byte[] uninstaller, long uninstallerBytes, string uninstallerSha)
        {
            string id = installation == null ? null : installation.InstallationId, code = null, retainedLock = null;
            bool ready = false;
            LauncherSetupOutcome launcherOutcome = null; OwnedFileResult uninstallerPlacement = null; OwnershipSave journal = null;
            OperationLease lease = null; LeaseRelease released = null;
            try
            {
                if (!Confirmed(installation)) code = "INSTALLATION";
                else
                {
                    // Both approved sources are proven before anything is placed.
                    byte[] approvedLauncher = Approved(launcher, launcherBytes, launcherSha), approvedUninstaller = Approved(uninstaller, uninstallerBytes, uninstallerSha);
                    if (approvedLauncher == null || approvedUninstaller == null) code = "SOURCE";
                    else
                    {
                        InstalledRecordSnapshot record = InstalledRecord.Read(root);
                        if (record.InstallationId != installation.InstallationId || record.ActiveReleaseId != installation.ActiveReleaseId) code = "RECORD_CHANGED";
                        else
                        {
                            LeaseResult acquired = OperationLease.Acquire(record);
                            retainedLock = acquired.RetainedLock;
                            if (acquired.State != LeaseState.Acquired || acquired.Lease == null) code = acquired.Code ?? "LEASE";
                            else
                            {
                                lease = acquired.Lease;
                                code = Complete(record, lease, approvedLauncher, launcherSha, approvedUninstaller, uninstallerSha, id, ref launcherOutcome, ref uninstallerPlacement, ref journal);
                                ready = code == null || code == "BACKUP_RETAINED";
                            }
                        }
                    }
                }
            }
            catch (InstalledRecordException error) { code = error.Code; ready = false; }
            catch (Exception) { code = "IO"; ready = false; }
            finally
            {
                if (lease != null)
                {
                    try { released = lease.Release(); } catch (Exception) { released = new LeaseRelease(LeaseReleaseState.Unknown, "IO"); }
                    try { lease.Dispose(); } catch (Exception) { }
                    if (released.State != LeaseReleaseState.Released)
                    {
                        retainedLock = lease.Root + "\\" + InstalledRecord.LockName;
                        // Never Ready on an unconfirmed release; a primary failure stays the code.
                        if (ready) { ready = false; code = "LEASE"; }
                    }
                }
            }
            return new SetupCompletionOutcome(ready, code, root, id, launcherOutcome, uninstallerPlacement, journal,
                released == null ? (LeaseReleaseState?)null : released.State, released == null ? null : released.Code, retainedLock);
        }

        private static string Complete(InstalledRecordSnapshot record, OperationLease lease, byte[] launcher, string launcherSha, byte[] uninstaller, string uninstallerSha,
            string id, ref LauncherSetupOutcome launcherOutcome, ref OwnedFileResult uninstallerPlacement, ref OwnershipSave journal)
        {
            OwnershipRead ownership = SetupOwnership.Read(record, lease);
            if (ownership.State == OwnershipReadState.Kept || ownership.Snapshot == null)
                return ownership.Code == "RECORD_CHANGED" ? "RECORD_CHANGED" : "JOURNAL_" + ownership.Code;
            if (!InstalledRecord.StillCurrent(record, lease)) return "RECORD_CHANGED";

            // Launcher first, recorded under the lease before the uninstaller is touched.
            OwnedFileResult placed = OwnedFiles.Place(record.Root, SetupOwnership.LauncherName, launcher, launcherSha, ownership.Snapshot.Launcher);
            if (!Accepted(placed)) { launcherOutcome = new LauncherSetupOutcome(false, "PLACEMENT", record.Root, id, placed, null); return "LAUNCHER"; }
            journal = SetupOwnership.Save(ownership.Snapshot, placed.Descriptor, ownership.Snapshot.Uninstaller, lease);
            launcherOutcome = new LauncherSetupOutcome(Saved(journal), Saved(journal) ? null : "JOURNAL", record.Root, id, placed, journal);
            if (!Saved(journal)) return "LAUNCHER_JOURNAL";
            SetupOwnershipSnapshot afterLauncher = journal.Snapshot;
            if (!Fenced(record, lease, afterLauncher)) return "JOURNAL_CHANGED";

            // Then the uninstaller, keeping the launcher descriptor exactly as recorded.
            uninstallerPlacement = OwnedFiles.Place(record.Root, SetupOwnership.UninstallerName, uninstaller, uninstallerSha, afterLauncher.Uninstaller);
            if (!Accepted(uninstallerPlacement)) return "UNINSTALLER";
            OwnershipSave second = SetupOwnership.Save(afterLauncher, afterLauncher.Launcher, uninstallerPlacement.Descriptor, lease);
            journal = second;
            if (!Saved(second)) return "UNINSTALLER_JOURNAL";
            // The final journal must name exactly the issued launcher and uninstaller for the unchanged record.
            if (!Same(second.Snapshot.Launcher, placed.Descriptor) || !Same(second.Snapshot.Uninstaller, uninstallerPlacement.Descriptor) || !Fenced(record, lease, second.Snapshot))
                return "JOURNAL_CHANGED";
            return Retained(placed, launcherOutcome.Journal) || Retained(uninstallerPlacement, second) ? "BACKUP_RETAINED" : null;
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
