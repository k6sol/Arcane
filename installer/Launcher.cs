// Stable installed launcher: <root>\Arcane.exe starts exactly the active release recorded now (C# 5, .NET Framework 4.x).
// Verified scope per launch: the engine record (strict, canonical), the active release's manifest (pinned to the record
// entry) and the bytes of the executable it starts (size, SHA-256, regular single-link x64 PE). Other bundle files are
// NOT re-verified here (FullBundleVerified is always false). No fallback to another release, no retry, no arguments.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal sealed class LaunchOutcome
    {
        public const bool FullBundleVerified = false;
        public readonly bool Started, RecordVerified, ManifestVerified, ExecutableVerified;
        /// <summary>null when started; otherwise PATH, REDIRECT, LOCKED, RECORD, MANIFEST, EXECUTABLE, CHANGED, START, ARGUMENTS or IO.</summary>
        public readonly string Code;
        public readonly string InstallationId, ReleaseId, Version;
        public readonly int? ProcessId;
        internal LaunchOutcome(bool started, string code, bool record, bool manifest, bool executable, string installationId, string releaseId, string version, int? processId)
        {
            Started = started; Code = code; RecordVerified = record; ManifestVerified = manifest; ExecutableVerified = executable;
            InstallationId = installationId; ReleaseId = releaseId; Version = version; ProcessId = processId;
        }
    }

    /// <summary>A verified, not yet started launch. Holds deny-write handles on the manifest and executable; single use.</summary>
    internal sealed class PreparedLaunch : IDisposable
    {
        internal readonly InstalledRecordSnapshot Record;
        internal readonly InstalledRelease Release;
        internal readonly ReleaseManifest Manifest;
        internal readonly string Executable;
        internal SafeFileHandle ExecutableHandle, ManifestHandle;
        internal FileIdentity ExecutableIdentity;
        internal bool Used;
        internal PreparedLaunch(InstalledRecordSnapshot record, InstalledRelease release, ReleaseManifest manifest, string executable)
        {
            Record = record; Release = release; Manifest = manifest; Executable = executable;
        }
        public void Dispose()
        {
            if (ExecutableHandle != null) { ExecutableHandle.Dispose(); ExecutableHandle = null; }
            if (ManifestHandle != null) { ManifestHandle.Dispose(); ManifestHandle = null; }
        }
    }

    internal static class InstalledLauncher
    {
        private static InstalledRecordException Fail(string code) { return new InstalledRecordException(code); }

        /// <summary>Host API: verify and start the active release of <paramref name="installationRoot"/>. Never shows UI, never throws.</summary>
        public static LaunchOutcome Launch(string installationRoot)
        {
            PreparedLaunch prepared = null; bool record = false, manifest = false;
            InstalledRecordSnapshot snapshot = null; InstalledRelease release = null;
            try
            {
                snapshot = InstalledRecord.Read(installationRoot); record = true; release = snapshot.Active;
                prepared = Prepare(snapshot, ref manifest);
                return Start(prepared);
            }
            catch (InstalledRecordException error)
            {
                return new LaunchOutcome(false, error.Code, record, manifest, false, snapshot == null ? null : snapshot.InstallationId,
                    release == null ? null : release.Id, release == null ? null : release.Version, null);
            }
            catch (Exception) { return new LaunchOutcome(false, "IO", record, manifest, false, null, null, null, null); }
            finally { if (prepared != null) prepared.Dispose(); }
        }

        /// <summary>Pins the active release's manifest and executable (deny-write) after verifying them.</summary>
        public static PreparedLaunch Prepare(InstalledRecordSnapshot snapshot)
        {
            bool manifestVerified = false;
            return Prepare(snapshot, ref manifestVerified);
        }

        /// <summary>As <see cref="Prepare(InstalledRecordSnapshot)"/>; reports the manifest as verified as soon as it is, even if the executable then fails.</summary>
        internal static PreparedLaunch Prepare(InstalledRecordSnapshot snapshot, ref bool manifestVerified)
        {
            InstalledRelease release = snapshot.Active;
            if (release == null) throw Fail("RECORD");
            ReleaseManifest manifest = InstalledRecord.ReadManifest(snapshot, release);
            ManifestFile descriptor = manifest.Find("Arcane.exe");
            if (descriptor == null || descriptor.Path != "Arcane.exe") throw Fail("MANIFEST");
            PreparedLaunch prepared = new PreparedLaunch(snapshot, release, manifest, Path.Combine(manifest.Directory, "Arcane.exe"));
            try
            {
                // Keep the manifest unchangeable while this launch is pending (the engine never writes a published release).
                prepared.ManifestHandle = NativeFile.Open(Path.Combine(manifest.Directory, InstalledRecord.ManifestName), NativeFile.GenericRead, NativeFile.ShareRead, false);
                if (prepared.ManifestHandle == null || !SameBytes(prepared.ManifestHandle, manifest.ManifestSha256)) throw Fail("MANIFEST");
                manifestVerified = true;
                prepared.ExecutableHandle = NativeFile.Open(prepared.Executable, NativeFile.GenericRead, NativeFile.ShareRead, false);
                if (prepared.ExecutableHandle == null) throw Fail("EXECUTABLE");
                FileAttributes attributes; uint links; long size;
                if (!NativeFile.Describe(prepared.ExecutableHandle, out prepared.ExecutableIdentity, out attributes, out links, out size) ||
                    (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || links != 1 || size != descriptor.Bytes) throw Fail("EXECUTABLE");
                if (!SameBytes(prepared.ExecutableHandle, descriptor.Sha256) || !PortableExecutableX64(prepared.ExecutableHandle)) throw Fail("EXECUTABLE");
                return prepared;
            }
            catch (Exception) { prepared.Dispose(); throw; }
        }

        /// <summary>Rechecks the root, lock, record and release immediately before one direct start; consumes the prepared launch.</summary>
        public static LaunchOutcome Start(PreparedLaunch prepared)
        {
            InstalledRecordSnapshot record = prepared.Record; InstalledRelease release = prepared.Release;
            if (prepared.Used || prepared.ExecutableHandle == null) return Refused(prepared, "CHANGED", true);
            prepared.Used = true;
            FileIdentity identity; FileAttributes attributes; uint links; long size;
            bool current = InstalledRecord.StillCurrent(record) && SameDirectory(prepared.Manifest) &&
                NativeFile.Describe(prepared.ExecutableHandle, out identity, out attributes, out links, out size) && identity.SameAs(prepared.ExecutableIdentity) && links == 1;
            if (!current) return Refused(prepared, "CHANGED", true);
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = prepared.Executable; info.Arguments = string.Empty; info.WorkingDirectory = prepared.Manifest.Directory;
            info.UseShellExecute = false; info.ErrorDialog = false;
            int? processId = null;
            try
            {
                // The deny-write handle is still held here; it is released only after the start request returns.
                using (Process process = Process.Start(info))
                {
                    if (process == null) return Refused(prepared, "START", true);
                    try { processId = process.Id; } catch (Exception) { processId = null; }
                }
            }
            catch (Exception) { return Refused(prepared, "START", true); }
            finally { prepared.Dispose(); }
            return new LaunchOutcome(true, null, true, true, true, record.InstallationId, release.Id, release.Version, processId);
        }

        private static LaunchOutcome Refused(PreparedLaunch prepared, string code, bool executableVerified)
        {
            prepared.Dispose();
            return new LaunchOutcome(false, code, true, true, executableVerified, prepared.Record.InstallationId, prepared.Release.Id, prepared.Release.Version, null);
        }

        private static bool SameDirectory(ReleaseManifest manifest)
        {
            try { InstalledRecord.DirectChain(manifest.Directory); return InstalledRecord.Directory(manifest.Directory).SameAs(manifest.DirectoryIdentity); }
            catch (Exception) { return false; }
        }

        private static bool SameBytes(SafeFileHandle handle, string expectedSha256)
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 81920, false))
            using (SHA256 sha = SHA256.Create())
            {
                stream.Position = 0;
                return InstalledRecord.Hex(sha.ComputeHash(stream)) == expectedSha256;
            }
        }

        private static bool PortableExecutableX64(SafeFileHandle handle)
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
            using (BinaryReader reader = new BinaryReader(stream))
            {
                if (stream.Length < 64) return false;
                stream.Position = 0; if (reader.ReadUInt16() != 0x5a4d) return false;
                stream.Position = 0x3c; uint offset = reader.ReadUInt32();
                if (offset < 64 || offset > 1024 * 1024 || offset > stream.Length - 6) return false;
                stream.Position = offset;
                return reader.ReadUInt32() == 0x00004550 && reader.ReadUInt16() == 0x8664;
            }
        }
    }

    internal static class LauncherEntry
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint length);

        /// <summary>The production launcher accepts no arguments at all.</summary>
        internal static bool Admit(string[] args) { return args != null && args.Length == 0; }

        /// <summary>The installation root is the directory of this executable only (long-name form); no alternate roots.</summary>
        internal static string OwnRoot()
        {
            string self = Path.GetDirectoryName(typeof(LauncherEntry).Assembly.Location);
            StringBuilder buffer = new StringBuilder(1024);
            uint length = self == null ? 0 : GetLongPathNameW(self, buffer, (uint)buffer.Capacity);
            return length == 0 || length >= buffer.Capacity ? self : buffer.ToString();
        }

        [STAThread]
        private static int Main(string[] args)
        {
            LaunchOutcome outcome = Admit(args) ? InstalledLauncher.Launch(OwnRoot()) : new LaunchOutcome(false, "ARGUMENTS", false, false, false, null, null, null, null);
            if (outcome.Started) return 0;
            Application.EnableVisualStyles();
            MessageBox.Show(outcome.Code == "LOCKED" ? "Arcane Setup is changing this installation. Try again when it finishes." :
                "Arcane needs repair. Run Arcane Setup again.", "Arcane", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
