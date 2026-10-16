// Canonical setup executable path (C# 5, .NET Framework 4.x, kernel32 only). The process may report its own module
// path with 8.3 components; .NET Framework's GetFullPath expands those, so PayloadArchive's canonical admission would
// refuse the short spelling. This helper expands an EXISTING path to its long form and keeps every other admission
// rule strict. It never expands environment variables, starts a shell or process, or touches the network or registry.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Arcane.Installer
{
    internal sealed class SetupPathException : IOException
    {
        /// <summary>PATH, TOO_LONG, MISSING, REDIRECT or NOT_FILE.</summary>
        public readonly string Code;
        public SetupPathException(string code) : base("Setup path unavailable.") { Code = code; }
    }

    internal static class SetupPath
    {
        internal const int MaxInputChars = 1024, MaxPathChars = 259;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint length);

        private static SetupPathException Fail(string code) { return new SetupPathException(code); }

        /// <summary>Returns the canonical long path of an existing local setup executable, or throws <see cref="SetupPathException"/>.</summary>
        public static string CanonicalExecutable(string observedPath)
        {
            string observed = observedPath;
            if (observed == null || observed.Length < 4 || observed.Length > MaxInputChars || !char.IsLetter(observed[0]) || observed[1] != ':' || observed[2] != '\\') throw Fail("PATH");
            foreach (char c in observed) if (c < 0x20 || c == 0x7f || c == '/' || c == '"' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') throw Fail("PATH");
            char last = observed[observed.Length - 1];
            if (observed.Substring(2).IndexOf(':') >= 0 || last == '\\' || last == ' ' || last == '.') throw Fail("PATH");
            // Expands existing 8.3 components only; a missing component fails here.
            StringBuilder buffer = new StringBuilder(MaxInputChars + 1);
            uint length = GetLongPathNameW(observed, buffer, (uint)buffer.Capacity);
            if (length == 0) throw Fail("MISSING");
            if (length >= buffer.Capacity) throw Fail("TOO_LONG");
            string canonical = buffer.ToString();
            if (canonical.Length > MaxPathChars) throw Fail("TOO_LONG");
            string full;
            try { full = Path.GetFullPath(canonical); } catch (Exception) { throw Fail("PATH"); }
            if (!string.Equals(full, canonical, StringComparison.Ordinal) || canonical.Length < 4 || canonical[2] != '\\') throw Fail("PATH");
            FileAttributes leaf = Attributes(canonical);
            if ((leaf & FileAttributes.ReparsePoint) != 0) throw Fail("REDIRECT");
            if ((leaf & FileAttributes.Directory) != 0) throw Fail("NOT_FILE");
            // Every ancestor up to and including the volume root must be a real directory; a volume-root parent is allowed.
            for (string current = Path.GetDirectoryName(canonical); !string.IsNullOrEmpty(current); )
            {
                FileAttributes attributes = Attributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw Fail("REDIRECT");
                string next = Path.GetDirectoryName(current);
                if (next == null || next == current) break;
                current = next;
            }
            return canonical;
        }

        private static FileAttributes Attributes(string path)
        {
            try { return File.GetAttributes(path); }
            catch (FileNotFoundException) { throw Fail("MISSING"); }
            catch (DirectoryNotFoundException) { throw Fail("MISSING"); }
            catch (Exception) { throw Fail("PATH"); }
        }
    }
}
