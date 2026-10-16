// Consent-bound removal of a recorded Arcane installation (C# 5, .NET Framework 4.x, no NuGet). Requires the real
// UninstallAuthorization issued by the confirmation dialog, the exact snapshot that was displayed and a live OperationLease
// acquired here. Removes each recorded release (ReleaseRemoval), then the journal-owned shortcut only in the current
// host-authorized Programs directory, then the journal-owned root launcher and uninstaller
// (OwnedFiles), then the unchanged journal, then installation.json LAST, then the observed releases container and root only
// when they are empty. Profiles, unlisted, manual and sibling content are never recursively deleted. Synchronous: it never
// prompts, starts or stops a process, waits, retries, rolls back, schedules a delete or rewrites the record.
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum UninstallState { Removed, Partial, Refused, Cancelled, Unknown }
    internal enum UninstallPhase { Acquire, Consume, Activity, Releases, Registration, Shortcut, RootFiles, Journal, Record, ReleasesDirectory, Lease, RootDirectory, Done }
    internal enum ContainerOutcome { NotReached, Deleted, Absent, Kept }
    internal enum MetadataOutcome { NotReached, Deleted, Kept, Unknown }

    /// <summary>One bounded progress report: at most one per phase plus one per recorded release.</summary>
    internal sealed class UninstallProgress
    {
        public readonly UninstallPhase Phase;
        public readonly int Index, Count;
        internal UninstallProgress(UninstallPhase phase, int index, int count) { Phase = phase; Index = index; Count = count; }
    }

    /// <summary>Immutable copy of one ReleaseRemovalResult.</summary>
    internal sealed class ReleaseOutcome
    {
        public readonly string ReleaseId, Code;
        public readonly RemovalState State;
        public readonly ExecutableOutcome Executable;
        public readonly int FilesListed, FilesDeleted, FilesAbsent, FilesKept, DirectoriesDeleted, DirectoriesKept;
        public readonly bool ManifestDeleted, ReleaseDirectoryDeleted;
        internal ReleaseOutcome(ReleaseRemovalResult r)
        {
            ReleaseId = r.ReleaseId; Code = r.Code; State = r.State; Executable = r.Executable; FilesListed = r.FilesListed; FilesDeleted = r.FilesDeleted;
            FilesAbsent = r.FilesAbsent; FilesKept = r.FilesKept; DirectoriesDeleted = r.DirectoriesDeleted; DirectoriesKept = r.DirectoriesKept;
            ManifestDeleted = r.ManifestDeleted; ReleaseDirectoryDeleted = r.ReleaseDirectoryDeleted;
        }
        internal bool Mutated
        {
            get { return Executable == ExecutableOutcome.Deleted || FilesDeleted > 0 || DirectoriesDeleted > 0 || ManifestDeleted || ReleaseDirectoryDeleted || State == RemovalState.Unknown; }
        }
    }

    /// <summary>Immutable outcome. Every known counter and phase result is kept, including through exceptions; null and
    /// NotReached mean the step was never reached, never that it succeeded.</summary>
    internal sealed class UninstallResult
    {
        public readonly UninstallState State;
        /// <summary>null, CONSENT, CONSUMED, LEASE, LOCKED, RECORD_CHANGED, JOURNAL_CHANGED, PATH, BUSY, ACTIVITY, RELEASE, ROOT_FILE,
        /// SHORTCUT_ROOT, SHORTCUT, JOURNAL, RECORD, CONTAINER, CANCELLED or IO.</summary>
        public readonly string Code;
        public readonly UninstallPhase StoppedAt;
        /// <summary>True once installation content was (or may have been) deleted. Never implies rollback.</summary>
        public readonly bool Mutated, CancelRequested;
        public readonly LeaseState? Acquisition;
        public readonly string AcquisitionCode, RetainedLock;
        /// <summary>The single TryConsume outcome code (null when it succeeded; null with Consumed false when never reached).</summary>
        public readonly bool Consumed;
        public readonly string ConsentCode;
        public readonly ActivityState? Activity;
        public readonly string ActivityCode;
        public readonly int ActivityPaths, ActivityUsers;
        public readonly bool JournalPresent;
        public readonly ReadOnlyCollection<ReleaseOutcome> Releases;
        public readonly OwnedFileResult Launcher, Uninstaller, Shortcut, Journal;
        public readonly RegistrationResult Registration;
        public readonly MetadataOutcome Record;
        public readonly string RecordCode;
        public readonly ContainerOutcome ReleasesDirectory, RootDirectory;
        public readonly string ReleasesDirectoryCode, RootDirectoryCode;
        public readonly LeaseReleaseState? LeaseCleanup;
        public readonly string LeaseCleanupCode;

        internal UninstallResult(UninstallTransaction.Progress p)
        {
            State = p.State; Code = p.Code; StoppedAt = p.Phase; Mutated = p.Mutated; CancelRequested = p.CancelRequested;
            Acquisition = p.Acquisition; AcquisitionCode = p.AcquisitionCode; RetainedLock = p.RetainedLock; Consumed = p.Consumed; ConsentCode = p.ConsentCode;
            Activity = p.Activity; ActivityCode = p.ActivityCode; ActivityPaths = p.ActivityPaths; ActivityUsers = p.ActivityUsers; JournalPresent = p.JournalPresent;
            Releases = new List<ReleaseOutcome>(p.Releases).AsReadOnly(); Launcher = p.Launcher; Uninstaller = p.Uninstaller; Shortcut = p.Shortcut; Journal = p.Journal; Registration = p.Registration;
            Record = p.Record; RecordCode = p.RecordCode; ReleasesDirectory = p.ReleasesDirectory; ReleasesDirectoryCode = p.ReleasesDirectoryCode;
            RootDirectory = p.RootDirectory; RootDirectoryCode = p.RootDirectoryCode; LeaseCleanup = p.LeaseCleanup; LeaseCleanupCode = p.LeaseCleanupCode;
        }
    }

    internal static class UninstallTransaction
    {
        private const uint OpenExisting = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000, InvalidAttributes = 0xFFFFFFFF;
        private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3, ErrorSharingViolation = 32, ErrorDirNotEmpty = 145, FileDispositionInfo = 4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref byte deleteFile, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string path);

        /// <summary>Mutable accumulator, private to one Run; the caller only ever sees the immutable UninstallResult.</summary>
        internal sealed class Progress
        {
            internal UninstallState State = UninstallState.Refused;
            internal string Code;
            internal UninstallPhase Phase = UninstallPhase.Acquire;
            internal bool CancelRequested, Consumed, JournalPresent;
            internal LeaseState? Acquisition;
            internal string AcquisitionCode, RetainedLock, ConsentCode, ActivityCode, RecordCode, ReleasesDirectoryCode, RootDirectoryCode, LeaseCleanupCode;
            internal ActivityState? Activity;
            internal int ActivityPaths, ActivityUsers;
            internal readonly List<ReleaseOutcome> Releases = new List<ReleaseOutcome>();
            internal OwnedFileResult Launcher, Uninstaller, Shortcut, Journal;
            internal RegistrationResult Registration;
            internal MetadataOutcome Record = MetadataOutcome.NotReached;
            internal ContainerOutcome ReleasesDirectory = ContainerOutcome.NotReached, RootDirectory = ContainerOutcome.NotReached;
            internal LeaseReleaseState? LeaseCleanup;
            internal bool Mutated
            {
                get
                {
                    if (Record == MetadataOutcome.Deleted || Record == MetadataOutcome.Unknown || Registration != null && (Registration.State == RegistrationState.Deleted || Registration.State == RegistrationState.Unknown)) return true;
                    foreach (ReleaseOutcome r in Releases) if (r.Mutated) return true;
                    foreach (OwnedFileResult f in new[] { Launcher, Uninstaller, Shortcut, Journal })
                        if (f != null && (f.State == OwnedFileState.Deleted || f.State == OwnedFileState.Unknown)) return true;
                    return false;
                }
            }
        }

        /// <summary>Thrown internally to end the transaction at a decided outcome (never escapes Run).</summary>
        private sealed class Stop : Exception { }

        /// <summary>Removes the displayed, consented installation. Never throws, never prompts, never starts or stops a process,
        /// never waits or retries. <paramref name="progress"/> (may be null) is called synchronously; its exceptions are ignored.</summary>
        public static UninstallResult Run(InstalledRecordSnapshot displayed, UninstallAuthorization authorization, CancellationToken cancel, Action<UninstallProgress> progress)
        { return RunBound(displayed, authorization, cancel, progress, null, null); }

        /// <summary>Trusted host port for an explicitly supplied Programs directory. No CLI input selects this destination.</summary>
        internal static UninstallResult RunForPrograms(InstalledRecordSnapshot displayed, UninstallAuthorization authorization, CancellationToken cancel, Action<UninstallProgress> progress, string programsRoot)
        { return RunBound(displayed, authorization, cancel, progress, programsRoot, null); }

        /// <summary>Trusted owned-fixture host port; production resolves its fixed current-user registration destination.</summary>
        internal static UninstallResult RunForTargets(InstalledRecordSnapshot displayed, UninstallAuthorization authorization, CancellationToken cancel, Action<UninstallProgress> progress, string programsRoot, RegistrationTarget registrationTarget)
        { return RunBound(displayed, authorization, cancel, progress, programsRoot, registrationTarget); }

        private static UninstallResult RunBound(InstalledRecordSnapshot displayed, UninstallAuthorization authorization, CancellationToken cancel, Action<UninstallProgress> progress, string programsRoot, RegistrationTarget registrationTarget)
        {
            Progress p = new Progress();
            OperationLease lease = null;
            InstalledRecordSnapshot bound = null;
            try
            {
                Execute(displayed, authorization, cancel, progress, p, ref lease, ref bound, programsRoot, registrationTarget);
            }
            catch (Stop) { }
            catch (Exception)
            {
                // Known fields stay; the outcome becomes Unknown rather than a claim of completeness or of no change.
                p.State = UninstallState.Unknown; p.Code = "IO";
            }
            finally
            {
                if (lease != null) Cleanup(p, lease, bound, displayed);
            }
            if (cancel.IsCancellationRequested) p.CancelRequested = true;
            return new UninstallResult(p);
        }

        private static void Execute(InstalledRecordSnapshot displayed, UninstallAuthorization authorization, CancellationToken cancel, Action<UninstallProgress> progress,
            Progress p, ref OperationLease lease, ref InstalledRecordSnapshot bound, string programsRoot, RegistrationTarget registrationTarget)
        {
            // Arguments and binding to what was displayed: a mismatched or missing consent never acquires a lease. A supplied
            // authorization is burned either way.
            p.Phase = UninstallPhase.Acquire;
            if (authorization == null || displayed == null || displayed.Active == null || authorization.InstallationId != displayed.InstallationId ||
                !string.Equals(authorization.Root, displayed.Root, StringComparison.Ordinal) || !authorization.RootIdentity.SameAs(displayed.RootIdentity) ||
                authorization.RecordSha256 != displayed.RecordSha256 || !authorization.RecordIdentity.SameAs(displayed.RecordIdentity) ||
                authorization.ActiveReleaseId != displayed.ActiveReleaseId)
            {
                Burn(p, authorization);
                End(p, UninstallState.Refused, "CONSENT");
            }

            Report(progress, UninstallPhase.Acquire, 0, 1);
            LeaseResult acquired = OperationLease.Acquire(displayed);
            p.Acquisition = acquired.State; p.AcquisitionCode = acquired.Code; p.RetainedLock = acquired.RetainedLock;
            if (acquired.State != LeaseState.Acquired || acquired.Lease == null)
            {
                Burn(p, authorization);
                // The primary lock/change failure is preserved; the burned authorization's own code stays in ConsentCode.
                End(p, acquired.State == LeaseState.Unknown ? UninstallState.Unknown : UninstallState.Refused, acquired.Code ?? "LEASE");
            }
            lease = acquired.Lease;

            p.Phase = UninstallPhase.Consume;
            Report(progress, UninstallPhase.Consume, 0, 1);
            ConsentConsume consumed = authorization.TryConsume(lease);
            p.Consumed = true; p.ConsentCode = consumed.Code;
            if (!consumed.Ok || consumed.Record == null || consumed.Journal == null) End(p, UninstallState.Refused, consumed.Code ?? "CONSENT");
            bound = consumed.Record;
            SetupOwnershipSnapshot journal = consumed.Journal;
            p.JournalPresent = journal.Present;
            string root = bound.Root, releases = root + "\\releases";
            // The releases container is only ever removed as the identity observed before any mutation; one that appears later is never adopted.
            FileIdentity releasesIdentity = new FileIdentity();
            bool releasesObserved = false;
            FileAttributes? releasesAttributes = Attributes(releases);
            if (releasesAttributes.HasValue)
            {
                if ((releasesAttributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != FileAttributes.Directory || !DirectoryIdentity(releases, out releasesIdentity))
                    End(p, UninstallState.Refused, "PATH");
                releasesObserved = true;
            }

            p.Phase = UninstallPhase.Activity;
            Checkpoint(p, cancel);
            Report(progress, UninstallPhase.Activity, 0, 1);
            Fence(p, bound, journal, false, lease);
            Preflight(p, bound, journal);

            p.Phase = UninstallPhase.Releases;
            List<InstalledRelease> order = new List<InstalledRelease>();
            foreach (InstalledRelease release in bound.Releases) if (release.Id != bound.ActiveReleaseId) order.Add(release);
            order.Add(bound.Active);
            for (int i = 0; i < order.Count; i++)
            {
                Checkpoint(p, cancel);
                Report(progress, UninstallPhase.Releases, i, order.Count);
                Fence(p, bound, journal, false, lease);
                ReleaseOutcome outcome = new ReleaseOutcome(ReleaseRemoval.Remove(bound, order[i].Id, lease));
                p.Releases.Add(outcome);
                if (outcome.State == RemovalState.Removed || outcome.State == RemovalState.Absent) continue;
                End(p, outcome.State == RemovalState.Unknown ? UninstallState.Unknown : p.Mutated ? UninstallState.Partial : UninstallState.Refused, "RELEASE");
            }

            if (journal.Registration != null || journal.PendingRegistration != null)
            {
                p.Phase = UninstallPhase.Registration;
                Checkpoint(p, cancel);
                Report(progress, UninstallPhase.Registration, 0, 1);
                Checkpoint(p, cancel);
                Fence(p, bound, journal, false, lease);
                RegistrationTarget target = registrationTarget;
                bool ownTarget = false;
                try
                {
                    if (target == null) { target = RegistrationTarget.CurrentUser(false); ownTarget = true; }
                }
                catch (Exception) { p.Registration = new RegistrationResult(RegistrationState.Kept, "TARGET", null, false, 0); }
                try
                {
                    if (target != null) p.Registration = RegistrationStore.Remove(journal.Registration, journal.PendingRegistration, bound.InstallationId, target);
                }
                finally { if (ownTarget && target != null) target.Dispose(); }
                if (p.Registration != null && p.Registration.State == RegistrationState.Unknown) End(p, UninstallState.Unknown, "REGISTRATION");
                // Only an observed edit relinquishes registration ownership. An unreadable or unbound destination
                // keeps the journal and root tools so a later, freshly consented operation can resolve it.
                if (p.Registration != null && p.Registration.State == RegistrationState.Kept && p.Registration.Code != "CHANGED")
                    End(p, Stopped(p), "REGISTRATION");
            }

            // The recorded application and external shortcut have separate ownership. A changed external
            // folder or link is kept and reported; it cannot revoke authority over the recorded application.
            // Wait until releases are removed so an earlier stop retains the existing launch entry.
            if (journal.Shortcut != null)
            {
                p.Phase = UninstallPhase.Shortcut;
                Checkpoint(p, cancel);
                Report(progress, UninstallPhase.Shortcut, 0, 1);
                Checkpoint(p, cancel);
                Fence(p, bound, journal, false, lease);
                bool authorizedRoot = false;
                try
                {
                    string programs = InstalledRecord.DirectRoot(programsRoot ?? Environment.GetFolderPath(Environment.SpecialFolder.Programs));
                    authorizedRoot = journal.Shortcut.Root == programs && InstalledRecord.Directory(programs).SameAs(journal.Shortcut.RootIdentity);
                }
                catch (Exception) { }
                p.Shortcut = authorizedRoot ? OwnedFiles.Remove(journal.Shortcut) : new OwnedFileResult(OwnedFileState.Kept, "ROOT", null, null);
                if (p.Shortcut.State == OwnedFileState.Unknown) End(p, UninstallState.Unknown, "SHORTCUT");
            }

            // Only after every recorded release is Removed or Absent: the journal-owned root launcher, then uninstaller.
            p.Phase = UninstallPhase.RootFiles;
            Checkpoint(p, cancel);
            Report(progress, UninstallPhase.RootFiles, 0, 2);
            if (journal.Present)
            {
                if (journal.Launcher != null)
                {
                    Fence(p, bound, journal, false, lease);
                    p.Launcher = OwnedFiles.Remove(journal.Launcher);
                    RootFileOk(p, p.Launcher);
                }
                if (journal.Uninstaller != null)
                {
                    Fence(p, bound, journal, false, lease);
                    p.Uninstaller = OwnedFiles.Remove(journal.Uninstaller);
                    RootFileOk(p, p.Uninstaller);
                }

                // Then only the unchanged observed journal; afterwards its expected absence replaces the earlier binding.
                p.Phase = UninstallPhase.Journal;
                Checkpoint(p, cancel);
                Report(progress, UninstallPhase.Journal, 0, 1);
                Fence(p, bound, journal, false, lease);
                p.Journal = OwnedFiles.Remove(journal.Journal);
                if (p.Journal.State == OwnedFileState.Unknown) End(p, UninstallState.Unknown, "JOURNAL");
                // A bound journal that vanished on its own was not removed by this transaction: it is never claimed.
                if (p.Journal.State != OwnedFileState.Deleted) End(p, Stopped(p), "JOURNAL");
            }

            // installation.json LAST, through a private same-handle verifier/deleter bound to the live lease.
            p.Phase = UninstallPhase.Record;
            Checkpoint(p, cancel);
            Report(progress, UninstallPhase.Record, 0, 1);
            Fence(p, bound, journal, true, lease);
            string recordCode;
            p.Record = DeleteRecord(bound, lease, out recordCode); p.RecordCode = recordCode;
            if (p.Record == MetadataOutcome.Unknown) End(p, UninstallState.Unknown, "RECORD");
            if (p.Record != MetadataOutcome.Deleted) End(p, Stopped(p), "RECORD");

            // The record is gone: the remaining cleanup always completes (a late cancellation cannot imply an untouched record).
            p.State = UninstallState.Removed; p.Code = null;
            p.Phase = UninstallPhase.ReleasesDirectory;
            Report(progress, UninstallPhase.ReleasesDirectory, 0, 1);
            if (!releasesObserved)
            {
                // Never adopt a container that appeared after the start.
                if (Attributes(releases).HasValue) { p.ReleasesDirectory = ContainerOutcome.Kept; p.ReleasesDirectoryCode = "APPEARED"; }
                else p.ReleasesDirectory = ContainerOutcome.Absent;
            }
            else if (!lease.Proves(root, bound.RootIdentity)) { p.ReleasesDirectory = ContainerOutcome.Kept; p.ReleasesDirectoryCode = "LEASE"; }
            else
            {
                string code;
                p.ReleasesDirectory = DeleteEmptyDirectory(releases, releasesIdentity, out code); p.ReleasesDirectoryCode = code;
            }
            p.Phase = UninstallPhase.Done;
        }

        /// <summary>Releases exactly the issued lease on every handled terminal path, then (only after a deleted record and a
        /// released lease) removes the empty observed root. The primary outcome is preserved; cleanup results stay separate.</summary>
        private static void Cleanup(Progress p, OperationLease lease, InstalledRecordSnapshot bound, InstalledRecordSnapshot displayed)
        {
            LeaseRelease released;
            try { released = lease.Release(); } catch (Exception) { released = new LeaseRelease(LeaseReleaseState.Unknown, "IO"); }
            try { lease.Dispose(); } catch (Exception) { }
            p.LeaseCleanup = released.State; p.LeaseCleanupCode = released.Code;
            if (released.State != LeaseReleaseState.Released) p.RetainedLock = lease.Root + "\\" + InstalledRecord.LockName;
            if (p.State != UninstallState.Removed) return;
            // Removed is claimed only with every recorded item gone AND the exact lease released.
            if (released.State != LeaseReleaseState.Released)
            {
                p.State = released.State == LeaseReleaseState.Unknown ? UninstallState.Unknown : UninstallState.Partial; p.Code = "LEASE"; p.Phase = UninstallPhase.Lease;
                return;
            }
            try
            {
                string code;
                p.RootDirectory = DeleteEmptyDirectory(lease.Root, (bound ?? displayed).RootIdentity, out code); p.RootDirectoryCode = code;
            }
            catch (Exception) { p.RootDirectory = ContainerOutcome.Kept; p.RootDirectoryCode = "IO"; }
            // Deliberately kept unknown/manual content (NOT_EMPTY) is not a failure; any other container failure is reported as Partial.
            if (p.ReleasesDirectory == ContainerOutcome.Kept && p.ReleasesDirectoryCode != "NOT_EMPTY" ||
                p.RootDirectory == ContainerOutcome.Kept && p.RootDirectoryCode != "NOT_EMPTY")
            { p.State = UninstallState.Partial; p.Code = "CONTAINER"; }
        }

        private static void End(Progress p, UninstallState state, string code) { p.State = state; p.Code = code; throw new Stop(); }

        private static UninstallState Stopped(Progress p) { return p.Mutated ? UninstallState.Partial : UninstallState.Refused; }

        private static void Burn(Progress p, UninstallAuthorization authorization)
        {
            if (authorization == null) return;
            ConsentConsume burned = authorization.TryConsume(null);
            p.Consumed = true; p.ConsentCode = burned.Code;
        }

        private static void Report(Action<UninstallProgress> progress, UninstallPhase phase, int index, int count)
        {
            if (progress == null) return;
            try { progress(new UninstallProgress(phase, index, count)); } catch (Exception) { }
        }

        /// <summary>Cooperative cancellation between phases only: before content changes it is Cancelled, afterwards Partial.</summary>
        private static void Checkpoint(Progress p, CancellationToken cancel)
        {
            if (!cancel.IsCancellationRequested) return;
            p.CancelRequested = true;
            End(p, p.Mutated ? UninstallState.Partial : UninstallState.Cancelled, "CANCELLED");
        }

        private static void RootFileOk(Progress p, OwnedFileResult result)
        {
            if (result.State == OwnedFileState.Deleted || result.State == OwnedFileState.Absent) return;
            // Changed, unrecorded or in use (including a still-mapped uninstaller): kept, and the journal and record stay.
            End(p, result.State == OwnedFileState.Unknown ? UninstallState.Unknown : Stopped(p), "ROOT_FILE");
        }

        /// <summary>Fresh leased re-read: the record must still be the bound one, and the journal must still be the bound journal
        /// (or, once this transaction removed it, absent). Nothing is adopted.</summary>
        private static void Fence(Progress p, InstalledRecordSnapshot bound, SetupOwnershipSnapshot journal, bool journalGone, OperationLease lease)
        {
            InstalledRecordSnapshot current;
            try { current = InstalledRecord.Read(bound.Root, lease); }
            catch (Exception) { End(p, Stopped(p), "RECORD_CHANGED"); return; }
            if (!current.RootIdentity.SameAs(bound.RootIdentity) || !current.RecordIdentity.SameAs(bound.RecordIdentity) || current.RecordSha256 != bound.RecordSha256 ||
                current.InstallationId != bound.InstallationId || current.ActiveReleaseId != bound.ActiveReleaseId) End(p, Stopped(p), "RECORD_CHANGED");
            OwnershipRead read = SetupOwnership.Read(current, lease);
            if (read.State == OwnershipReadState.Kept || read.Snapshot == null) End(p, Stopped(p), "JOURNAL_CHANGED");
            bool expectAbsent = journalGone || !journal.Present;
            if (expectAbsent) { if (read.Snapshot.Present) End(p, Stopped(p), "JOURNAL_CHANGED"); return; }
            if (!read.Snapshot.Present || read.Snapshot.Journal.Bytes != journal.Journal.Bytes || read.Snapshot.Journal.Sha256 != journal.Journal.Sha256 ||
                !read.Snapshot.Journal.Identity.SameAs(journal.Journal.Identity)) End(p, Stopped(p), "JOURNAL_CHANGED");
        }

        /// <summary>Known activity on every existing fixed owned executable (each recorded release's Arcane.exe and node.exe, and the
        /// journal-owned root launcher and uninstaller) refuses before anything is deleted. Parents are validated before probing;
        /// queries run in batches of at most InstallationActivity.MaxPaths. Count-only; never enumerates processes.</summary>
        private static void Preflight(Progress p, InstalledRecordSnapshot bound, SetupOwnershipSnapshot journal)
        {
            List<string> paths = new List<string>();
            string releases = bound.Root + "\\releases";
            if (Attributes(releases).HasValue)
            {
                if (!RealDirectory(releases)) Refuse(p, "REDIRECT");
                foreach (InstalledRelease release in bound.Releases)
                {
                    string directory = releases + "\\" + release.Id;
                    if (!Attributes(directory).HasValue) continue;
                    if (!RealDirectory(directory)) Refuse(p, "REDIRECT");
                    Watch(p, paths, directory + "\\Arcane.exe");
                    string resources = directory + "\\resources", node = resources + "\\node";
                    if (!Attributes(resources).HasValue) continue;
                    if (!RealDirectory(resources)) Refuse(p, "REDIRECT");
                    if (!Attributes(node).HasValue) continue;
                    if (!RealDirectory(node)) Refuse(p, "REDIRECT");
                    Watch(p, paths, node + "\\node.exe");
                }
            }
            if (journal.Present && journal.Launcher != null) Watch(p, paths, bound.Root + "\\" + SetupOwnership.LauncherName);
            if (journal.Present && journal.Uninstaller != null) Watch(p, paths, bound.Root + "\\" + SetupOwnership.UninstallerName);
            p.ActivityPaths = paths.Count; p.ActivityUsers = 0;
            for (int start = 0; start < paths.Count; start += InstallationActivity.MaxPaths)
            {
                string[] batch = paths.GetRange(start, Math.Min(InstallationActivity.MaxPaths, paths.Count - start)).ToArray();
                ActivityResult activity = InstallationActivity.Inspect(batch);
                p.Activity = activity.State; p.ActivityCode = activity.Code;
                if (activity.State == ActivityState.Busy) { p.ActivityUsers += activity.Users; End(p, UninstallState.Refused, "BUSY"); }
                if (activity.State != ActivityState.Idle) End(p, UninstallState.Refused, "ACTIVITY");
            }
            p.Activity = ActivityState.Idle;
        }

        private static void Refuse(Progress p, string activityCode) { p.Activity = ActivityState.Unknown; p.ActivityCode = activityCode; End(p, UninstallState.Refused, "ACTIVITY"); }

        private static void Watch(Progress p, List<string> paths, string path)
        {
            FileAttributes? attributes = Attributes(path);
            if (!attributes.HasValue) return;
            if ((attributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) Refuse(p, "REDIRECT");
            string canonical;
            try { canonical = SetupPath.CanonicalExecutable(path); } catch (Exception) { Refuse(p, "PATH"); return; }
            if (!string.Equals(canonical, path, StringComparison.Ordinal)) Refuse(p, "PATH");
            paths.Add(path);
        }

        /// <summary>Deletes installation.json through one handle that denies writers and deleters: the held bytes, size, single
        /// link and identity must equal the leased record, the live lease must still prove the same root, and the journal must
        /// be absent. No re-open or delete by path; absence is observed after the handle closes.</summary>
        private static MetadataOutcome DeleteRecord(InstalledRecordSnapshot bound, OperationLease lease, out string code)
        {
            string root = bound.Root, path = root + "\\" + InstalledRecord.RecordName;
            code = null;
            using (SafeFileHandle pin = CreateFileW(root, NativeFile.ListDirectory | NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero))
            {
                FileIdentity rootIdentity; FileAttributes rootAttributes; uint rootLinks; long rootSize;
                if (pin.IsInvalid || !NativeFile.Describe(pin, out rootIdentity, out rootAttributes, out rootLinks, out rootSize) ||
                    (rootAttributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory || !rootIdentity.SameAs(bound.RootIdentity))
                { code = "ROOT"; return MetadataOutcome.Kept; }
                SafeFileHandle handle = CreateFileW(path, NativeFile.GenericRead | NativeFile.Delete, NativeFile.ShareRead, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);
                if (handle.IsInvalid)
                {
                    int error = Marshal.GetLastWin32Error(); handle.Dispose();
                    // A record that vanished was not removed by this transaction: never claimed.
                    code = error == ErrorFileNotFound || error == ErrorPathNotFound ? "CHANGED" : error == ErrorSharingViolation ? "IN_USE" : "IO";
                    return code == "CHANGED" ? MetadataOutcome.Unknown : MetadataOutcome.Kept;
                }
                bool deleted;
                using (handle)
                {
                    FileIdentity identity; FileAttributes attributes; uint links; long size;
                    if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size) || (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                        links != 1 || !identity.SameAs(lease.RecordIdentity) || !identity.SameAs(bound.RecordIdentity) || size != bound.RecordBytes ||
                        Sha(handle, size) != lease.RecordSha256 || lease.RecordSha256 != bound.RecordSha256)
                    { code = "CHANGED"; return MetadataOutcome.Kept; }
                    // Final proof immediately before the intentional last delete: the exact live lock on the same pinned root, and no journal.
                    if (!lease.Proves(root, rootIdentity)) { code = "LEASE"; return MetadataOutcome.Kept; }
                    if (Attributes(root + "\\" + SetupOwnership.JournalName).HasValue) { code = "JOURNAL"; return MetadataOutcome.Kept; }
                    byte delete = 1;
                    deleted = SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1);
                    if (!deleted) { int error = Marshal.GetLastWin32Error(); code = error == ErrorSharingViolation ? "IN_USE" : "IO"; return MetadataOutcome.Kept; }
                }
                if (Attributes(path).HasValue) { code = "IO"; return MetadataOutcome.Unknown; }
                return MetadataOutcome.Deleted;
            }
        }

        /// <summary>Removes a directory only when it is the observed identity, a real directory and EMPTY: NTFS's own refusal of a
        /// non-empty directory at disposition time is the authority. Identity is checked before classifying retained content.</summary>
        private static ContainerOutcome DeleteEmptyDirectory(string path, FileIdentity expected, out string code)
        {
            code = null;
            FileAttributes? attributes = Attributes(path);
            if (!attributes.HasValue) return ContainerOutcome.Absent;
            if ((attributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != FileAttributes.Directory) { code = "REDIRECT"; return ContainerOutcome.Kept; }
            try { InstalledRecord.DirectChain(path); } catch (Exception) { code = "REDIRECT"; return ContainerOutcome.Kept; }
            SafeFileHandle handle = CreateFileW(path, NativeFile.ReadAttributes | NativeFile.Delete, NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                if (error == ErrorFileNotFound || error == ErrorPathNotFound) { code = "CHANGED"; return ContainerOutcome.Kept; }
                code = error == ErrorSharingViolation ? "IN_USE" : "IO"; return ContainerOutcome.Kept;
            }
            using (handle)
            {
                FileIdentity identity; FileAttributes current; uint links; long size;
                if (!NativeFile.Describe(handle, out identity, out current, out links, out size) || (current & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory ||
                    !identity.SameAs(expected)) { code = "CHANGED"; return ContainerOutcome.Kept; }
                byte delete = 1;
                if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1))
                {
                    int error = Marshal.GetLastWin32Error();
                    code = error == ErrorDirNotEmpty ? "NOT_EMPTY" : error == ErrorSharingViolation ? "IN_USE" : "IO";
                    return ContainerOutcome.Kept;
                }
            }
            if (Attributes(path).HasValue) { code = "IO"; return ContainerOutcome.Kept; }
            return ContainerOutcome.Deleted;
        }

        /// <summary>Attributes of the entry itself; null only when it or a parent is absent. Any other failure is an existing,
        /// unusable entry (reported as a reparse point so it is never treated as absent or followed).</summary>
        private static FileAttributes? Attributes(string path)
        {
            uint value = GetFileAttributesW(path);
            if (value != InvalidAttributes) return (FileAttributes)value;
            int error = Marshal.GetLastWin32Error();
            return error == ErrorFileNotFound || error == ErrorPathNotFound ? (FileAttributes?)null : FileAttributes.ReparsePoint;
        }

        private static bool RealDirectory(string path)
        {
            FileAttributes? attributes = Attributes(path);
            return attributes.HasValue && (attributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == FileAttributes.Directory;
        }

        private static bool DirectoryIdentity(string path, out FileIdentity identity)
        {
            identity = new FileIdentity();
            using (SafeFileHandle handle = NativeFile.Open(path, NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, true))
            {
                FileAttributes attributes; uint links; long size;
                return handle != null && NativeFile.Describe(handle, out identity, out attributes, out links, out size) &&
                    (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == FileAttributes.Directory;
            }
        }

        private static string Sha(SafeFileHandle handle, long expected)
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
            using (SHA256 sha = SHA256.Create())
            {
                stream.Position = 0;
                byte[] buffer = new byte[4096]; long total = 0; int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) { total += read; if (total > expected) return null; sha.TransformBlock(buffer, 0, read, null, 0); }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return total == expected ? InstalledRecord.Hex(sha.Hash) : null;
            }
        }
    }
}
