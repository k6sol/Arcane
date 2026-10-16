// Strict reader for an installed Arcane root (C# 5, .NET Framework 4.x, no NuGet).
// installation.json is the engine's record (scripts/windows-installation.mjs); this reader mirrors its exact schema and
// requires its exact canonical bytes. A release's windows-manifest.json is pinned to the record entry's SHA-256 and its
// inventory is validated; reading the manifest does NOT verify the bytes of the files it lists.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal sealed class InstalledRecordException : Exception
    {
        public readonly string Code;
        public InstalledRecordException(string code) : base("Arcane installation " + code + ".") { Code = code; }
    }

    internal sealed class InstalledRelease
    {
        public readonly string Id, Version, ManifestSha256, InstalledAt;
        public readonly long Files, Bytes;
        internal InstalledRelease(string id, string version, string manifestSha256, long files, long bytes, string installedAt)
        {
            Id = id; Version = version; ManifestSha256 = manifestSha256; Files = files; Bytes = bytes; InstalledAt = installedAt;
        }
    }

    internal sealed class InstalledRecordSnapshot
    {
        public readonly string Root, InstallationId, ActiveReleaseId, RecordSha256;
        public readonly IList<InstalledRelease> Releases;
        internal readonly FileIdentity RootIdentity, RecordIdentity;
        internal readonly long RecordBytes;
        internal InstalledRecordSnapshot(string root, FileIdentity rootIdentity, FileIdentity recordIdentity, long recordBytes, string recordSha256,
            string installationId, string activeReleaseId, IList<InstalledRelease> releases)
        {
            Root = root; RootIdentity = rootIdentity; RecordIdentity = recordIdentity; RecordBytes = recordBytes; RecordSha256 = recordSha256;
            InstallationId = installationId; ActiveReleaseId = activeReleaseId; Releases = releases;
        }
        public InstalledRelease Active
        {
            get { foreach (InstalledRelease release in Releases) if (release.Id == ActiveReleaseId) return release; return null; }
        }
    }

    internal sealed class ManifestFile
    {
        public readonly string Path, Sha256; public readonly long Bytes;
        internal ManifestFile(string path, long bytes, string sha256) { Path = path; Bytes = bytes; Sha256 = sha256; }
    }

    internal sealed class ReleaseManifest
    {
        public readonly string Version, ManifestSha256, Directory;
        public readonly long FileCount, TotalBytes;
        public readonly IList<ManifestFile> Files;
        internal readonly FileIdentity DirectoryIdentity;
        internal ReleaseManifest(string directory, FileIdentity identity, string version, long fileCount, long totalBytes, IList<ManifestFile> files, string sha256)
        {
            Directory = directory; DirectoryIdentity = identity; Version = version; FileCount = fileCount; TotalBytes = totalBytes; Files = files; ManifestSha256 = sha256;
        }
        public ManifestFile Find(string path)
        {
            foreach (ManifestFile file in Files) if (string.Equals(file.Path, path, StringComparison.OrdinalIgnoreCase)) return file;
            return null;
        }
    }

    internal static class InstalledRecord
    {
        // Engine limits (windows-installation.mjs LIMITS).
        internal const int RecordMaxBytes = 65536, MaxReleases = 32, MaxFiles = 32768, MaxPathChars = 259;
        internal const long MaxFileBytes = 512L * 1024 * 1024, MaxTotalBytes = 2L * 1024 * 1024 * 1024, ManifestMaxBytes = 8L * 1024 * 1024;
        internal const string RecordName = "installation.json", LockName = "installation.lock", ManifestName = "windows-manifest.json";
        // \z, not $: in .NET, $ also matches before a final "\n", which would admit a trailing LF in an otherwise canonical record.
        private static readonly Regex Hash = new Regex("^[a-f0-9]{64}\\z"), Uuid = new Regex("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\z");
        private static readonly Regex Version = new Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?\\z"), Instant = new Regex("^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z\\z");
        private static readonly Regex Device = new Regex("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|\\z)", RegexOptions.IgnoreCase);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint length);

        private static InstalledRecordException Fail(string code) { return new InstalledRecordException(code); }

        /// <summary>Drive-absolute, already canonical (GetFullPath and long-name fixed point), not a volume root, every component a real directory.</summary>
        internal static string DirectRoot(string root)
        {
            if (root == null || root.Length < 4 || root.Length > MaxPathChars || !char.IsLetter(root[0]) || root[1] != ':' || root[2] != '\\' ||
                root.EndsWith("\\", StringComparison.Ordinal) || root.Substring(2).IndexOf(':') >= 0) throw Fail("PATH");
            foreach (char c in root) if (c < 0x20 || c == 0x7f || c == '"' || c == '/' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') throw Fail("PATH");
            string full;
            try { full = Path.GetFullPath(root); } catch (Exception) { throw Fail("PATH"); }
            StringBuilder buffer = new StringBuilder(1024);
            uint length = GetLongPathNameW(root, buffer, (uint)buffer.Capacity);
            if (length == 0 || length >= buffer.Capacity) throw Fail("PATH");
            if (!string.Equals(full, root, StringComparison.Ordinal) || !string.Equals(buffer.ToString(), root, StringComparison.Ordinal)) throw Fail("PATH");
            DirectChain(root);
            return root;
        }

        internal static void DirectChain(string path)
        {
            for (string current = path; !string.IsNullOrEmpty(current); )
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(current); } catch (Exception) { throw Fail("PATH"); }
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw Fail("REDIRECT");
                string next = Path.GetDirectoryName(current);
                if (next == null || next == current) break;
                current = next;
            }
        }

        /// <summary>Identity of a real directory entry (never followed).</summary>
        internal static FileIdentity Directory(string path)
        {
            using (SafeFileHandle handle = NativeFile.Open(path, NativeFile.ReadAttributes, NativeFile.ShareRead | NativeFile.ShareWrite | NativeFile.ShareDelete, true))
            {
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (handle == null) throw Fail("PATH");
                if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size)) throw Fail("IO");
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw Fail("REDIRECT");
                return identity;
            }
        }

        internal static bool Exists(string path)
        {
            try { File.GetAttributes(path); return true; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
        }

        /// <summary>Opens a regular single-link file entry with deny-write sharing and reads it fully within a bound.</summary>
        internal static byte[] ReadDirect(string path, long maximum, string code, out FileIdentity identity)
        {
            using (SafeFileHandle handle = NativeFile.Open(path, NativeFile.GenericRead, NativeFile.ShareRead, false))
            {
                if (handle == null) throw Fail(code);
                FileAttributes attributes; uint links; long size;
                if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size)) throw Fail("IO");
                if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || links != 1 || size < 1 || size > maximum) throw Fail(code);
                byte[] bytes = new byte[size];
                using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
                {
                    int offset = 0, read;
                    while (offset < bytes.Length && (read = stream.Read(bytes, offset, bytes.Length - offset)) > 0) offset += read;
                    if (offset != bytes.Length || stream.ReadByte() != -1) throw Fail(code);
                }
                return bytes;
            }
        }

        internal static string Sha256Hex(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes));
        }
        internal static string Hex(byte[] bytes) { StringBuilder s = new StringBuilder(bytes.Length * 2); foreach (byte b in bytes) s.Append(b.ToString("x2")); return s.ToString(); }

        private static Dictionary<string, object> Json(byte[] bytes, int maximum, string code)
        {
            try
            {
                JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = maximum; json.RecursionLimit = 8;
                Dictionary<string, object> value = json.DeserializeObject(new UTF8Encoding(false, true).GetString(bytes)) as Dictionary<string, object>;
                if (value == null) throw Fail(code);
                return value;
            }
            catch (InstalledRecordException) { throw; }
            catch (Exception) { throw Fail(code); }
        }
        private static void Exact(Dictionary<string, object> value, string[] keys, string code)
        {
            if (value == null || value.Count != keys.Length) throw Fail(code);
            foreach (string key in keys) if (!value.ContainsKey(key)) throw Fail(code);
        }
        private static string Text(object value, string code) { string text = value as string; if (text == null) throw Fail(code); return text; }
        private static long Count(object value, long minimum, long maximum, string code)
        {
            long number;
            if (value is int) number = (int)value; else if (value is long) number = (long)value; else throw Fail(code);
            if (number < minimum || number > maximum) throw Fail(code);
            return number;
        }

        /// <summary>Reads and strictly validates the engine record of <paramref name="installationRoot"/>. Refuses every installation.lock.</summary>
        public static InstalledRecordSnapshot Read(string installationRoot) { return ReadCore(installationRoot, null); }

        /// <summary>Lease-aware read: accepts installation.lock ONLY when it is the live lock issued to <paramref name="lease"/> for this
        /// root, and only while the record still equals the record the lease was authorized for. Every other lock is refused.</summary>
        public static InstalledRecordSnapshot Read(string installationRoot, OperationLease lease)
        {
            if (lease == null) throw Fail("LEASE");
            InstalledRecordSnapshot snapshot = ReadCore(installationRoot, lease);
            if (snapshot.InstallationId != lease.InstallationId || snapshot.RecordSha256 != lease.RecordSha256 || !snapshot.RecordIdentity.SameAs(lease.RecordIdentity)) throw Fail("LEASE");
            return snapshot;
        }

        private static InstalledRecordSnapshot ReadCore(string installationRoot, OperationLease lease)
        {
            string root = DirectRoot(installationRoot);
            FileIdentity rootIdentity = Directory(root);
            // An installation operation in progress owns the root: never read across it, except through the lease that owns it.
            bool locked = Exists(Path.Combine(root, LockName));
            if (lease == null ? locked : !locked || !lease.Proves(root, rootIdentity)) throw Fail(lease == null ? "LOCKED" : "LEASE");
            FileIdentity recordIdentity;
            byte[] bytes = ReadDirect(Path.Combine(root, RecordName), RecordMaxBytes, "RECORD", out recordIdentity);
            Dictionary<string, object> value = Json(bytes, RecordMaxBytes, "RECORD");
            Exact(value, new[] { "schemaVersion", "kind", "installationId", "activeReleaseId", "releases" }, "RECORD");
            if (!(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1 || Text(value["kind"], "RECORD") != "arcane-windows-installation") throw Fail("RECORD");
            string installationId = Text(value["installationId"], "RECORD");
            if (!Uuid.IsMatch(installationId)) throw Fail("RECORD");
            object[] entries = value["releases"] as object[];
            if (entries == null || entries.Length > MaxReleases) throw Fail("RECORD");
            List<InstalledRelease> releases = new List<InstalledRelease>();
            HashSet<string> ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (object item in entries)
            {
                Dictionary<string, object> entry = item as Dictionary<string, object>;
                Exact(entry, new[] { "id", "version", "manifestSha256", "files", "bytes", "installedAt" }, "RECORD");
                string id = Text(entry["id"], "RECORD"), version = Text(entry["version"], "RECORD"), manifest = Text(entry["manifestSha256"], "RECORD");
                string installedAt = Text(entry["installedAt"], "RECORD");
                if (id.Length != 101 || !Hash.IsMatch(manifest) || !id.StartsWith(manifest + "-", StringComparison.Ordinal) || !Uuid.IsMatch(id.Substring(65)) || !ids.Add(id) ||
                    version.Length > 64 || !Version.IsMatch(version) || !Instant.IsMatch(installedAt)) throw Fail("RECORD");
                DateTime parsed;
                if (!DateTime.TryParseExact(installedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out parsed)) throw Fail("RECORD");
                releases.Add(new InstalledRelease(id, version, manifest, Count(entry["files"], 1, MaxFiles, "RECORD"), Count(entry["bytes"], 0, MaxTotalBytes, "RECORD"), installedAt));
            }
            object active = value["activeReleaseId"];
            // A record without an active release has nothing to launch; an active id must be listed.
            if (!(active is string) || !ids.Contains((string)active)) throw Fail("RECORD");
            // Exactly the engine's bytes: JSON.stringify(record) + LF. No whitespace, duplicates, reordering or trailing data.
            string canonical;
            try { JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = RecordMaxBytes; canonical = json.Serialize(value) + "\n"; }
            catch (Exception) { throw Fail("RECORD"); }
            if (!string.Equals(canonical, new UTF8Encoding(false, true).GetString(bytes), StringComparison.Ordinal)) throw Fail("RECORD");
            return new InstalledRecordSnapshot(root, rootIdentity, recordIdentity, bytes.Length, Sha256Hex(bytes), installationId, (string)active, releases.AsReadOnly());
        }

        /// <summary>True when the root is the same directory, no installation is running and the record bytes and identity are unchanged.</summary>
        public static bool StillCurrent(InstalledRecordSnapshot snapshot) { return StillCurrentCore(snapshot, null); }

        /// <summary>Lease-aware fence: true only while <paramref name="lease"/> is live, bound to this snapshot's root, installation and
        /// record, its own lock is still present and unchanged, and the record bytes and identity are unchanged.</summary>
        public static bool StillCurrent(InstalledRecordSnapshot snapshot, OperationLease lease)
        {
            if (snapshot == null || lease == null || snapshot.InstallationId != lease.InstallationId || snapshot.RecordSha256 != lease.RecordSha256 ||
                !snapshot.RecordIdentity.SameAs(lease.RecordIdentity) || !string.Equals(snapshot.Root, lease.Root, StringComparison.Ordinal) ||
                !snapshot.RootIdentity.SameAs(lease.RootIdentity)) return false;
            return StillCurrentCore(snapshot, lease);
        }

        private static bool StillCurrentCore(InstalledRecordSnapshot snapshot, OperationLease lease)
        {
            try
            {
                if (!Directory(snapshot.Root).SameAs(snapshot.RootIdentity)) return false;
                DirectChain(snapshot.Root);
                bool locked = Exists(Path.Combine(snapshot.Root, LockName));
                if (lease == null ? locked : !locked || !lease.Proves(snapshot.Root, snapshot.RootIdentity)) return false;
                FileIdentity identity;
                byte[] bytes = ReadDirect(Path.Combine(snapshot.Root, RecordName), RecordMaxBytes, "RECORD", out identity);
                return identity.SameAs(snapshot.RecordIdentity) && bytes.Length == snapshot.RecordBytes && Sha256Hex(bytes) == snapshot.RecordSha256;
            }
            catch (Exception) { return false; }
        }

        /// <summary>Reads the release's manifest pinned to the record entry and validates its inventory (not the listed files' bytes).</summary>
        public static ReleaseManifest ReadManifest(InstalledRecordSnapshot snapshot, InstalledRelease release)
        {
            string releases = Path.Combine(snapshot.Root, "releases"), directory = Path.Combine(releases, release.Id);
            Directory(releases); FileIdentity identity = Directory(directory); DirectChain(directory);
            FileIdentity manifestIdentity;
            byte[] bytes = ReadDirect(Path.Combine(directory, ManifestName), ManifestMaxBytes, "MANIFEST", out manifestIdentity);
            if (Sha256Hex(bytes) != release.ManifestSha256) throw Fail("MANIFEST");
            Dictionary<string, object> value = Json(bytes, (int)ManifestMaxBytes, "MANIFEST");
            foreach (string key in new[] { "schemaVersion", "kind", "platform", "arch", "version", "fileCount", "totalBytes", "files" }) if (!value.ContainsKey(key)) throw Fail("MANIFEST");
            if (!(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1 || Text(value["kind"], "MANIFEST") != "arcane-windows-directory" ||
                Text(value["platform"], "MANIFEST") != "win32" || Text(value["arch"], "MANIFEST") != "x64" || Text(value["version"], "MANIFEST") != release.Version) throw Fail("MANIFEST");
            object[] files = value["files"] as object[];
            long fileCount = Count(value["fileCount"], 1, MaxFiles, "MANIFEST"), totalBytes = Count(value["totalBytes"], 0, MaxTotalBytes, "MANIFEST");
            if (files == null || files.Length != fileCount || fileCount != release.Files || totalBytes != release.Bytes) throw Fail("MANIFEST");
            List<ManifestFile> inventory = new List<ManifestFile>(files.Length);
            HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            foreach (object item in files)
            {
                Dictionary<string, object> file = item as Dictionary<string, object>;
                Exact(file, new[] { "path", "bytes", "sha256" }, "MANIFEST");
                string path = Text(file["path"], "MANIFEST"), sha = Text(file["sha256"], "MANIFEST");
                long size = Count(file["bytes"], 0, MaxFileBytes, "MANIFEST");
                if (!SafeRelative(path) || !Hash.IsMatch(sha) || !paths.Add(path)) throw Fail("MANIFEST");
                total += size; if (total > MaxTotalBytes) throw Fail("MANIFEST");
                inventory.Add(new ManifestFile(path, size, sha));
            }
            if (total != totalBytes || !paths.Contains("Arcane.exe") || !paths.Contains("resources/node/node.exe")) throw Fail("MANIFEST");
            return new ReleaseManifest(directory, identity, release.Version, fileCount, totalBytes, inventory.AsReadOnly(), release.ManifestSha256);
        }

        /// <summary>The engine's manifest path rule (windows-installation.mjs inventory).</summary>
        internal static bool SafeRelative(string path)
        {
            if (path.Length == 0 || path.Length > 1024 || string.Equals(path, ManifestName, StringComparison.Ordinal)) return false;
            foreach (char c in path) if (c == '\\' || c == ':' || c < 0x20 || c == 0x7f || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') return false;
            string[] parts = path.Split('/');
            if (parts.Length > 32) return false;
            foreach (string part in parts)
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || Device.IsMatch(part)) return false;
            return true;
        }
    }
}
