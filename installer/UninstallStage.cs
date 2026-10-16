// Stages only the journal-owned uninstaller into a fresh temporary container (C# 5, .NET Framework 4.x, no NuGet).
// Copying is not permission to uninstall: the staged host must still ask for consent. This component never executes the
// copy, never adopts an existing directory, never overwrites, never retries and never removes anything recursively.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum UninstallStageState { Prepared, Refused, Unknown }
    internal enum StageDirectoryOutcome { NotReached, Deleted, Kept, Unknown }
    internal enum UninstallPinState { Pinned, Refused }

    internal sealed class UninstallStageResult
    {
        public readonly UninstallStageState State;
        /// <summary>null, SOURCE, SOURCE_CHANGED, PARENT, STAGE, STAGE_CHANGED or IO.</summary>
        public readonly string Code;
        public readonly UninstallStage Stage;
        /// <summary>Set when a container this attempt created could not be proven removed: it stays on disk and is reported.</summary>
        public readonly string RetainedDirectory;
        /// <summary>The single own-cleanup attempt after a failed preparation (null when none was needed).</summary>
        public readonly UninstallStageCleanup Cleanup;
        internal UninstallStageResult(UninstallStageState state, string code, UninstallStage stage, string retained, UninstallStageCleanup cleanup)
        { State = state; Code = code; Stage = stage; RetainedDirectory = retained; Cleanup = cleanup; }
    }

    internal sealed class UninstallStageCleanup
    {
        public readonly bool Complete;
        /// <summary>null, CONSUMED, PINNED, the copy's OwnedFiles code, or the directory code.</summary>
        public readonly string Code;
        /// <summary>The copy's removal result, kept even when the directory step later fails (null when not attempted).</summary>
        public readonly OwnedFileResult File;
        public readonly StageDirectoryOutcome Directory;
        /// <summary>null, NOT_EMPTY, CHANGED, IN_USE or IO.</summary>
        public readonly string DirectoryCode;
        internal UninstallStageCleanup(bool complete, string code, OwnedFileResult file, StageDirectoryOutcome directory, string directoryCode)
        { Complete = complete; Code = code; File = file; Directory = directory; DirectoryCode = directoryCode; }
    }

    internal sealed class UninstallStagePinResult
    {
        public readonly UninstallPinState State;
        /// <summary>null, CONSUMED, PINNED, SOURCE_CHANGED, STAGE_CHANGED, COPY_CHANGED or IO.</summary>
        public readonly string Code;
        public readonly UninstallStagePin Pin;
        internal UninstallStagePinResult(UninstallPinState state, string code, UninstallStagePin pin) { State = state; Code = code; Pin = pin; }
    }

    /// <summary>Holds the verified copy (no writer, deleter or rename) and its container (no delete or rename) until disposed.</summary>
    internal sealed class UninstallStagePin : IDisposable
    {
        public readonly string Executable, TargetRoot;
        private readonly object gate = new object();
        private SafeFileHandle file, directory;
        internal UninstallStagePin(string executable, string root, SafeFileHandle fileHandle, SafeFileHandle directoryHandle)
        { Executable = executable; TargetRoot = root; file = fileHandle; directory = directoryHandle; }
        public bool Live { get { lock (gate) return file != null && !file.IsClosed && directory != null && !directory.IsClosed; } }
        public void Dispose()
        {
            lock (gate)
            {
                if (file != null) { file.Dispose(); file = null; }
                if (directory != null) { directory.Dispose(); directory = null; }
            }
        }
    }

    internal sealed class UninstallStage
    {
        public readonly string Directory, Executable, TargetRoot;
        internal readonly OwnedFileDescriptor File;
        private readonly FileIdentity directoryIdentity;
        private readonly InstalledRecordSnapshot sourceRecord;
        private readonly SetupOwnershipSnapshot sourceOwnership;
        private readonly object gate = new object();
        private bool consumed;
        private UninstallStagePin issued;
        /// <summary>Trusted fixture observation only ("created", "placed"); null in production.</summary>
        internal static Action<string> Barrier;

        // A handle with only FILE_READ_ATTRIBUTES/SYNCHRONIZE takes no part in sharing checks, so it would NOT stop a rename or delete.
        // Every pin therefore also holds FILE_LIST_DIRECTORY, and shares read/write but never delete.
        private const uint FileListDirectory = 0x1, FileTraverse = 0x20, Synchronize = 0x100000, ObjCaseInsensitive = 0x40;
        private const uint FileCreate = 2, FileDirectoryFile = 0x1, FileSynchronousIoNonalert = 0x20, FileOpenReparsePoint = 0x200000;
        private const uint OpenExisting = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000, InvalidAttributes = 0xFFFFFFFF;
        private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3, ErrorSharingViolation = 32, ErrorDirNotEmpty = 145, FileDispositionInfo = 4;

        [StructLayout(LayoutKind.Sequential)]
        private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoStatusBlock { public IntPtr Status, Information; }
        [DllImport("ntdll.dll")]
        private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatusBlock status, IntPtr allocationSize,
            uint fileAttributes, uint share, uint disposition, uint options, IntPtr eaBuffer, uint eaLength);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, ref byte delete, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string path);

        private UninstallStage(string directory, FileIdentity identity, OwnedFileDescriptor file, InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership)
        { Directory = directory; directoryIdentity = identity; File = file; Executable = directory + "\\" + file.Name; TargetRoot = record.Root; sourceRecord = record; sourceOwnership = ownership; }

        /// <summary>Fails closed: the record is still current (bytes, identity, root, no running operation) and a fresh journal read
        /// still names exactly the same journal and uninstaller.</summary>
        private static bool Current(InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership)
        {
            try
            {
                if (record == null || ownership == null || ownership.Record == null || !ownership.Present || ownership.Journal == null || ownership.Uninstaller == null ||
                    !string.Equals(ownership.Root, record.Root, StringComparison.Ordinal) || ownership.InstallationId != record.InstallationId ||
                    !ownership.RootIdentity.SameAs(record.RootIdentity) || ownership.Record.RecordSha256 != record.RecordSha256 ||
                    !ownership.Record.RecordIdentity.SameAs(record.RecordIdentity) || !InstalledRecord.StillCurrent(record)) return false;
                OwnershipRead fresh = SetupOwnership.Read(record);
                return fresh.State == OwnershipReadState.Valid && fresh.Snapshot != null && Same(fresh.Snapshot.Journal, ownership.Journal) &&
                    Same(fresh.Snapshot.Uninstaller, ownership.Uninstaller);
            }
            catch (Exception) { return false; }
        }

        private static bool Same(OwnedFileDescriptor a, OwnedFileDescriptor b)
        {
            return a != null && b != null && a.Root == b.Root && a.Name == b.Name && a.Bytes == b.Bytes && a.Sha256 == b.Sha256 &&
                a.RootIdentity.SameAs(b.RootIdentity) && a.Identity.SameAs(b.Identity);
        }

        /// <summary>A no-delete-share pin of an existing canonical, reparse-free directory with the expected identity; null otherwise.</summary>
        private static SafeFileHandle PinDirectory(string path, FileIdentity expected, uint access)
        {
            try { InstalledRecord.DirectRoot(path); } catch (Exception) { return null; }
            SafeFileHandle pin = CreateFileW(path, access, NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            if (pin.IsInvalid) { pin.Dispose(); return null; }
            FileIdentity identity; FileAttributes attributes; uint links; long size;
            if (!NativeFile.Describe(pin, out identity, out attributes, out links, out size) || !identity.SameAs(expected) ||
                (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
            { pin.Dispose(); return null; }
            return pin;
        }

        /// <summary>Opens the described file denying writers and deleters and proves identity, single link, size and hash; null otherwise.</summary>
        private static SafeFileHandle Verified(OwnedFileDescriptor expected)
        {
            if (expected == null || expected.Bytes < 1 || expected.Bytes > OwnedFiles.MaxBytes) return null;
            SafeFileHandle file = NativeFile.Open(expected.Root + "\\" + expected.Name, NativeFile.GenericRead, NativeFile.ShareRead, false);
            if (file == null) return null;
            try
            {
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (NativeFile.Describe(file, out identity, out attributes, out links, out size) && identity.SameAs(expected.Identity) && links == 1 &&
                    size == expected.Bytes && (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0 && Sha(Read(file, size)) == expected.Sha256)
                    return file;
            }
            catch (Exception) { }
            file.Dispose();
            return null;
        }

        /// <summary>Creates the named child of the pinned parent and opens it in ONE native call (FILE_CREATE): the returned handle is
        /// the directory this call created, never an existing or swapped one. No delete sharing, so it cannot be renamed or removed
        /// while held. Returns null (nothing created) on any failure.</summary>
        private static SafeFileHandle CreateExclusive(SafeFileHandle parent, string name, out int status)
        {
            IntPtr buffer = IntPtr.Zero, objectName = IntPtr.Zero;
            try
            {
                buffer = Marshal.StringToHGlobalUni(name);
                UnicodeString text = new UnicodeString { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)(name.Length * 2 + 2), Buffer = buffer };
                objectName = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
                Marshal.StructureToPtr(text, objectName, false);
                ObjectAttributes attributes = new ObjectAttributes
                {
                    Length = Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = parent.DangerousGetHandle(), ObjectName = objectName, Attributes = ObjCaseInsensitive
                };
                SafeFileHandle handle; IoStatusBlock io;
                status = NtCreateFile(out handle, FileListDirectory | NativeFile.ReadAttributes | Synchronize, ref attributes, out io, IntPtr.Zero, 0,
                    NativeFile.ShareRead | NativeFile.ShareWrite, FileCreate, FileDirectoryFile | FileSynchronousIoNonalert | FileOpenReparsePoint, IntPtr.Zero, 0);
                if (status != 0 || handle == null || handle.IsInvalid) { if (handle != null) handle.Dispose(); return null; }
                return handle;
            }
            finally
            {
                if (objectName != IntPtr.Zero) Marshal.FreeHGlobal(objectName);
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>Creates an exclusive temporary container and a verified copy of the fixed journal-owned root uninstaller.
        /// Never executes it. A failure after creation makes one typed own-cleanup attempt; anything unproven is retained.</summary>
        public static UninstallStageResult Prepare(InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership, string sourcePath, string canonicalTempParent)
        {
            string created = null; FileIdentity createdIdentity = new FileIdentity(); OwnedFileDescriptor placed = null;
            UninstallStageState failState = UninstallStageState.Refused; string failCode = "IO";
            try
            {
                UninstallStage stage = PrepareCore(record, ownership, sourcePath, canonicalTempParent, ref created, ref createdIdentity, ref placed, out failState, out failCode);
                if (stage != null) return new UninstallStageResult(UninstallStageState.Prepared, null, stage, null, null);
                if (created == null) return new UninstallStageResult(failState, failCode, null, null, null);
            }
            catch (Exception)
            {
                if (created == null) return new UninstallStageResult(UninstallStageState.Refused, "IO", null, null, null);
                failState = UninstallStageState.Unknown; failCode = "IO";
            }
            // Every handle from the attempt is closed here; only what this attempt created and proved is a cleanup candidate.
            UninstallStageCleanup cleaned = RemoveStage(created, createdIdentity, placed);
            return new UninstallStageResult(cleaned.Complete ? failState : UninstallStageState.Unknown, failCode, null, cleaned.Complete ? null : created, cleaned);
        }

        private static UninstallStage PrepareCore(InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership, string sourcePath, string canonicalTempParent,
            ref string created, ref FileIdentity createdIdentity, ref OwnedFileDescriptor placed, out UninstallStageState failState, out string failCode)
        {
            failState = UninstallStageState.Refused; failCode = "IO";
            if (!Current(record, ownership)) { failCode = "SOURCE_CHANGED"; return null; }
            if (!string.Equals(sourcePath, record.Root + "\\" + SetupOwnership.UninstallerName, StringComparison.Ordinal) ||
                !string.Equals(ownership.Uninstaller.Name, SetupOwnership.UninstallerName, StringComparison.Ordinal) ||
                !string.Equals(ownership.Uninstaller.Root, record.Root, StringComparison.Ordinal) || !ownership.Uninstaller.RootIdentity.SameAs(record.RootIdentity))
            { failCode = "SOURCE"; return null; }
            string parent;
            try { parent = StageDirectory.CanonicalParent(canonicalTempParent, SetupOwnership.UninstallerName.Length); }
            catch (Exception) { failCode = "PARENT"; return null; }
            // The caller passes the canonical spelling; a different one is refused, never re-derived.
            if (!string.Equals(parent, canonicalTempParent, StringComparison.Ordinal)) { failCode = "PARENT"; return null; }
            FileIdentity parentIdentity;
            try { parentIdentity = InstalledRecord.Directory(parent); } catch (Exception) { failCode = "PARENT"; return null; }
            using (SafeFileHandle parentPin = PinDirectory(parent, parentIdentity, FileListDirectory | NativeFile.ReadAttributes | FileTraverse))
            using (SafeFileHandle rootPin = PinDirectory(record.Root, record.RootIdentity, FileListDirectory | NativeFile.ReadAttributes))
            using (SafeFileHandle source = Verified(ownership.Uninstaller))
            {
                if (parentPin == null) { failCode = "PARENT"; return null; }
                if (rootPin == null || source == null) { failCode = "SOURCE_CHANGED"; return null; }
                byte[] bytes = Read(source, ownership.Uninstaller.Bytes);
                if (Sha(bytes) != ownership.Uninstaller.Sha256) { failCode = "SOURCE_CHANGED"; return null; }
                string proposed = StageDirectory.Reserve(parent, SetupOwnership.UninstallerName.Length);
                int status;
                SafeFileHandle stagePin = CreateExclusive(parentPin, proposed.Substring(parent.Length + 1), out status);
                if (stagePin == null) { failCode = "STAGE"; return null; }
                using (stagePin)
                {
                    created = proposed;
                    FileAttributes attributes; uint links; long size;
                    if (!NativeFile.Describe(stagePin, out createdIdentity, out attributes, out links, out size) ||
                        (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                    { failState = UninstallStageState.Unknown; failCode = "STAGE_CHANGED"; return null; }
                    if (Barrier != null) Barrier("created");
                    OwnedFileResult result = OwnedFiles.Place(created, SetupOwnership.UninstallerName, bytes, ownership.Uninstaller.Sha256, null);
                    if (result.State != OwnedFileState.Placed || result.Descriptor == null)
                    { failState = result.State == OwnedFileState.Unknown ? UninstallStageState.Unknown : UninstallStageState.Refused; failCode = "STAGE"; return null; }
                    // The copy must be in exactly the container this attempt created; a different directory is never adopted or cleaned.
                    if (!string.Equals(result.Descriptor.Root, created, StringComparison.Ordinal) || !result.Descriptor.RootIdentity.SameAs(createdIdentity) ||
                        result.Descriptor.Name != SetupOwnership.UninstallerName || result.Descriptor.Bytes != ownership.Uninstaller.Bytes ||
                        result.Descriptor.Sha256 != ownership.Uninstaller.Sha256)
                    { failState = UninstallStageState.Unknown; failCode = "STAGE_CHANGED"; return null; }
                    placed = result.Descriptor;
                    if (Barrier != null) Barrier("placed");
                    FileIdentity still;
                    if (!NativeFile.Describe(stagePin, out still, out attributes, out links, out size) || !still.SameAs(createdIdentity))
                    { failState = UninstallStageState.Unknown; failCode = "STAGE_CHANGED"; return null; }
                    if (!Current(record, ownership)) { failCode = "SOURCE_CHANGED"; return null; }
                    return new UninstallStage(created, createdIdentity, placed, record, ownership);
                }
            }
        }

        /// <summary>Re-verifies the source binding, the container and the copy, then holds deny-write/delete handles through the
        /// caller's direct start. One live pin at a time; refused after cleanup. Never throws.</summary>
        public UninstallStagePinResult TryPin()
        {
            lock (gate)
            {
                if (consumed) return new UninstallStagePinResult(UninstallPinState.Refused, "CONSUMED", null);
                if (issued != null && issued.Live) return new UninstallStagePinResult(UninstallPinState.Refused, "PINNED", null);
                SafeFileHandle directory = null, file = null;
                try
                {
                    if (!Current(sourceRecord, sourceOwnership)) return new UninstallStagePinResult(UninstallPinState.Refused, "SOURCE_CHANGED", null);
                    using (SafeFileHandle sourceRoot = PinDirectory(sourceRecord.Root, sourceRecord.RootIdentity, FileListDirectory | NativeFile.ReadAttributes))
                    using (SafeFileHandle source = Verified(sourceOwnership.Uninstaller))
                    {
                        if (sourceRoot == null || source == null) return new UninstallStagePinResult(UninstallPinState.Refused, "SOURCE_CHANGED", null);
                        directory = PinDirectory(Directory, directoryIdentity, FileListDirectory | NativeFile.ReadAttributes);
                        if (directory == null || !File.RootIdentity.SameAs(directoryIdentity)) return Refused(ref directory, ref file, "STAGE_CHANGED");
                        file = Verified(File);
                        if (file == null) return Refused(ref directory, ref file, "COPY_CHANGED");
                        if (!Current(sourceRecord, sourceOwnership)) return Refused(ref directory, ref file, "SOURCE_CHANGED");
                        issued = new UninstallStagePin(Executable, TargetRoot, file, directory);
                        return new UninstallStagePinResult(UninstallPinState.Pinned, null, issued);
                    }
                }
                catch (Exception) { return Refused(ref directory, ref file, "IO"); }
            }
        }

        private static UninstallStagePinResult Refused(ref SafeFileHandle directory, ref SafeFileHandle file, string code)
        {
            if (file != null) { file.Dispose(); file = null; }
            if (directory != null) { directory.Dispose(); directory = null; }
            return new UninstallStagePinResult(UninstallPinState.Refused, code, null);
        }

        /// <summary>One cleanup attempt: only the issued unchanged copy and its unchanged empty container. Refused without consuming
        /// while a pin is live. No retry or recursion; unknown children stay.</summary>
        public UninstallStageCleanup Cleanup()
        {
            lock (gate)
            {
                if (consumed) return new UninstallStageCleanup(false, "CONSUMED", null, StageDirectoryOutcome.NotReached, null);
                if (issued != null && issued.Live) return new UninstallStageCleanup(false, "PINNED", null, StageDirectoryOutcome.NotReached, null);
                consumed = true;
                return RemoveStage(Directory, directoryIdentity, File);
            }
        }

        private static UninstallStageCleanup RemoveStage(string directory, FileIdentity identity, OwnedFileDescriptor copy)
        {
            OwnedFileResult file = null;
            if (copy != null)
            {
                file = OwnedFiles.Remove(copy);
                if (file.State != OwnedFileState.Deleted && file.State != OwnedFileState.Absent)
                    return new UninstallStageCleanup(false, file.Code ?? file.State.ToString().ToUpperInvariant(), file, StageDirectoryOutcome.NotReached, null);
            }
            StageDirectoryOutcome outcome; string code;
            try { outcome = RemoveEmptyDirectory(directory, identity, out code); }
            catch (Exception) { outcome = StageDirectoryOutcome.Unknown; code = "IO"; }
            bool complete = outcome == StageDirectoryOutcome.Deleted;
            return new UninstallStageCleanup(complete, complete ? null : code, file, outcome, code);
        }

        /// <summary>Deletes the directory through a verified handle only when it is the issued identity and EMPTY: NTFS's own refusal of
        /// a non-empty directory at disposition time is the authority. Absence is observed after the handle closes.</summary>
        private static StageDirectoryOutcome RemoveEmptyDirectory(string path, FileIdentity expected, out string code)
        {
            code = null;
            try { InstalledRecord.DirectRoot(path); }
            catch (Exception)
            {
                // A vanished container was not removed by this attempt; a redirected one is never followed.
                code = "CHANGED";
                return Attributes(path).HasValue ? StageDirectoryOutcome.Kept : StageDirectoryOutcome.Unknown;
            }
            SafeFileHandle handle = CreateFileW(path, NativeFile.ReadAttributes | NativeFile.Delete, NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                code = error == ErrorSharingViolation ? "IN_USE" : error == ErrorFileNotFound || error == ErrorPathNotFound ? "CHANGED" : "IO";
                return error == ErrorFileNotFound || error == ErrorPathNotFound ? StageDirectoryOutcome.Unknown : StageDirectoryOutcome.Kept;
            }
            using (handle)
            {
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size) || !identity.SameAs(expected) ||
                    (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                { code = "CHANGED"; return StageDirectoryOutcome.Kept; }
                byte delete = 1;
                if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1))
                {
                    int error = Marshal.GetLastWin32Error();
                    code = error == ErrorDirNotEmpty ? "NOT_EMPTY" : error == ErrorSharingViolation ? "IN_USE" : "IO";
                    return StageDirectoryOutcome.Kept;
                }
            }
            if (Attributes(path).HasValue) { code = "IO"; return StageDirectoryOutcome.Unknown; }
            return StageDirectoryOutcome.Deleted;
        }

        private static FileAttributes? Attributes(string path)
        {
            uint value = GetFileAttributesW(path);
            if (value != InvalidAttributes) return (FileAttributes)value;
            int error = Marshal.GetLastWin32Error();
            return error == ErrorFileNotFound || error == ErrorPathNotFound ? (FileAttributes?)null : FileAttributes.ReparsePoint;
        }

        private static byte[] Read(SafeFileHandle file, long length)
        {
            if (length < 1 || length > OwnedFiles.MaxBytes) throw new IOException("Uninstall stage unavailable.");
            using (FileStream stream = new FileStream(new SafeFileHandle(file.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
            {
                stream.Position = 0; byte[] bytes = new byte[(int)length]; int offset = 0;
                while (offset < bytes.Length) { int read = stream.Read(bytes, offset, bytes.Length - offset); if (read == 0) throw new IOException("Uninstall stage unavailable."); offset += read; }
                if (stream.ReadByte() != -1) throw new IOException("Uninstall stage unavailable."); return bytes;
            }
        }

        private static string Sha(byte[] bytes)
        { using (SHA256 hash = SHA256.Create()) { StringBuilder text = new StringBuilder(64); foreach (byte value in hash.ComputeHash(bytes)) text.Append(value.ToString("x2")); return text.ToString(); } }
    }
}
