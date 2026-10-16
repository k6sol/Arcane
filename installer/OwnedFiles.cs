// Ownership-aware placement of small setup files (launcher, uninstaller, journal) in a validated installation root
// (C# 5, .NET Framework 4.x, no NuGet). A file is replaced or removed only when a prior descriptor issued by this
// component still matches the root identity, the file identity, its size and its SHA-256, read through the handle that
// then renames or deletes it. Unrecorded, edited, replaced, hardlinked or redirected files are kept. Publication
// never overwrites a path: a fresh verified candidate is renamed by handle with ReplaceIfExists = FALSE into a
// pinned and rechecked root. A previous mapped image may remain in an explicit private backup. Ancestor races
// above the pinned root remain cooperative against other processes running as the same user.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum OwnedFileState { Placed, Unchanged, Replaced, Deleted, Absent, Kept, Refused, Unknown }

    /// <summary>Issued only after a verified placement; binds the root path and identity, the name, size, hash and file identity.</summary>
    internal sealed class OwnedFileDescriptor
    {
        public readonly string Root, Name, Sha256;
        public readonly long Bytes;
        internal readonly FileIdentity RootIdentity, Identity;
        internal OwnedFileDescriptor(string root, FileIdentity rootIdentity, string name, long bytes, string sha256, FileIdentity identity)
        {
            Root = root; RootIdentity = rootIdentity; Name = name; Bytes = bytes; Sha256 = sha256; Identity = identity;
        }
    }

    internal sealed class OwnedFileResult
    {
        public readonly OwnedFileState State;
        /// <summary>null, SOURCE, NAME, ROOT, UNRECORDED, CHANGED, LINKED, REDIRECT, IN_USE, TARGET_APPEARED, INTERRUPTED, BACKUP_RETAINED or IO.</summary>
        public readonly string Code;
        public readonly OwnedFileDescriptor Descriptor;
        /// <summary>A private copy of previously owned bytes left in the root when it could not be removed (never claimed as the original path).</summary>
        public readonly string RetainedBackup;
        internal OwnedFileResult(OwnedFileState state, string code, OwnedFileDescriptor descriptor, string retainedBackup)
        {
            State = state; Code = code; Descriptor = descriptor; RetainedBackup = retainedBackup;
        }
    }

    internal static class OwnedFiles
    {
        internal const long MaxBytes = 64L * 1024 * 1024;
        internal const int MaxNameChars = 100;
        /// <summary>Trusted observation seam for deterministic race fixtures; null in production and never set by setup code.</summary>
        internal static Action<string> Barrier;

        private const uint GenericWrite = 0x40000000, CreateNewDisposition = 1, OpenExistingDisposition = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
        private const int FileRenameInfo = 3, FileDispositionInfo = 4;
        private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3, ErrorSharingViolation = 32, ErrorFileExists = 80, ErrorAlreadyExists = 183;
        private static readonly Regex Hash = new Regex("^[a-f0-9]{64}$");
        private static readonly Regex Device = new Regex("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)", RegexOptions.IgnoreCase);
        private static readonly string[] EngineNames = { "installation.json", "installation.lock", "releases" };

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, IntPtr information, uint size);

        private static OwnedFileResult Result(OwnedFileState state, string code) { return new OwnedFileResult(state, code, null, null); }

        /// <summary>One safe component: engine path rules, no leading '~' (reserved for candidates/backups), not an engine-owned name.</summary>
        internal static bool SafeName(string name)
        {
            if (name == null || name.Length == 0 || name.Length > MaxNameChars || name[0] == '~' || name == "." || name == ".." ||
                name.EndsWith(".", StringComparison.Ordinal) || name.EndsWith(" ", StringComparison.Ordinal) || Device.IsMatch(name)) return false;
            foreach (char c in name) if (c == '\\' || c == '/' || c == ':' || c < 0x20 || c == 0x7f || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') return false;
            foreach (string reserved in EngineNames) if (string.Equals(name, reserved, StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        private static SafeFileHandle Open(string path, uint access, uint share, uint disposition, out int error)
        {
            SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, disposition, OpenReparsePoint, IntPtr.Zero);
            error = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
            if (handle.IsInvalid) { handle.Dispose(); return null; }
            return handle;
        }

        /// <summary>Pins the root: a handle without FILE_SHARE_DELETE keeps it from being renamed or replaced during the operation.</summary>
        private static SafeFileHandle PinRoot(string root, out FileIdentity identity)
        {
            identity = new FileIdentity();
            SafeFileHandle handle = CreateFileW(root, NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExistingDisposition, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); return null; }
            FileAttributes attributes; uint links; long size;
            if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size) || (attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
            { handle.Dispose(); return null; }
            return handle;
        }

        private static bool RootStill(string root, FileIdentity identity)
        {
            try { InstalledRecord.DirectChain(root); return InstalledRecord.Directory(root).SameAs(identity); }
            catch (Exception) { return false; }
        }

        private static string Sha(SafeFileHandle handle, long expected)
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 81920, false))
            using (SHA256 sha = SHA256.Create())
            {
                stream.Position = 0;
                byte[] buffer = new byte[81920]; long total = 0; int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) { total += read; if (total > expected) return null; sha.TransformBlock(buffer, 0, read, null, 0); }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return total == expected ? InstalledRecord.Hex(sha.Hash) : null;
            }
        }

        /// <summary>Renames the open file to <paramref name="name"/> in the pinned root, never replacing an existing entry.
        /// kernel32 refuses a RootDirectory handle for FileRenameInfo (ERROR_INVALID_PARAMETER), so the
        /// full root path is used; the root itself is pinned (not renameable) and re-checked by the caller just before.</summary>
        private static bool RenameWithin(SafeFileHandle file, string root, string name, out int error)
        {
            byte[] chars = Encoding.Unicode.GetBytes(root + "\\" + name);
            int handleOffset = IntPtr.Size, lengthOffset = handleOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
            int size = nameOffset + chars.Length + 2;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0); // ReplaceIfExists = FALSE, RootDirectory = NULL
                Marshal.WriteInt32(buffer, lengthOffset, chars.Length);
                Marshal.Copy(chars, 0, buffer + nameOffset, chars.Length);
                bool ok = SetFileInformationByHandle(file, FileRenameInfo, buffer, (uint)size);
                error = ok ? 0 : Marshal.GetLastWin32Error();
                return ok;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static bool DeleteThrough(SafeFileHandle handle)
        {
            IntPtr buffer = Marshal.AllocHGlobal(4);
            try { Marshal.WriteInt32(buffer, 0, 1); return SetFileInformationByHandle(handle, FileDispositionInfo, buffer, 1); }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        /// <summary>Classifies an entry that could not be opened as a file: a reparse point or directory is a redirect, never followed.</summary>
        private static string Unopened(string path, int error)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) return "REDIRECT";
            }
            catch (Exception) { }
            return error == ErrorSharingViolation ? "IN_USE" : "IO";
        }

        private static string Fresh(string prefix, string suffix) { return prefix + Guid.NewGuid().ToString("N") + suffix; }

        /// <summary>Checks an opened entry against an owned descriptor. Returns null when it matches, otherwise a fixed code.</summary>
        private static string Mismatch(SafeFileHandle handle, OwnedFileDescriptor owned)
        {
            FileIdentity identity; FileAttributes attributes; uint links; long size;
            if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size)) return "IO";
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) != 0) return "REDIRECT";
            if (links != 1) return "LINKED";
            if (!identity.SameAs(owned.Identity) || size != owned.Bytes || Sha(handle, owned.Bytes) != owned.Sha256) return "CHANGED";
            return null;
        }

        /// <summary>Places <paramref name="approvedBytes"/> as <paramref name="name"/> in the root, or replaces the file a matching
        /// <paramref name="prior"/> descriptor proves this component placed. Never throws.</summary>
        public static OwnedFileResult Place(string canonicalRoot, string name, byte[] approvedBytes, string approvedSha256, OwnedFileDescriptor prior)
        {
            try { return PlaceCore(canonicalRoot, name, approvedBytes, approvedSha256, prior); }
            catch (Exception) { return Result(OwnedFileState.Unknown, "IO"); }
        }

        private static OwnedFileResult PlaceCore(string canonicalRoot, string name, byte[] bytes, string sha, OwnedFileDescriptor prior)
        {
            if (!SafeName(name)) return Result(OwnedFileState.Refused, "NAME");
            string root;
            try { root = InstalledRecord.DirectRoot(canonicalRoot); } catch (Exception) { return Result(OwnedFileState.Refused, "ROOT"); }
            if (root.Length + 1 + Math.Max(name.Length, 48) > 259) return Result(OwnedFileState.Refused, "NAME");
            if (bytes == null || bytes.LongLength > MaxBytes || sha == null || !Hash.IsMatch(sha)) return Result(OwnedFileState.Refused, "SOURCE");
            using (SHA256 hash = SHA256.Create()) if (InstalledRecord.Hex(hash.ComputeHash(bytes)) != sha) return Result(OwnedFileState.Refused, "SOURCE");
            FileIdentity rootIdentity;
            using (SafeFileHandle pin = PinRoot(root, out rootIdentity))
            {
                if (pin == null || !RootStill(root, rootIdentity)) return Result(OwnedFileState.Refused, "ROOT");
                bool authorized = prior != null && string.Equals(prior.Root, root, StringComparison.Ordinal) && prior.RootIdentity.SameAs(rootIdentity) &&
                    string.Equals(prior.Name, name, StringComparison.Ordinal);
                string target = root + "\\" + name;
                int error;
                SafeFileHandle existing = Open(target, NativeFile.GenericRead | NativeFile.Delete, NativeFile.ShareRead, OpenExistingDisposition, out error);
                if (existing == null)
                {
                    if (error == ErrorFileNotFound || error == ErrorPathNotFound) return Publish(pin, root, rootIdentity, name, bytes, sha, null);
                    return Result(OwnedFileState.Kept, Unopened(target, error));
                }
                using (existing)
                {
                    if (!authorized) return Result(OwnedFileState.Kept, "UNRECORDED");
                    string mismatch = Mismatch(existing, prior);
                    if (mismatch != null) return Result(OwnedFileState.Kept, mismatch);
                    if (prior.Sha256 == sha && prior.Bytes == bytes.LongLength)
                        return new OwnedFileResult(OwnedFileState.Unchanged, null, new OwnedFileDescriptor(root, rootIdentity, name, prior.Bytes, prior.Sha256, prior.Identity), null);
                    return Publish(pin, root, rootIdentity, name, bytes, sha, existing);
                }
            }
        }

        /// <summary>Writes and verifies a candidate, then publishes it by handle without replacing anything. With a verified
        /// <paramref name="previous"/> handle, that file is first moved aside to a private backup and removed only after success.</summary>
        private static OwnedFileResult Publish(SafeFileHandle pin, string root, FileIdentity rootIdentity, string name, byte[] bytes, string sha, SafeFileHandle previous)
        {
            string candidateName = Fresh("~arcane-place-", ".tmp"), candidatePath = root + "\\" + candidateName;
            int error;
            SafeFileHandle candidate = Open(candidatePath, NativeFile.GenericRead | GenericWrite | NativeFile.Delete, NativeFile.ShareRead, CreateNewDisposition, out error);
            if (candidate == null) return Result(OwnedFileState.Unknown, "IO");
            using (candidate)
            {
                bool published = false, previousMoved = false;
                string backup = null;
                try
                {
                    using (FileStream stream = new FileStream(new SafeFileHandle(candidate.DangerousGetHandle(), false), FileAccess.ReadWrite, 81920, false))
                    { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                    FileIdentity identity; FileAttributes attributes; uint links; long size;
                    if (!NativeFile.Describe(candidate, out identity, out attributes, out links, out size) || links != 1 || size != bytes.LongLength ||
                        (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || Sha(candidate, bytes.LongLength) != sha)
                        return Result(OwnedFileState.Unknown, "IO");
                    if (previous != null)
                    {
                        // The verified previous file leaves the path only through its own handle; nothing else is overwritten.
                        backup = Fresh("~arcane-backup-", ".old");
                        if (Barrier != null) Barrier("before-aside");
                        if (!RootStill(root, rootIdentity)) return Result(OwnedFileState.Kept, "ROOT");
                        if (!RenameWithin(previous, root, backup, out error)) return Result(OwnedFileState.Kept, "IN_USE");
                        previousMoved = true;
                        if (Barrier != null) Barrier("after-aside");
                    }
                    else if (Barrier != null) Barrier("before-publish");
                    if (!RootStill(root, rootIdentity) || !RenameWithin(candidate, root, name, out error))
                    {
                        // Something else now occupies (or redirected) the path; it is never touched.
                        if (previous == null) return Result(OwnedFileState.Kept, error == ErrorAlreadyExists || error == ErrorFileExists ? "TARGET_APPEARED" : "ROOT");
                        return new OwnedFileResult(OwnedFileState.Unknown, "INTERRUPTED", null, root + "\\" + backup);
                    }
                    published = true;
                    // The path must now resolve to exactly this verified file.
                    FileIdentity after; uint afterLinks;
                    if (!NativeFile.Describe(candidate, out after, out attributes, out afterLinks, out size) || !after.SameAs(identity) || afterLinks != 1 || Sha(candidate, bytes.LongLength) != sha || !Resolves(root + "\\" + name, identity))
                        return new OwnedFileResult(OwnedFileState.Unknown, "IO", null, backup == null ? null : root + "\\" + backup);
                    OwnedFileDescriptor descriptor = new OwnedFileDescriptor(root, rootIdentity, name, bytes.LongLength, sha, identity);
                    if (previous == null) return new OwnedFileResult(OwnedFileState.Placed, null, descriptor, null);
                    // The old bytes are deleted only through the handle that verified them; a mapped (running) image may refuse.
                    return DeleteThrough(previous) ? new OwnedFileResult(OwnedFileState.Replaced, null, descriptor, null)
                        : new OwnedFileResult(OwnedFileState.Replaced, "BACKUP_RETAINED", descriptor, root + "\\" + backup);
                }
                catch (Exception) { return new OwnedFileResult(OwnedFileState.Unknown, "IO", null, previousMoved ? root + "\\" + backup : null); }
                finally { if (!published) { try { DeleteThrough(candidate); } catch (Exception) { /* Keep the primary placement outcome. */ } } }
            }
        }

        private static bool Resolves(string path, FileIdentity expected)
        {
            int error;
            using (SafeFileHandle handle = Open(path, NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, OpenExistingDisposition, out error))
            {
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                return handle != null && NativeFile.Describe(handle, out identity, out attributes, out links, out size) && identity.SameAs(expected) &&
                    (attributes & FileAttributes.ReparsePoint) == 0;
            }
        }

        /// <summary>Deletes only the unchanged file <paramref name="owned"/> describes, through the handle that verified it. Never throws.</summary>
        public static OwnedFileResult Remove(OwnedFileDescriptor owned)
        {
            try
            {
                if (owned == null || !SafeName(owned.Name)) return Result(OwnedFileState.Refused, "NAME");
                string root;
                try { root = InstalledRecord.DirectRoot(owned.Root); } catch (Exception) { return Result(OwnedFileState.Kept, "ROOT"); }
                FileIdentity rootIdentity;
                using (SafeFileHandle pin = PinRoot(root, out rootIdentity))
                {
                    if (pin == null || !rootIdentity.SameAs(owned.RootIdentity) || !RootStill(root, rootIdentity)) return Result(OwnedFileState.Kept, "ROOT");
                    int error;
                    SafeFileHandle handle = Open(root + "\\" + owned.Name, NativeFile.GenericRead | NativeFile.Delete, NativeFile.ShareRead, OpenExistingDisposition, out error);
                    if (handle == null)
                        return error == ErrorFileNotFound || error == ErrorPathNotFound ? Result(OwnedFileState.Absent, null) : Result(OwnedFileState.Kept, Unopened(root + "\\" + owned.Name, error));
                    using (handle)
                    {
                        string mismatch = Mismatch(handle, owned);
                        if (mismatch != null) return Result(OwnedFileState.Kept, mismatch);
                        return DeleteThrough(handle) ? Result(OwnedFileState.Deleted, null) : Result(OwnedFileState.Kept, "IN_USE");
                    }
                }
            }
            catch (Exception) { return Result(OwnedFileState.Unknown, "IO"); }
        }
    }
}
