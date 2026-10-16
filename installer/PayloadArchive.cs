// Arcane setup payload reader and extractor (C# 5, .NET Framework 4.x, no NuGet).
// The setup executable ends with a fixed 64-byte trailer:
//   [0..16)  ASCII magic "ARCANE-SETUP-V1\0"
//   [16..24) u64 little-endian payload offset
//   [24..32) u64 little-endian payload length
//   [32..64) raw SHA-256 of the payload bytes
// The payload is a ZIP. The caller supplies the expected payload SHA-256 (a compile-time constant in the real setup);
// that approved hash is the authority for every byte. The trailer range and hash are verified on ONE deny-write handle
// before any entry is read; every entry is validated before the stage is created; extraction is exclusive into a fresh
// caller-chosen stage that is fenced against reparse points. Concurrency guarantees are cooperative (same-user processes
// can still race between a check and a create); a failed extraction RETAINS its stage for inspection.
// Long paths: every created path must stay below MAX_PATH (260); this component does not enable long-path support.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Arcane.Installer
{
    internal sealed class PayloadException : Exception
    {
        public readonly string Code;
        public readonly string RetainedStage;
        public PayloadException(string code, string retainedStage) : base("Arcane setup payload " + code + ".")
        {
            Code = code; RetainedStage = retainedStage;
        }
    }

    internal sealed class PayloadReceipt
    {
        public string StagePath;
        public string PayloadSha256;
        public int Files;
        public int Directories;
        public long Bytes;
    }

    internal static class PayloadArchive
    {
        public const int TrailerBytes = 64;
        public const int MaxEntries = 40000;      // above the bundle's 32768-file engine limit plus the kit; below the non-ZIP64 65535
        public const long MaxFileBytes = 512L * 1024 * 1024;
        public const long MaxTotalBytes = 4L * 1024 * 1024 * 1024;
        public const int MaxPathChars = 259;      // below MAX_PATH; long-path support is deliberately not enabled
        public const int MaxEntryNameChars = 1024;
        public const int MaxDepth = 32;
        private static readonly byte[] Magic = Encoding.ASCII.GetBytes("ARCANE-SETUP-V1\0");
        private static readonly string[] Devices = { "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
            "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9" };

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);

        private static PayloadException Fail(string code) { return new PayloadException(code, null); }

        /// <summary>Verify the pinned payload of <paramref name="selfPath"/> and extract it into the fresh
        /// <paramref name="stagePath"/>. Throws <see cref="PayloadException"/> with a typed code.</summary>
        public static PayloadReceipt VerifyAndExtract(string selfPath, string stagePath, string expectedPayloadSha256)
        {
            byte[] expected = ParseHash(expectedPayloadSha256);
            string self = CanonicalAbsolute(selfPath, "SELF_PATH");
            string stage = CanonicalAbsolute(stagePath, "STAGE_PATH");
            FileStream file;
            try { file = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.SequentialScan); }
            catch (Exception) { throw Fail("SELF_UNREADABLE"); }
            using (file)
            {
                // 1. Trailer: exact layout, range and pinned hash, before anything else is read.
                long fileLength = file.Length;
                if (fileLength < TrailerBytes + 1) throw Fail("TRAILER_MISSING");
                byte[] trailer = new byte[TrailerBytes];
                file.Seek(fileLength - TrailerBytes, SeekOrigin.Begin);
                ReadExactly(file, trailer, TrailerBytes, "TRAILER_MISSING");
                for (int i = 0; i < Magic.Length; i++) if (trailer[i] != Magic[i]) throw Fail("TRAILER_MAGIC");
                ulong offset = BitConverter.ToUInt64(trailer, 16), length = BitConverter.ToUInt64(trailer, 24);
                if (!BitConverter.IsLittleEndian) throw Fail("PLATFORM");
                ulong payloadEnd = (ulong)(fileLength - TrailerBytes);
                // No overflow, a non-empty prefix (the PE), a non-empty payload and no overlap with the trailer.
                if (offset == 0 || length == 0 || offset > payloadEnd || length > payloadEnd - offset) throw Fail("TRAILER_RANGE");
                byte[] trailerHash = new byte[32]; Array.Copy(trailer, 32, trailerHash, 0, 32);
                if (!Same(trailerHash, expected)) throw Fail("TRAILER_HASH");
                // 2. Streamed SHA-256 of exactly the payload range on the same deny-write handle.
                using (SHA256 sha = SHA256.Create())
                {
                    file.Seek((long)offset, SeekOrigin.Begin);
                    byte[] buffer = new byte[81920]; long remaining = (long)length;
                    while (remaining > 0)
                    {
                        int read = file.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                        if (read <= 0) throw Fail("TRAILER_RANGE");
                        sha.TransformBlock(buffer, 0, read, null, 0); remaining -= read;
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    if (!Same(sha.Hash, expected)) throw Fail("PAYLOAD_HASH");
                }
                // 3. Validate every entry (names, kinds, bounds, outer layout) before the stage exists.
                using (ZipArchive zip = OpenZip(new RangeStream(file, (long)offset, (long)length)))
                {
                    List<Planned> plan = Plan(zip, stage);
                    // 4. Fresh, direct stage, then exclusive extraction; a failure retains the stage.
                    CreateStage(stage);
                    try { return Extract(plan, stage, ToHex(expected)); }
                    catch (PayloadException error) { throw new PayloadException(error.Code, stage); }
                    catch (Exception) { throw new PayloadException("IO", stage); }
                }
            }
        }

        private sealed class Planned
        {
            public ZipArchiveEntry Entry; public string Target; public bool Directory; public long DeclaredBytes;
        }

        private static ZipArchive OpenZip(Stream stream)
        {
            try { return new ZipArchive(stream, ZipArchiveMode.Read, false); }
            catch (Exception) { throw Fail("ZIP_INVALID"); }
        }

        private static List<Planned> Plan(ZipArchive zip, string stage)
        {
            List<Planned> plan = new List<Planned>();
            Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase); // value: is directory
            int count = 0; long total = 0; bool manifest = false, bundle = false;
            System.Collections.ObjectModel.ReadOnlyCollection<ZipArchiveEntry> entries;
            try { entries = zip.Entries; } catch (Exception) { throw Fail("ZIP_INVALID"); }
            foreach (ZipArchiveEntry entry in entries)
            {
                if (++count > MaxEntries) throw Fail("LIMIT");
                string name = entry.FullName;
                bool isDirectory = name.EndsWith("/", StringComparison.Ordinal);
                string path = isDirectory ? name.Substring(0, name.Length - 1) : name;
                ValidateName(path);
                // Unix symlink or any non-regular type recorded in external attributes is refused.
                int unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
                if (unixMode != 0 && unixMode != 0x8000 && unixMode != 0x4000) throw Fail("ENTRY_LINK");
                if ((entry.ExternalAttributes & 0x400) != 0) throw Fail("ENTRY_LINK"); // FILE_ATTRIBUTE_REPARSE_POINT
                string top = path.Split('/')[0];
                if (path == "kit-manifest.json") { if (isDirectory) throw Fail("ENTRY_UNEXPECTED"); manifest = true; }
                else if (top == "bundle") { if (path != "bundle") bundle = true; }
                else if (top != "kit") throw Fail("ENTRY_UNEXPECTED");
                if (isDirectory && entry.Length != 0) throw Fail("ENTRY_SIZE");
                if (entry.Length < 0 || entry.Length > MaxFileBytes) throw Fail("ENTRY_SIZE");
                total += entry.Length; if (total > MaxTotalBytes) throw Fail("LIMIT");
                // Duplicates (case-insensitive) and file/directory prefix conflicts.
                bool existingIsDirectory;
                if (seen.TryGetValue(path, out existingIsDirectory)) { if (!(isDirectory && existingIsDirectory)) throw Fail("ENTRY_DUPLICATE"); continue; }
                string[] parts = path.Split('/');
                string prefix = "";
                for (int i = 0; i < parts.Length - 1; i++)
                {
                    prefix = i == 0 ? parts[0] : prefix + "/" + parts[i];
                    bool prefixIsDirectory;
                    if (seen.TryGetValue(prefix, out prefixIsDirectory)) { if (!prefixIsDirectory) throw Fail("ENTRY_DUPLICATE"); }
                    else seen[prefix] = true;
                }
                seen[path] = isDirectory;
                string target = stage + "\\" + path.Replace('/', '\\');
                if (target.Length > MaxPathChars) throw Fail("PATH_TOO_LONG");
                Planned planned = new Planned(); planned.Entry = entry; planned.Target = target; planned.Directory = isDirectory; planned.DeclaredBytes = entry.Length;
                plan.Add(planned);
            }
            if (!manifest || !bundle) throw Fail("ENTRY_UNEXPECTED");
            return plan;
        }

        private static void ValidateName(string path)
        {
            if (path.Length == 0 || path.Length > MaxEntryNameChars || path.IndexOf('\\') >= 0 || path.StartsWith("/", StringComparison.Ordinal) ||
                path.IndexOf(':') >= 0) throw Fail("ENTRY_NAME");
            string[] parts = path.Split('/');
            if (parts.Length > MaxDepth) throw Fail("ENTRY_NAME");
            foreach (string part in parts)
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal)) throw Fail("ENTRY_NAME");
                foreach (char c in part) if (c < 0x20 || c == 0x7f || c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') throw Fail("ENTRY_NAME");
                string stem = part.Split('.')[0].ToLowerInvariant();
                foreach (string device in Devices) if (stem == device) throw Fail("ENTRY_NAME");
            }
        }

        private static void CreateStage(string stage)
        {
            string parent = Path.GetDirectoryName(stage);
            if (string.IsNullOrEmpty(parent) || !Directory.Exists(parent)) throw Fail("STAGE_PARENT");
            AssertDirectChain(parent);
            if (!CreateDirectoryW(stage, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw Fail(error == 183 /* ERROR_ALREADY_EXISTS */ ? "STAGE_EXISTS" : "STAGE_CREATE");
            }
            AssertDirectChain(stage);
        }

        /// <summary>Every existing component from the volume root down is a real directory, not a reparse point.</summary>
        private static void AssertDirectChain(string path)
        {
            string current = path;
            while (!string.IsNullOrEmpty(current))
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(current); } catch (Exception) { throw Fail("REPARSE"); }
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw Fail("REPARSE");
                string next = Path.GetDirectoryName(current);
                if (next == null || next == current) break;
                current = next;
            }
        }

        private static PayloadReceipt Extract(List<Planned> plan, string stage, string payloadHex)
        {
            HashSet<string> created = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            created.Add(stage);
            PayloadReceipt receipt = new PayloadReceipt(); receipt.StagePath = stage; receipt.PayloadSha256 = payloadHex;
            byte[] buffer = new byte[81920];
            foreach (Planned item in plan)
            {
                string directory = item.Directory ? item.Target : Path.GetDirectoryName(item.Target);
                EnsureDirectories(stage, directory, created, receipt);
                if (item.Directory) continue;
                AssertDirectChain(directory);
                long written = 0;
                using (Stream input = item.Entry.Open())
                using (FileStream output = new FileStream(item.Target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    if ((File.GetAttributes(item.Target) & FileAttributes.ReparsePoint) != 0) throw Fail("REPARSE");
                    while (true)
                    {
                        int read = input.Read(buffer, 0, buffer.Length);
                        if (read <= 0) break;
                        written += read;
                        // The declared size is a bound, not a hint: more bytes than declared is refused (no zip bomb).
                        if (written > item.DeclaredBytes || written > MaxFileBytes) throw Fail("ENTRY_SIZE");
                        output.Write(buffer, 0, read);
                    }
                    output.Flush(true);
                }
                if (written != item.DeclaredBytes) throw Fail("ENTRY_SIZE");
                receipt.Files++; receipt.Bytes += written;
                if (receipt.Bytes > MaxTotalBytes) throw Fail("LIMIT");
            }
            return receipt;
        }

        private static void EnsureDirectories(string stage, string directory, HashSet<string> created, PayloadReceipt receipt)
        {
            if (created.Contains(directory)) return;
            string relative = directory.Substring(stage.Length).TrimStart('\\');
            string current = stage;
            foreach (string part in relative.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
            {
                current = current + "\\" + part;
                if (created.Contains(current)) continue;
                if (!CreateDirectoryW(current, IntPtr.Zero)) throw Fail(Marshal.GetLastWin32Error() == 183 ? "ENTRY_DUPLICATE" : "IO");
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw Fail("REPARSE");
                created.Add(current); receipt.Directories++;
            }
        }

        private static string CanonicalAbsolute(string value, string code)
        {
            if (value == null || value.Length == 0 || value.Length > MaxPathChars || value != value.Trim() || value.IndexOf('\0') >= 0) throw Fail(code);
            if (value.Length < 3 || !char.IsLetter(value[0]) || value[1] != ':' || value[2] != '\\') throw Fail(code); // drive-absolute only; no UNC or device paths
            string full;
            try { full = Path.GetFullPath(value); } catch (Exception) { throw Fail(code); }
            if (!string.Equals(full, value, StringComparison.Ordinal) || value.IndexOf('/') >= 0) throw Fail(code);
            if (value.Substring(2).IndexOf(':') >= 0) throw Fail(code); // no alternate data streams
            return full;
        }

        private static byte[] ParseHash(string hex)
        {
            if (hex == null || hex.Length != 64) throw Fail("EXPECTED_HASH");
            byte[] bytes = new byte[32];
            for (int i = 0; i < 32; i++)
            {
                int hi = Nibble(hex[2 * i]), lo = Nibble(hex[2 * i + 1]);
                if (hi < 0 || lo < 0) throw Fail("EXPECTED_HASH");
                bytes[i] = (byte)((hi << 4) | lo);
            }
            return bytes;
        }
        private static int Nibble(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; }
        private static string ToHex(byte[] bytes) { StringBuilder s = new StringBuilder(64); foreach (byte b in bytes) s.Append(b.ToString("x2")); return s.ToString(); }
        private static bool Same(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0; for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i]; return diff == 0;
        }
        private static void ReadExactly(Stream stream, byte[] buffer, int count, string code)
        {
            int offset = 0;
            while (offset < count) { int read = stream.Read(buffer, offset, count - offset); if (read <= 0) throw Fail(code); offset += read; }
        }

        /// <summary>Read-only seekable window [start, start+length) over the verified, deny-write file handle.</summary>
        private sealed class RangeStream : Stream
        {
            private readonly Stream inner; private readonly long start, length; private long position;
            public RangeStream(Stream inner, long start, long length) { this.inner = inner; this.start = start; this.length = length; }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return true; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { return length; } }
            public override long Position { get { return position; } set { if (value < 0 || value > length) throw new IOException("range"); position = value; } }
            public override int Read(byte[] buffer, int offset, int count)
            {
                long available = length - position; if (available <= 0) return 0;
                inner.Seek(start + position, SeekOrigin.Begin);
                int read = inner.Read(buffer, offset, (int)Math.Min(count, available)); position += read; return read;
            }
            public override long Seek(long offset, SeekOrigin origin)
            {
                long target = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? position + offset : length + offset;
                Position = target; return position;
            }
            public override void Flush() { }
            public override void SetLength(long value) { throw new NotSupportedException(); }
            public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        }
    }
}
