// Manifest-bound removal of ONE recorded release under a live operation lease (C# 5, .NET Framework 4.x, kernel32 only).
// The release is chosen only by id from the leased record snapshot; its manifest (pinned to the record entry hash) is the
// only inventory. Files are deleted only through the handle that verified their manifest size, SHA-256, single link and
// non-reparse kind; the release Arcane.exe goes first, so a partially removed release is never launchable. The manifest
// carries sizes and hashes, NOT historical file identities, so this is weaker than OwnedFiles' identity binding.
// Unknown content, other releases, installation.json, setup-ownership.json, root launcher/uninstaller and profiles are
// never touched; the lease is never released here. Guarantees are cooperative against same-user processes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum RemovalState { Removed, Partial, Retained, Absent, Refused, Unknown }
    internal enum ExecutableOutcome { NotReached, Deleted, Absent, Kept }

    internal sealed class ReleaseRemovalResult
    {
        public RemovalState State { get; internal set; }
        /// <summary>null, LEASE, RECORD, MANIFEST, BUSY, ACTIVITY, EXECUTABLE_CHANGED, EXECUTABLE_IN_USE, REDIRECT, CHANGED or IO.</summary>
        public string Code { get; internal set; }
        public string ReleaseId { get; internal set; }
        public ExecutableOutcome Executable { get; internal set; }
        public int FilesListed { get; internal set; }
        public int FilesDeleted { get; internal set; }
        public int FilesAbsent { get; internal set; }
        public int FilesKept { get; internal set; }
        public int DirectoriesDeleted { get; internal set; }
        public int DirectoriesKept { get; internal set; }
        public bool ManifestDeleted { get; internal set; }
        public bool ReleaseDirectoryDeleted { get; internal set; }
    }

    internal static class ReleaseRemoval
    {
        /// <summary>Trusted observation seam for deterministic race fixtures; null in production and never set by setup code.</summary>
        internal static Action<string> Barrier;
        private const uint OpenExisting = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
        private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3, ErrorSharingViolation = 32, FileDispositionInfo = 4;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref byte deleteFile, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string path);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FindData
        {
            public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string Alternate;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindFirstFileExW(string path, int infoLevel, out FindData data, int searchOp, IntPtr filter, int flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool FindNextFileW(IntPtr find, out FindData data);
        [DllImport("kernel32.dll")]
        private static extern bool FindClose(IntPtr find);
        private const uint InvalidAttributes = 0xFFFFFFFF;

        // Internal descendants of an admitted release can legitimately exceed the legacy MAX_PATH (the engine installs them).
        // Every path below is built only from the already admitted canonical drive root, the fixed releases/<id> names and
        // validated manifest components, so it is converted to the Win32 extended form ONLY at native call sites. No caller
        // input is newly accepted, and .NET Framework path APIs (which are MAX_PATH bound) are not used for descendants.
        private static string Extended(string path) { return path.StartsWith("\\\\?\\", StringComparison.Ordinal) ? path : "\\\\?\\" + path; }

        private static SafeFileHandle OpenEntry(string path, uint access, uint share, bool directory, out int error)
        {
            SafeFileHandle handle = CreateFileW(Extended(path), access, share, IntPtr.Zero, OpenExisting, OpenReparsePoint | (directory ? BackupSemantics : 0), IntPtr.Zero);
            error = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
            if (handle.IsInvalid) { handle.Dispose(); return null; }
            return handle;
        }

        /// <summary>Attributes of the entry itself (never followed); null only when the entry or a parent is absent.
        /// Any other failure is reported as an existing, unusable entry so it is never treated as absent.</summary>
        private static FileAttributes? Attributes(string path)
        {
            uint value = GetFileAttributesW(Extended(path));
            if (value != InvalidAttributes) return (FileAttributes)value;
            int error = Marshal.GetLastWin32Error();
            return error == ErrorFileNotFound || error == ErrorPathNotFound ? (FileAttributes?)null : FileAttributes.ReparsePoint;
        }

        private static bool Exists(string path) { return Attributes(path).HasValue; }

        /// <summary>Parent of an admitted internal path by its last separator. .NET Framework's Path.GetDirectoryName throws for
        /// paths beyond MAX_PATH; these paths are already canonical (no '/', '.' or '..' components), so plain splitting is exact.</summary>
        private static string ParentOf(string path)
        {
            int slash = path.LastIndexOf('\\');
            return slash <= 2 ? null : path.Substring(0, slash);
        }

        /// <summary>Identity of a real directory entry (not a reparse point), through a handle to the entry itself.</summary>
        private static bool DirectoryIdentity(string path, out FileIdentity identity)
        {
            identity = new FileIdentity(); int error;
            using (SafeFileHandle handle = OpenEntry(path, NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, true, out error))
            {
                FileAttributes attributes; uint links; long size;
                return handle != null && NativeFile.Describe(handle, out identity, out attributes, out links, out size) &&
                    (attributes & FileAttributes.Directory) != 0 && (attributes & FileAttributes.ReparsePoint) == 0;
            }
        }

        /// <summary>Bounded, non-recursive listing of a directory's direct children (stops after two names; never opens or follows them).
        /// Returns -1 when the directory cannot be listed.</summary>
        private static int DirectChildren(string directory, out string onlyName)
        {
            onlyName = null; FindData data;
            IntPtr find = FindFirstFileExW(Extended(directory) + "\\*", 1 /* FindExInfoBasic */, out data, 0, IntPtr.Zero, 0);
            if (find == new IntPtr(-1)) return -1;
            try
            {
                int count = 0;
                do
                {
                    if (data.Name == "." || data.Name == "..") continue;
                    if (++count == 1) onlyName = data.Name;
                    if (count > 1) return count;
                }
                while (FindNextFileW(find, out data));
                return Marshal.GetLastWin32Error() == 18 /* ERROR_NO_MORE_FILES */ ? count : -1;
            }
            finally { FindClose(find); }
        }

        /// <summary>Removes the recorded release <paramref name="recordedReleaseId"/> of the leased <paramref name="snapshot"/>. Never throws.</summary>
        public static ReleaseRemovalResult Remove(InstalledRecordSnapshot snapshot, string recordedReleaseId, OperationLease lease)
        {
            ReleaseRemovalResult result = new ReleaseRemovalResult();
            result.ReleaseId = recordedReleaseId; result.Executable = ExecutableOutcome.NotReached; result.State = RemovalState.Refused;
            Dictionary<string, SafeFileHandle> pins = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
            try { Run(snapshot, recordedReleaseId, lease, result, pins); }
            catch (Exception)
            {
                // Counters gathered so far stay; the outcome becomes Unknown rather than a claim of completeness.
                result.State = RemovalState.Unknown; result.Code = "IO";
            }
            finally { foreach (SafeFileHandle pin in pins.Values) pin.Dispose(); pins.Clear(); }
            // A pending directory deletion completes when its handle closes: Removed is claimed only once the release is actually gone.
            try
            {
                if (result.State == RemovalState.Removed && Exists(snapshot.Root + "\\releases\\" + recordedReleaseId))
                { result.State = RemovalState.Unknown; result.Code = "IO"; result.ReleaseDirectoryDeleted = false; }
            }
            catch (Exception) { if (result.State == RemovalState.Removed) { result.State = RemovalState.Unknown; result.Code = "IO"; } }
            return result;
        }

        private static void Stop(ReleaseRemovalResult result, RemovalState state, string code) { result.State = state; result.Code = code; }

        private static void Run(InstalledRecordSnapshot snapshot, string id, OperationLease lease, ReleaseRemovalResult result, Dictionary<string, SafeFileHandle> pins)
        {
            if (snapshot == null || lease == null || !InstalledRecord.StillCurrent(snapshot, lease)) { Stop(result, RemovalState.Refused, "LEASE"); return; }
            InstalledRelease release = null;
            foreach (InstalledRelease candidate in snapshot.Releases) if (string.Equals(candidate.Id, id, StringComparison.Ordinal)) release = candidate;
            if (release == null) { Stop(result, RemovalState.Refused, "RECORD"); return; }
            string releases = snapshot.Root + "\\releases", directory = releases + "\\" + release.Id;
            // The releases parent chain is validated first: a junction is never followed, not even to report Absent.
            if (!Exists(releases)) { Stop(result, RemovalState.Absent, null); return; }
            try { InstalledRecord.DirectChain(releases); } catch (InstalledRecordException) { Stop(result, RemovalState.Retained, "REDIRECT"); return; }
            FileAttributes? releaseAttributes = Attributes(directory);
            if (!releaseAttributes.HasValue) { Stop(result, RemovalState.Absent, null); return; }
            if ((releaseAttributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != FileAttributes.Directory) { Stop(result, RemovalState.Retained, "REDIRECT"); return; }

            // Preflight: the whole pinned inventory is admitted before anything is deleted.
            ReleaseManifest manifest;
            try { manifest = InstalledRecord.ReadManifest(snapshot, release); }
            catch (InstalledRecordException) { Stop(result, RemovalState.Refused, "MANIFEST"); return; }
            result.FilesListed = manifest.Files.Count;
            // The dedicated executable phase and the remaining-file loop must agree on the exact entry.
            // Match the launcher's canonical name rule before any deletion, rather than processing an alias twice.
            ManifestFile executable = manifest.Find("Arcane.exe");
            if (executable == null || executable.Path != "Arcane.exe") { Stop(result, RemovalState.Refused, "MANIFEST"); return; }
            List<string> derived = DerivedDirectories(manifest);
            if (derived == null) { Stop(result, RemovalState.Refused, "MANIFEST"); return; }

            // Pin the root (no delete right) and, with ReadAttributes|DELETE, the release directory and every existing derived
            // directory. ListDirectory access with no FILE_SHARE_DELETE: none can be renamed or replaced; each is later deleted through this same pin.
            // The releases parent may change between the chain check and pinning: a fixed refusal, never an exception path.
            FileIdentity releasesIdentity;
            if (!DirectoryIdentity(releases, out releasesIdentity)) { Stop(result, RemovalState.Retained, "CHANGED"); return; }
            if (!Pin(pins, snapshot.Root, snapshot.RootIdentity, false) || !Pin(pins, releases, releasesIdentity, false) ||
                !Pin(pins, directory, manifest.DirectoryIdentity, true)) { Stop(result, RemovalState.Retained, "CHANGED"); return; }
            Dictionary<string, FileIdentity> identities = new Dictionary<string, FileIdentity>(StringComparer.OrdinalIgnoreCase);
            foreach (string relative in derived)
            {
                string full = directory + "\\" + relative.Replace('/', '\\');
                if (!Exists(full)) continue;
                FileIdentity identity;
                if (!DirectoryIdentity(full, out identity)) { Stop(result, RemovalState.Retained, "REDIRECT"); return; }
                if (!Pin(pins, full, identity, true)) { Stop(result, RemovalState.Retained, "CHANGED"); return; }
                identities[full] = identity;
            }

            // Known activity on the release's executables keeps everything; Idle is only a snapshot, never authority.
            List<string> watched = new List<string>();
            foreach (string name in new[] { "Arcane.exe", "resources\\node\\node.exe" })
            {
                string path = directory + "\\" + name;
                FileAttributes? watchedAttributes = Attributes(path);
                if (!watchedAttributes.HasValue) continue;
                if ((watchedAttributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                {
                    if (name == "Arcane.exe") { result.Executable = ExecutableOutcome.Kept; result.FilesKept++; }
                    Stop(result, RemovalState.Retained, "REDIRECT"); return;
                }
                watched.Add(path);
            }
            if (watched.Count > 0)
            {
                ActivityResult activity = InstallationActivity.Inspect(watched.ToArray());
                if (activity.State == ActivityState.Busy) { Stop(result, RemovalState.Retained, "BUSY"); return; }
                if (activity.State != ActivityState.Idle) { Stop(result, RemovalState.Retained, "ACTIVITY"); return; }
            }

            if (Barrier != null) Barrier("before-executable");
            if (!InstalledRecord.StillCurrent(snapshot, lease)) { Stop(result, RemovalState.Retained, "LEASE"); return; }
            string executableCode = DeleteVerified(directory + "\\Arcane.exe", executable.Bytes, executable.Sha256, pins, snapshot.Root);
            if (executableCode == "ABSENT") result.Executable = ExecutableOutcome.Absent;
            else if (executableCode == null) { result.Executable = ExecutableOutcome.Deleted; result.FilesDeleted++; }
            else
            {
                // Nothing else is touched while the launch target cannot be removed.
                result.Executable = ExecutableOutcome.Kept; result.FilesKept++;
                Stop(result, RemovalState.Retained, executableCode == "CHANGED" ? "EXECUTABLE_CHANGED" : executableCode == "REDIRECT" ? "REDIRECT" : "EXECUTABLE_IN_USE");
                return;
            }
            if (result.Executable == ExecutableOutcome.Absent) result.FilesAbsent++;

            if (Barrier != null) Barrier("before-files");
            foreach (ManifestFile file in manifest.Files)
            {
                if (string.Equals(file.Path, "Arcane.exe", StringComparison.Ordinal)) continue;
                if (!InstalledRecord.StillCurrent(snapshot, lease)) { Finish(result, "LEASE"); return; }
                string code = DeleteVerified(directory + "\\" + file.Path.Replace('/', '\\'), file.Bytes, file.Sha256, pins, snapshot.Root);
                if (code == null) result.FilesDeleted++; else if (code == "ABSENT") result.FilesAbsent++; else result.FilesKept++;
            }

            if (Barrier != null) Barrier("before-directories");
            // Deepest first; a directory goes only when it is the pinned identity and empty.
            derived.Sort(delegate(string a, string b) { return b.Split('/').Length.CompareTo(a.Split('/').Length); });
            foreach (string relative in derived)
            {
                string full = directory + "\\" + relative.Replace('/', '\\');
                FileIdentity identity;
                if (!identities.TryGetValue(full, out identity)) continue; // never existed in this run: nothing to remove
                if (!InstalledRecord.StillCurrent(snapshot, lease)) { Finish(result, "LEASE"); return; }
                if (DeleteDirectory(pins, full, identity, snapshot.Root)) result.DirectoriesDeleted++; else result.DirectoriesKept++;
            }

            if (result.FilesKept == 0 && result.DirectoriesKept == 0 && result.FilesDeleted + result.FilesAbsent == result.FilesListed)
            {
                if (!InstalledRecord.StillCurrent(snapshot, lease)) { Finish(result, "LEASE"); return; }
                // Unknown entries at the release root also need the manifest retained for a later explicit cleanup.
                string only;
                if (DirectChildren(directory, out only) != 1 || !string.Equals(only, InstalledRecord.ManifestName, StringComparison.OrdinalIgnoreCase))
                { Finish(result, "CHANGED"); return; }
                string manifestCode = DeleteVerifiedBytes(directory + "\\" + InstalledRecord.ManifestName, manifest.ManifestSha256, pins, snapshot.Root);
                result.ManifestDeleted = manifestCode == null;
                if (result.ManifestDeleted && DeleteDirectory(pins, directory, manifest.DirectoryIdentity, snapshot.Root)) result.ReleaseDirectoryDeleted = true;
            }
            Finish(result, null);
        }

        private static void Finish(ReleaseRemovalResult result, string code)
        {
            result.Code = code;
            if (code == null && result.ReleaseDirectoryDeleted) result.State = RemovalState.Removed;
            else result.State = result.FilesDeleted + result.DirectoriesDeleted > 0 || result.ManifestDeleted ? RemovalState.Partial : RemovalState.Retained;
            if (result.State == RemovalState.Retained && code == null) result.Code = "CHANGED";
        }

        /// <summary>Every proper ancestor directory of a listed file (relative, '/'-separated). Refuses case or file/directory collisions.</summary>
        private static List<string> DerivedDirectories(ReleaseManifest manifest)
        {
            HashSet<string> files = new HashSet<string>(StringComparer.OrdinalIgnoreCase), directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, string> spelling = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (ManifestFile file in manifest.Files)
            {
                if (!files.Add(file.Path)) return null;
                string[] parts = file.Path.Split('/');
                string prefix = "";
                for (int i = 0; i < parts.Length - 1; i++)
                {
                    prefix = i == 0 ? parts[0] : prefix + "/" + parts[i];
                    string existing;
                    if (spelling.TryGetValue(prefix, out existing) && !string.Equals(existing, prefix, StringComparison.Ordinal)) return null; // case-variant directory
                    spelling[prefix] = prefix;
                    if (directories.Add(prefix) && directories.Count > MaxDerivedDirectories) return null;
                }
            }
            foreach (string directory in directories) if (files.Contains(directory)) return null; // a path is both a file and a directory
            // Explicit bound before any directory is pinned: file count and depth alone could derive far more handles.
            if (directories.Count > MaxDerivedDirectories) return null;
            return new List<string>(directories);
        }

        internal const int MaxDerivedDirectories = 32768;

        private static bool Pin(Dictionary<string, SafeFileHandle> pins, string path, FileIdentity expected, bool deletable)
        {
            SafeFileHandle handle = CreateFileW(Extended(path), NativeFile.ListDirectory | NativeFile.ReadAttributes | (deletable ? NativeFile.Delete : 0), NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            FileIdentity identity; FileAttributes attributes; uint links; long size;
            if (handle.IsInvalid || !NativeFile.Describe(handle, out identity, out attributes, out links, out size) || !identity.SameAs(expected) ||
                (attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) { handle.Dispose(); return false; }
            pins[path] = handle;
            return true;
        }

        /// <summary>Deletes one listed file through the handle that verified it. Returns null (deleted), ABSENT, CHANGED, REDIRECT or IN_USE.</summary>
        private static string DeleteVerified(string path, long bytes, string sha256, Dictionary<string, SafeFileHandle> pins, string root)
        {
            string parentState = ParentsCurrent(pins, path, root);
            if (parentState != null) return parentState;
            int error;
            SafeFileHandle handle = OpenEntry(path, NativeFile.GenericRead | NativeFile.Delete, NativeFile.ShareRead, false, out error);
            if (handle == null)
            {
                if (error == ErrorFileNotFound || error == ErrorPathNotFound) return "ABSENT";
                FileAttributes? attributes = Attributes(path);
                if (attributes.HasValue && (attributes.Value & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) return "REDIRECT";
                return "IN_USE";
            }
            using (handle)
            {
                parentState = ParentsCurrent(pins, path, root);
                if (parentState != null) return parentState;
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size)) return "IN_USE";
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) return "REDIRECT";
                // A negative expected size means "the size observed through this verifying handle" (the manifest, pinned by hash).
                long expected = bytes < 0 ? size : bytes;
                if (bytes < 0 && (expected < 0 || expected > InstalledRecord.ManifestMaxBytes)) return "CHANGED";
                if (links != 1 || size != expected || Sha(handle, expected) != sha256) return "CHANGED";
                byte delete = 1;
                return SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1) ? null : "IN_USE";
            }
        }

        /// <summary>The manifest: same verified same-handle delete, its bytes pinned to the record entry hash.</summary>
        private static string DeleteVerifiedBytes(string path, string sha256, Dictionary<string, SafeFileHandle> pins, string root)
        {
            string parentState = ParentsCurrent(pins, path, root);
            if (parentState != null) return parentState;
            return DeleteVerified(path, -1, sha256, pins, root);
        }

        // Verify each ancestor from the pinned root downward. A directory absent at admission is never adopted later,
        // even if a newly created file beneath it happens to match the manifest's bytes.
        private static string ParentsCurrent(Dictionary<string, SafeFileHandle> pins, string path, string root)
        {
            List<string> ancestors = new List<string>();
            for (string parent = ParentOf(path); !string.IsNullOrEmpty(parent); parent = ParentOf(parent))
            { ancestors.Add(parent); if (string.Equals(parent, root, StringComparison.Ordinal)) break; }
            if (ancestors.Count == 0 || !string.Equals(ancestors[ancestors.Count - 1], root, StringComparison.Ordinal)) return "CHANGED";
            for (int i = ancestors.Count - 1; i >= 0; i--)
            {
                SafeFileHandle pin; bool observed = pins.TryGetValue(ancestors[i], out pin);
                int error;
                using (SafeFileHandle reader = OpenEntry(ancestors[i], NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, true, out error))
                {
                    if (reader == null)
                    {
                        return !observed && (error == ErrorFileNotFound || error == ErrorPathNotFound) ? "ABSENT" : "CHANGED";
                    }
                    FileIdentity expected, actual; FileAttributes a, b; uint links; long size;
                    if (!observed || !NativeFile.Describe(pin, out expected, out a, out links, out size) ||
                        !NativeFile.Describe(reader, out actual, out b, out links, out size) || !expected.SameAs(actual) ||
                        (a & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory ||
                        (b & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory) return "CHANGED";
                }
            }
            return null;
        }

        /// <summary>Deletes a directory through its own verified pin (never released and reopened), only if it is still the pinned
        /// identity and empty. The pin is closed right after a successful disposition so its parent can become empty in turn.</summary>
        private static bool DeleteDirectory(Dictionary<string, SafeFileHandle> pins, string path, FileIdentity expected, string root)
        {
            if (ParentsCurrent(pins, path, root) != null) return false;
            SafeFileHandle pin;
            if (!pins.TryGetValue(path, out pin)) return false;
            FileIdentity identity; FileAttributes attributes; uint links; long size;
            if (!NativeFile.Describe(pin, out identity, out attributes, out links, out size) || !identity.SameAs(expected) ||
                (attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) return false;
            byte delete = 1;
            // Fails with ERROR_DIR_NOT_EMPTY while any retained or unknown entry remains.
            if (!SetFileInformationByHandle(pin, FileDispositionInfo, ref delete, 1)) return false;
            pin.Dispose(); pins.Remove(path);
            return !Exists(path);
        }

        private static string Sha(SafeFileHandle handle, long expected)
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 81920, false))
            using (SHA256 sha = SHA256.Create())
            {
                byte[] buffer = new byte[81920]; long total = 0; int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) { total += read; if (total > expected) return null; sha.TransformBlock(buffer, 0, read, null, 0); }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return total == expected ? InstalledRecord.Hex(sha.Hash) : null;
            }
        }
    }
}
