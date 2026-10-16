// Operation lease on an installed root (C# 5, .NET Framework 4.x, kernel32 only). The lease IS root\installation.lock,
// created exclusively and held open (deny write and delete to everyone else) for the whole operation, so the engine,
// setup and launcher keep refusing through their unchanged checks. Only the lease-aware InstalledRecord overloads accept
// this one lock, and only while this live lease proves the lock is its own (identity, single link, exact bytes) on the
// authorized root and record. Release deletes the unchanged lock through the held handle, once. Dispose never releases:
// an unreleased lock is retained (a stale lock is never taken over). Guarantees are cooperative against same-user processes.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum LeaseState { Acquired, Refused, Unknown }
    internal enum LeaseReleaseState { Released, Kept, Unknown }

    internal sealed class LeaseResult
    {
        public readonly LeaseState State;
        /// <summary>null, LOCKED, RECORD_CHANGED, PATH or IO.</summary>
        public readonly string Code;
        public readonly OperationLease Lease;
        /// <summary>Set when a lock this attempt created could not be removed again: it stays on disk and is reported, never claimed absent.</summary>
        public readonly string RetainedLock;
        internal LeaseResult(LeaseState state, string code, OperationLease lease, string retainedLock) { State = state; Code = code; Lease = lease; RetainedLock = retainedLock; }
    }

    internal sealed class LeaseRelease
    {
        public readonly LeaseReleaseState State;
        /// <summary>null, CONSUMED, DISPOSED, CHANGED or IO.</summary>
        public readonly string Code;
        internal LeaseRelease(LeaseReleaseState state, string code) { State = state; Code = code; }
    }

    internal sealed class OperationLease : IDisposable
    {
        internal const string Kind = "arcane-operation-lease";
        public readonly string Root, InstallationId, RecordSha256, Operation;
        internal readonly FileIdentity RootIdentity, RecordIdentity, LockIdentity;
        private readonly byte[] lockBytes;
        private readonly object gate = new object();
        private SafeFileHandle lockHandle, rootPin;
        private bool released, disposed, retained;

        private const uint GenericWrite = 0x40000000, CreateNew = 1, OpenExisting = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
        private const int ErrorFileExists = 80, ErrorAlreadyExists = 183, FileDispositionInfo = 4;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref byte deleteFile, uint size);

        private OperationLease(InstalledRecordSnapshot authorized, string operation, byte[] bytes, FileIdentity lockIdentity, SafeFileHandle handle, SafeFileHandle pin)
        {
            Root = authorized.Root; RootIdentity = authorized.RootIdentity; InstallationId = authorized.InstallationId;
            RecordSha256 = authorized.RecordSha256; RecordIdentity = authorized.RecordIdentity; Operation = operation;
            lockBytes = bytes; LockIdentity = lockIdentity; lockHandle = handle; rootPin = pin;
        }

        /// <summary>True until released or disposed.</summary>
        public bool Live { get { lock (gate) return !released && !disposed && lockHandle != null && !lockHandle.IsClosed; } }
        /// <summary>True when this lease ended without releasing its lock (the lock stays on disk).</summary>
        public bool Retained { get { lock (gate) return retained; } }

        private string LockPath { get { return Root + "\\" + InstalledRecord.LockName; } }

        /// <summary>Creates the lease for an authorized, current snapshot. Never throws; never takes over an existing lock.</summary>
        public static LeaseResult Acquire(InstalledRecordSnapshot authorized)
        {
            if (authorized == null || authorized.Root == null) return new LeaseResult(LeaseState.Refused, "PATH", null, null);
            string lockPath = authorized.Root + "\\" + InstalledRecord.LockName;
            try
            {
                if (!InstalledRecord.StillCurrent(authorized))
                    return new LeaseResult(LeaseState.Refused, InstalledRecord.Exists(lockPath) ? "LOCKED" : "RECORD_CHANGED", null, null);
            }
            catch (Exception) { return new LeaseResult(LeaseState.Refused, "PATH", null, null); }
            // The root cannot be renamed or replaced while this handle (ListDirectory access, no FILE_SHARE_DELETE) is held.
            SafeFileHandle pin = CreateFileW(authorized.Root, NativeFile.ListDirectory | NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite, IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero);
            FileIdentity pinIdentity; FileAttributes attributes; uint links; long size;
            if (pin.IsInvalid || !NativeFile.Describe(pin, out pinIdentity, out attributes, out links, out size) || !pinIdentity.SameAs(authorized.RootIdentity) ||
                (attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
            { pin.Dispose(); return new LeaseResult(LeaseState.Refused, "RECORD_CHANGED", null, null); }
            string operation = Guid.NewGuid().ToString("N");
            byte[] bytes = Encoding.UTF8.GetBytes("{\"schemaVersion\":1,\"kind\":\"" + Kind + "\",\"operation\":\"" + operation + "\",\"installationId\":\"" + authorized.InstallationId +
                "\",\"recordSha256\":\"" + authorized.RecordSha256 + "\"}\n");
            SafeFileHandle handle = CreateFileW(lockPath, NativeFile.GenericRead | GenericWrite | NativeFile.Delete, NativeFile.ShareRead, IntPtr.Zero, CreateNew, OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); handle.Dispose(); pin.Dispose();
                return new LeaseResult(LeaseState.Refused, error == ErrorFileExists || error == ErrorAlreadyExists ? "LOCKED" : "IO", null, null);
            }
            OperationLease lease = null;
            try
            {
                using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.ReadWrite, 4096, false))
                { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                FileIdentity identity;
                if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size) || links != 1 || size != bytes.Length ||
                    (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || !Same(ReadAll(handle, bytes.Length), bytes)) return Abandon(handle, pin, "IO", lockPath);
                lease = new OperationLease(authorized, operation, bytes, identity, handle, pin);
                // The record, root and this lock must still be exactly what was authorized after publication.
                if (!InstalledRecord.StillCurrent(authorized, lease)) { lease.Discard(); return Abandon(handle, pin, "RECORD_CHANGED", lockPath); }
                return new LeaseResult(LeaseState.Acquired, null, lease, null);
            }
            catch (Exception) { if (lease != null) lease.Discard(); return Abandon(handle, pin, "IO", lockPath); }
        }

        /// <summary>Removes a lock this attempt created, through its own handle only; reports it when that is not possible.</summary>
        private static LeaseResult Abandon(SafeFileHandle handle, SafeFileHandle pin, string code, string lockPath)
        {
            bool deleted;
            try { byte delete = 1; deleted = SetFileInformationByHandle(handle, FileDispositionInfo, ref delete, 1); } catch (Exception) { deleted = false; }
            handle.Dispose(); pin.Dispose();
            return deleted ? new LeaseResult(LeaseState.Refused, code, null, null) : new LeaseResult(LeaseState.Unknown, code, null, lockPath);
        }

        /// <summary>Marks a lease object unusable without closing handles the caller still owns.</summary>
        private void Discard() { lock (gate) released = true; }

        /// <summary>Proves the live lock on <paramref name="root"/> is this lease's own: same root path and identity, same lock identity,
        /// a single link and exactly the issued bytes, read through both the held handle and a separate reader of the path.</summary>
        internal bool Proves(string root, FileIdentity rootIdentity)
        {
            lock (gate)
            {
                if (released || disposed || lockHandle == null || lockHandle.IsClosed) return false;
                if (!string.Equals(root, Root, StringComparison.Ordinal) || !rootIdentity.SameAs(RootIdentity)) return false;
                try { return Unchanged(lockHandle) && PathResolves(); }
                catch (Exception) { return false; }
            }
        }

        private bool Unchanged(SafeFileHandle handle)
        {
            FileIdentity identity; FileAttributes attributes; uint links; long size;
            return NativeFile.Describe(handle, out identity, out attributes, out links, out size) && identity.SameAs(LockIdentity) && links == 1 &&
                size == lockBytes.Length && (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0 && Same(ReadAll(handle, lockBytes.Length), lockBytes);
        }

        private bool PathResolves()
        {
            // A separate reader must share write and delete to coexist with the lease's own handle; the lease's share-read-only
            // mode still admits no external writer or deleter.
            using (SafeFileHandle reader = NativeFile.Open(LockPath, NativeFile.GenericRead, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, false))
                return reader != null && Unchanged(reader);
        }

        /// <summary>Deletes the unchanged lock through the held handle, once. Never by path, never retried.</summary>
        public LeaseRelease Release()
        {
            lock (gate)
            {
                if (released) return new LeaseRelease(LeaseReleaseState.Kept, "CONSUMED");
                if (disposed) return new LeaseRelease(LeaseReleaseState.Kept, "DISPOSED");
                released = true;
                bool intact;
                try { intact = lockHandle != null && !lockHandle.IsClosed && Unchanged(lockHandle) && PathResolves(); } catch (Exception) { intact = false; }
                if (!intact) { retained = true; Close(); return new LeaseRelease(LeaseReleaseState.Kept, "CHANGED"); }
                bool deleted;
                try { byte delete = 1; deleted = SetFileInformationByHandle(lockHandle, FileDispositionInfo, ref delete, 1); } catch (Exception) { deleted = false; }
                Close();
                if (!deleted) { retained = true; return new LeaseRelease(LeaseReleaseState.Unknown, "IO"); }
                return new LeaseRelease(LeaseReleaseState.Released, null);
            }
        }

        /// <summary>Closes the handles. An unreleased lock is RETAINED on disk (reported through <see cref="Retained"/>), never released.</summary>
        public void Dispose()
        {
            lock (gate)
            {
                if (!released && !disposed) retained = true;
                disposed = true; Close();
            }
        }

        private void Close()
        {
            if (lockHandle != null) { lockHandle.Dispose(); lockHandle = null; }
            if (rootPin != null) { rootPin.Dispose(); rootPin = null; }
        }

        private static byte[] ReadAll(SafeFileHandle handle, int expected)
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
            {
                stream.Position = 0;
                byte[] buffer = new byte[expected + 1]; int offset = 0, read;
                while (offset < buffer.Length && (read = stream.Read(buffer, offset, buffer.Length - offset)) > 0) offset += read;
                if (offset != expected) return null;
                byte[] result = new byte[expected]; Array.Copy(buffer, result, expected); return result;
            }
        }

        private static bool Same(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0; for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i]; return diff == 0;
        }
    }
}
