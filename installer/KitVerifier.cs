// Arcane setup's fixed module closure and bundled Node are checked before execution.
// The caller supplies the approved kit-manifest SHA-256 compiled into setup.
// This component reads only; extraction, process creation and UI are separate.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Arcane.Installer
{
    internal sealed class KitException : Exception
    {
        public readonly string Code;
        public KitException(string code) : base("Arcane setup kit " + code + ".") { Code = code; }
    }
    internal sealed class KitReceipt
    {
        public string NodeExecutable;
        public string EntryPoint;
        public string BundleDirectory;
        public string BundleManifestSha256;
        public string KitManifestSha256;
    }
    internal static class KitVerifier
    {
        private static readonly string[] Modules = { "windows-install-cli.mjs", "windows-installation.mjs", "package-windows.mjs", "create-local-release.mjs", "managed-luau-compiler.mjs" };
        private static KitException Fail(string code) { return new KitException(code); }
        public static KitReceipt Verify(string stagePath, string expectedKitManifestSha256)
        {
            try { return VerifyCore(stagePath, expectedKitManifestSha256); }
            catch (KitException) { throw; }
            catch (Exception error)
            {
                if (error is IOException || error is UnauthorizedAccessException || error is ArgumentException || error is InvalidOperationException) throw Fail("IO");
                throw;
            }
        }
        private static KitReceipt VerifyCore(string stagePath, string expected)
        {
            Hash(expected);
            if (string.IsNullOrEmpty(stagePath) || stagePath.Length > 259 || stagePath.Length < 4 || !char.IsLetter(stagePath[0]) || stagePath[1] != ':' || stagePath[2] != '\\' ||
                !string.Equals(Path.GetFullPath(stagePath), stagePath, StringComparison.OrdinalIgnoreCase)) throw Fail("PATH");
            DirectDirectory(stagePath);
            HashSet<string> outer = new HashSet<string>(StringComparer.Ordinal);
            foreach (string path in Directory.GetFileSystemEntries(stagePath)) outer.Add(Path.GetFileName(path));
            if (!outer.SetEquals(new string[] { "bundle", "kit", "kit-manifest.json" })) throw Fail("LAYOUT");
            string manifestPath = Path.Combine(stagePath, "kit-manifest.json");
            byte[] manifest;
            using (FileStream file = OpenDirectFile(manifestPath))
            {
                if (file.Length < 1 || file.Length > 65536) throw Fail("MANIFEST");
                manifest = new byte[(int)file.Length]; int offset = 0;
                while (offset < manifest.Length) { int count = file.Read(manifest, offset, manifest.Length - offset); if (count < 1) throw Fail("CHANGED"); offset += count; }
            }
            using (SHA256 hash = SHA256.Create()) if (Hex(hash.ComputeHash(manifest)) != expected) throw Fail("MANIFEST_HASH");
            JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 65536; json.RecursionLimit = 12;
            Dictionary<string, object> value;
            try { value = json.DeserializeObject(new UTF8Encoding(false, true).GetString(manifest)) as Dictionary<string, object>; }
            catch (Exception) { throw Fail("MANIFEST"); }
            Exact(value, new string[] { "schemaVersion", "kind", "bundleManifestSha256", "node", "files" });
            if (!(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1 || Text(value["kind"]) != "arcane-windows-installer-kit") throw Fail("MANIFEST");
            string bundleHash = Text(value["bundleManifestSha256"]); Hash(bundleHash);
            Dictionary<string, object> node = value["node"] as Dictionary<string, object>;
            Exact(node, new string[] { "path", "bytes", "sha256" });
            if (Text(node["path"]) != "bundle/resources/node/node.exe") throw Fail("NODE");
            object[] files = value["files"] as object[];
            if (files == null || files.Length != Modules.Length) throw Fail("MODULES");
            HashSet<string> required = new HashSet<string>(StringComparer.Ordinal);
            foreach (string module in Modules) required.Add("kit/scripts/" + module);
            foreach (object item in files)
            {
                Dictionary<string, object> entry = item as Dictionary<string, object>; Exact(entry, new string[] { "path", "bytes", "sha256" });
                string name = Text(entry["path"]); if (!required.Remove(name)) throw Fail("MODULES");
                CheckFile(Target(stagePath, name), Bytes(entry["bytes"], 1024 * 1024), Text(entry["sha256"]), false);
            }
            string kit = Path.Combine(stagePath, "kit"), scripts = Path.Combine(kit, "scripts"); DirectDirectory(kit); DirectDirectory(scripts);
            string[] children = Directory.GetFileSystemEntries(kit);
            if (children.Length != 1 || Path.GetFileName(children[0]) != "scripts") throw Fail("LAYOUT");
            HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
            foreach (string path in Directory.GetFileSystemEntries(scripts)) names.Add(Path.GetFileName(path));
            if (!names.SetEquals(Modules)) throw Fail("MODULES");
            string bundle = Path.Combine(stagePath, "bundle"); DirectDirectory(bundle);
            // The engine checks the complete bundle before installation. This
            // independent pin protects the runtime that will execute that engine.
            string nodePath = Target(stagePath, "bundle/resources/node/node.exe");
            CheckFile(nodePath, Bytes(node["bytes"], 512L * 1024 * 1024), Text(node["sha256"]), true);
            string bundleManifest = Path.Combine(bundle, "windows-manifest.json");
            using (FileStream file = OpenDirectFile(bundleManifest))
            using (SHA256 hash = SHA256.Create())
            {
                if (file.Length < 1 || file.Length > 8 * 1024 * 1024 || Hex(hash.ComputeHash(file)) != bundleHash) throw Fail("BUNDLE_MANIFEST");
            }
            return new KitReceipt { NodeExecutable = nodePath, EntryPoint = Target(stagePath, "kit/scripts/windows-install-cli.mjs"),
                BundleDirectory = bundle, BundleManifestSha256 = bundleHash, KitManifestSha256 = expected };
        }
        private static void Exact(Dictionary<string, object> value, string[] keys)
        {
            if (value == null || value.Count != keys.Length) throw Fail("MANIFEST");
            foreach (string key in keys) if (!value.ContainsKey(key)) throw Fail("MANIFEST");
        }
        private static string Text(object value) { string text = value as string; if (text == null) throw Fail("MANIFEST"); return text; }
        private static long Bytes(object value, long maximum)
        {
            if (!(value is int) && !(value is long)) throw Fail("MANIFEST");
            long count = Convert.ToInt64(value); if (count < 0 || count > maximum) throw Fail("MANIFEST"); return count;
        }
        private static void Hash(string value)
        {
            if (value == null || value.Length != 64) throw Fail("HASH");
            foreach (char c in value) if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) throw Fail("HASH");
        }
        private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
        private static string Target(string stage, string relative) { string path = Path.Combine(stage, relative.Replace('/', '\\')); if (path.Length > 259) throw Fail("PATH"); return path; }
        private static void DirectDirectory(string path)
        {
            for (string current = path; !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            {
                FileAttributes attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw Fail("REDIRECT");
            }
        }
        private static FileStream OpenDirectFile(string path)
        {
            DirectDirectory(Path.GetDirectoryName(path));
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw Fail("REDIRECT");
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.SequentialScan);
        }
        private static void CheckFile(string path, long bytes, string expected, bool executable)
        {
            Hash(expected);
            using (FileStream file = OpenDirectFile(path))
            using (SHA256 hash = SHA256.Create())
            {
                if (file.Length != bytes || Hex(hash.ComputeHash(file)) != expected) throw Fail(executable ? "NODE_HASH" : "MODULE_HASH");
                if (executable)
                {
                    if (file.Length < 64) throw Fail("NODE_PE"); file.Position = 0; BinaryReader reader = new BinaryReader(file);
                    if (reader.ReadUInt16() != 0x5a4d) throw Fail("NODE_PE"); file.Position = 0x3c; uint offset = reader.ReadUInt32();
                    if (offset < 64 || offset > 1024 * 1024 || offset > file.Length - 6) throw Fail("NODE_PE"); file.Position = offset;
                    if (reader.ReadUInt32() != 0x00004550 || reader.ReadUInt16() != 0x8664) throw Fail("NODE_PE");
                }
            }
        }
    }
}
