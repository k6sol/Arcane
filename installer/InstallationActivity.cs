// Read-only installation activity snapshot (C# 5, .NET Framework 4.x, in-box Restart Manager only).
// Registers ONLY the caller's exact, already canonical owned files and asks whether any process is known to use them.
// One RmGetList call with an empty buffer: process records are never fetched, so no identity, name or argument is ever
// read. Idle means "no known users at that instant"; it is NEVER authority to delete or evidence of ownership.
// Callers must establish ownership separately and fence their own operation before and after.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Arcane.Installer
{
    internal enum ActivityState { Idle, Busy, Unknown }

    internal sealed class ActivityResult
    {
        public readonly ActivityState State;
        /// <summary>null, COUNT, DUPLICATE, PATH, NATIVE, REBOOT or CHANGED.</summary>
        public readonly string Code;
        /// <summary>Idle: 0. Busy: known users, capped at <see cref="InstallationActivity.MaxUsers"/>. Unknown: -1.</summary>
        public readonly int Users;
        internal ActivityResult(ActivityState state, string code, int users) { State = state; Code = code; Users = users; }
    }

    internal static class InstallationActivity
    {
        internal const int MaxPaths = 3, MaxUsers = 64;
        private const int ErrorMoreData = 234;

        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        private static extern int RmRegisterResources(uint session, uint files, string[] names, uint applications, IntPtr uniqueProcesses, uint services, string[] serviceNames);
        [DllImport("rstrtmgr.dll")]
        private static extern int RmGetList(uint session, out uint needed, ref uint count, IntPtr infos, ref uint rebootReasons);
        [DllImport("rstrtmgr.dll")]
        private static extern int RmEndSession(uint session);

        private static ActivityResult Unknown(string code) { return new ActivityResult(ActivityState.Unknown, code, -1); }

        /// <summary>Snapshot of known users of 1..3 exact canonical owned files. Never throws, never retries, never terminates anything.</summary>
        public static ActivityResult Inspect(string[] canonicalOwnedPaths)
        {
            string[] paths;
            try
            {
                if (canonicalOwnedPaths == null || canonicalOwnedPaths.Length < 1 || canonicalOwnedPaths.Length > MaxPaths) return Unknown("COUNT");
                paths = (string[])canonicalOwnedPaths.Clone();
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string path in paths)
                {
                    if (!Canonical(path)) return Unknown("PATH");
                    if (!seen.Add(path)) return Unknown("DUPLICATE");
                }
            }
            catch (Exception) { return Unknown("PATH"); }
            ActivityResult result = Query(paths);
            // The snapshot is only reported for files that still exist at the same canonical spelling.
            foreach (string path in paths) if (!Canonical(path)) return result.State == ActivityState.Unknown ? result : Unknown("CHANGED");
            return result;
        }

        private static bool Canonical(string path)
        {
            try { return path != null && string.Equals(SetupPath.CanonicalExecutable(path), path, StringComparison.Ordinal); }
            catch (Exception) { return false; }
        }

        private static ActivityResult Query(string[] paths)
        {
            uint session;
            int started;
            try { started = RmStartSession(out session, 0, new StringBuilder(33)); }
            catch (Exception) { return Unknown("NATIVE"); }
            if (started != 0) return Unknown("NATIVE");
            ActivityResult primary = Unknown("NATIVE");
            try
            {
                if (RmRegisterResources(session, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, null) == 0)
                {
                    uint needed, count = 0, reasons = 0;
                    // Zero-length buffer: only the count is requested. No process record is read or allocated.
                    int listed = RmGetList(session, out needed, ref count, IntPtr.Zero, ref reasons);
                    if (reasons != 0) primary = Unknown("REBOOT");
                    else if (listed == 0 && needed == 0) primary = new ActivityResult(ActivityState.Idle, null, 0);
                    else if (listed == ErrorMoreData && needed > 0) primary = new ActivityResult(ActivityState.Busy, null, (int)Math.Min(needed, (uint)MaxUsers));
                }
            }
            catch (Exception) { primary = Unknown("NATIVE"); }
            finally
            {
                int ended;
                try { ended = RmEndSession(session); } catch (Exception) { ended = -1; }
                // A failed end never upgrades certainty; it does not replace an earlier Unknown code.
                if (ended != 0 && primary.State != ActivityState.Unknown) primary = Unknown("NATIVE");
            }
            return primary;
        }
    }
}
