// Arcane setup stage selection and owned cleanup (C# 5, .NET Framework 4.x, no NuGet).
// Selection: the stage parent is the LONG canonical form of an existing directory (8.3 aliases expanded), so the
// bundled Node engine's realpath identity check sees the same path. Reservation names a fresh stage; PayloadArchive
// still creates it exclusively. Cleanup authority comes ONLY from the ownership a successful extraction recorded:
// unchanged owned files and empty owned directories are deleted through handles to the verified objects; added,
// changed, replaced, hardlinked or redirected entries are retained. Guarantees are cooperative against same-user races.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal sealed class StageException : Exception
    {
        public readonly string Code;
        public StageException(string code) : base("Arcane setup stage " + code + ".") { Code = code; }
    }

    internal sealed class StageCleanupReceipt
    {
        public readonly bool Complete, RootDeleted;
        public readonly int FilesDeleted, FilesRetained, DirectoriesDeleted, DirectoriesRetained;
        /// <summary>null when complete; otherwise RETAINED, ROOT_CHANGED, CONSUMED, NO_AUTHORITY or IO.</summary>
        public readonly string Code;
        internal StageCleanupReceipt(bool rootDeleted, int filesDeleted, int filesRetained, int directoriesDeleted, int directoriesRetained, string code)
        {
            RootDeleted = rootDeleted; FilesDeleted = filesDeleted; FilesRetained = filesRetained;
            DirectoriesDeleted = directoriesDeleted; DirectoriesRetained = directoriesRetained;
            Complete = code == null && rootDeleted && filesRetained == 0 && directoriesRetained == 0;
            Code = Complete ? null : code ?? "RETAINED";
        }
    }

    internal static class StageDirectory
    {
        internal const int MaxPathChars = 259, StageNameChars = 44, DefaultMaximumRelativePathChars = 134;
        private const string StagePrefix = "ArcaneSetup-";

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref byte deleteFile, uint size);
        private const int FileDispositionInfo = 4;

        private static StageException Fail(string code) { return new StageException(code); }

        /// <summary>Largest parent length that still fits parent + '\' + stage name + '\' + the longest payload path.</summary>
        internal static int MaximumParentChars(int maximumRelativePathChars)
        {
            if (maximumRelativePathChars < 1 || maximumRelativePathChars > MaxPathChars - StageNameChars - 2 - 3) throw Fail("PATH_TOO_LONG");
            return MaxPathChars - 1 - StageNameChars - 1 - maximumRelativePathChars;
        }

        public static string CanonicalTempParent() { return CanonicalTempParent(DefaultMaximumRelativePathChars); }
        public static string CanonicalTempParent(int maximumRelativePathChars) { return CanonicalParent(Path.GetTempPath(), maximumRelativePathChars); }
        public static string CanonicalParent(string candidate) { return CanonicalParent(candidate, DefaultMaximumRelativePathChars); }

        /// <summary>The long canonical form of an existing, drive-absolute, reparse-free directory within the path budget.</summary>
        public static string CanonicalParent(string candidate, int maximumRelativePathChars)
        {
            int limit = MaximumParentChars(maximumRelativePathChars);
            if (candidate == null || candidate.Length < 3 || candidate.Length > 4096 || !char.IsLetter(candidate[0]) || candidate[1] != ':' || candidate[2] != '\\') throw Fail("PATH");
            foreach (char c in candidate) if (c < 0x20 || c == 0x7f || c == '"' || c == '/' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') throw Fail("PATH");
            if (candidate.Substring(2).IndexOf(':') >= 0) throw Fail("PATH");
            string trimmed = candidate.TrimEnd('\\');
            if (trimmed.Length < 3) throw Fail("PATH"); // a volume root is never a stage parent
            StringBuilder buffer = new StringBuilder(1024);
            uint length = GetLongPathNameW(trimmed, buffer, (uint)buffer.Capacity);
            if (length == 0 || length >= buffer.Capacity) throw Fail("UNAVAILABLE");
            string canonical = buffer.ToString().TrimEnd('\\');
            string full;
            try { full = Path.GetFullPath(canonical); } catch (Exception) { throw Fail("PATH"); }
            if (canonical.Length < 4 || !string.Equals(full, canonical, StringComparison.Ordinal) || canonical.IndexOf('~') >= 0 && !SameLong(canonical)) throw Fail("PATH");
            AssertDirectChain(canonical);
            if (canonical.Length > limit) throw Fail("PATH_TOO_LONG");
            return canonical;
        }

        /// <summary>A '~' may be part of a real long name; it is accepted only when expansion is already a fixed point.</summary>
        private static bool SameLong(string path)
        {
            StringBuilder again = new StringBuilder(1024);
            uint length = GetLongPathNameW(path, again, (uint)again.Capacity);
            return length != 0 && length < again.Capacity && string.Equals(again.ToString().TrimEnd('\\'), path, StringComparison.Ordinal);
        }

        public static string Reserve(string canonicalParent) { return Reserve(canonicalParent, DefaultMaximumRelativePathChars); }

        /// <summary>Names a fresh stage under an already canonical parent; it is not created here (PayloadArchive creates it exclusively).</summary>
        public static string Reserve(string canonicalParent, int maximumRelativePathChars)
        {
            string parent = CanonicalParent(canonicalParent, maximumRelativePathChars);
            // The caller must pass the canonical result with the same budget; a different spelling is refused, never re-derived.
            if (!string.Equals(parent, canonicalParent, StringComparison.Ordinal)) throw Fail("PATH");
            string stage = parent + "\\" + StagePrefix + Guid.NewGuid().ToString("N");
            if (File.Exists(stage) || Directory.Exists(stage)) throw Fail("EXISTS");
            return stage;
        }

        private static void AssertDirectChain(string path)
        {
            for (string current = path; !string.IsNullOrEmpty(current); )
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(current); } catch (Exception) { throw Fail("UNAVAILABLE"); }
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw Fail("REPARSE");
                string next = Path.GetDirectoryName(current);
                if (next == null || next == current) break;
                current = next;
            }
        }

        /// <summary>Deletes what the given successful extraction created and is still unchanged. Consumes the authority once.
        /// Never throws for filesystem state; the installation outcome is never replaced by a cleanup result.</summary>
        public static StageCleanupReceipt Cleanup(PayloadReceipt extracted)
        {
            StageOwnership ownership = extracted == null ? null : extracted.Ownership;
            if (ownership == null) return new StageCleanupReceipt(false, 0, 0, 0, 0, "NO_AUTHORITY");
            lock (ownership) { if (ownership.Consumed) return new StageCleanupReceipt(false, 0, 0, 0, 0, "CONSUMED"); ownership.Consumed = true; }
            try { return new Session(ownership).Run(); }
            catch (Exception) { return new StageCleanupReceipt(false, 0, ownership.Files.Count, 0, ownership.Directories.Count, "IO"); }
        }

        private sealed class Session
        {
            private readonly StageOwnership own;
            private readonly Dictionary<string, SafeFileHandle> pins = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
            private readonly HashSet<string> broken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            private int filesDeleted, filesRetained, directoriesDeleted, directoriesRetained;

            public Session(StageOwnership ownership) { own = ownership; }

            public StageCleanupReceipt Run()
            {
                try
                {
                    // The root must still be the same real directory at the same long canonical path.
                    SafeFileHandle root;
                    if (!RootStillCanonical() || (root = Pin(own.Root, own.RootIdentity)) == null)
                        return new StageCleanupReceipt(false, 0, own.Files.Count, 0, own.Directories.Count, "ROOT_CHANGED");
                    pins[""] = root;
                    // Pin every owned directory top-down: handles without FILE_SHARE_DELETE keep each one from being renamed or replaced.
                    foreach (StageOwnership.OwnedDirectory directory in own.Directories)
                    {
                        SafeFileHandle pin = broken.Contains(Parent(directory.Relative)) ? null : Pin(own.Root + "\\" + directory.Relative, directory.Identity);
                        if (pin == null) broken.Add(directory.Relative); else pins[directory.Relative] = pin;
                    }
                    foreach (StageOwnership.OwnedFile file in own.Files)
                    {
                        if (!broken.Contains(Parent(file.Relative)) && DeleteFile(file)) filesDeleted++; else filesRetained++;
                    }
                    for (int i = own.Directories.Count - 1; i >= 0; i--)
                    {
                        StageOwnership.OwnedDirectory directory = own.Directories[i];
                        if (!broken.Contains(directory.Relative) && DeleteDirectory(directory.Relative, directory.Identity)) directoriesDeleted++; else directoriesRetained++;
                    }
                    bool rootDeleted = DeleteDirectory("", own.RootIdentity);
                    return new StageCleanupReceipt(rootDeleted, filesDeleted, filesRetained, directoriesDeleted, directoriesRetained, rootDeleted ? null : "RETAINED");
                }
                finally { foreach (SafeFileHandle pin in pins.Values) pin.Dispose(); pins.Clear(); }
            }

            private static string Parent(string relative) { int slash = relative.LastIndexOf('\\'); return slash < 0 ? "" : relative.Substring(0, slash); }

            /// <summary>The recorded parent still has the same long spelling and no redirected component. No budget applies here:
            /// the stage already exists, so only its identity matters.</summary>
            private bool RootStillCanonical()
            {
                string parent = Path.GetDirectoryName(own.Root);
                if (parent == null) return false;
                StringBuilder buffer = new StringBuilder(1024);
                uint length = GetLongPathNameW(parent, buffer, (uint)buffer.Capacity);
                if (length == 0 || length >= buffer.Capacity || !string.Equals(buffer.ToString().TrimEnd('\\'), parent, StringComparison.Ordinal)) return false;
                try { AssertDirectChain(parent); return true; } catch (StageException) { return false; }
            }

            /// <summary>Opens the directory entry itself with a deny-delete share mode and checks it is the recorded real directory.</summary>
            private static SafeFileHandle Pin(string path, FileIdentity expected)
            {
                SafeFileHandle handle = NativeFile.Open(path, NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite, true);
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (handle != null && NativeFile.Describe(handle, out identity, out attributes, out links, out size) && identity.SameAs(expected) &&
                    (attributes & FileAttributes.Directory) != 0 && (attributes & FileAttributes.ReparsePoint) == 0) return handle;
                if (handle != null) handle.Dispose();
                return null;
            }

            /// <summary>Deletes one owned file through the handle whose identity, link count, size and SHA-256 were just verified.</summary>
            private bool DeleteFile(StageOwnership.OwnedFile file)
            {
                SafeFileHandle handle = NativeFile.Open(own.Root + "\\" + file.Relative, NativeFile.GenericRead | NativeFile.Delete, NativeFile.ShareRead, false);
                if (handle == null) return false;
                using (FileStream stream = new FileStream(handle, FileAccess.Read, 81920, false))
                {
                    FileIdentity identity; FileAttributes attributes; uint links; long size;
                    if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size) || !identity.SameAs(file.Identity) || links != 1 ||
                        size != file.Bytes || (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
                    using (SHA256 sha = SHA256.Create())
                    {
                        byte[] buffer = new byte[81920]; long total = 0; int read;
                        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) { total += read; if (total > file.Bytes) return false; sha.TransformBlock(buffer, 0, read, null, 0); }
                        sha.TransformFinalBlock(new byte[0], 0, 0);
                        if (total != file.Bytes || !Same(sha.Hash, file.Sha256)) return false;
                    }
                    byte delete = 1;
                    return SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1);
                }
            }

            /// <summary>Releases this directory's own pin, reopens the entry itself, re-checks identity and deletes it only if empty.</summary>
            private bool DeleteDirectory(string relative, FileIdentity expected)
            {
                SafeFileHandle pin;
                if (pins.TryGetValue(relative, out pin)) { pin.Dispose(); pins.Remove(relative); }
                string path = relative.Length == 0 ? own.Root : own.Root + "\\" + relative;
                using (SafeFileHandle handle = NativeFile.Open(path, NativeFile.ReadAttributes | NativeFile.Delete, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, true))
                {
                    FileIdentity identity; FileAttributes attributes; uint links; long size;
                    if (handle == null || !NativeFile.Describe(handle, out identity, out attributes, out links, out size) || !identity.SameAs(expected) ||
                        (attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) return false;
                    byte delete = 1;
                    // Fails with ERROR_DIR_NOT_EMPTY when any retained or unknown entry remains.
                    return SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1);
                }
            }

            private static bool Same(byte[] a, byte[] b)
            {
                if (a == null || b == null || a.Length != b.Length) return false;
                int diff = 0; for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i]; return diff == 0;
            }
        }
    }
}
