// Transfers execution to the verified staged image. Arguments identify a target and an inherited wait handle;
// they NEVER grant uninstall permission. The child must validate the installation again and ask the person.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum HandoffState { Started, Refused, Unknown }
    internal sealed class UninstallHandoffResult
    {
        public readonly HandoffState State;
        public readonly string Code, RetainedStage;
        public readonly int? ChildId;
        public readonly UninstallStageCleanup Cleanup;
        internal UninstallHandoffResult(HandoffState state, string code, int? child, string retained, UninstallStageCleanup cleanup)
        { State = state; Code = code; ChildId = child; RetainedStage = retained; Cleanup = cleanup; }
    }

    internal enum ParentExitState { Exited, TimedOut, Refused, Unknown }
    internal sealed class ParentExitResult
    {
        public readonly ParentExitState State;
        public readonly string Code;
        internal ParentExitResult(ParentExitState state, string code) { State = state; Code = code; }
    }

    /// <summary>A private copy of one inherited, identity-checked process handle. No PID lookup, enumeration or process control.</summary>
    internal sealed class UninstallParent : IDisposable
    {
        public readonly string TargetRoot;
        private readonly object gate = new object();
        private SafeWaitHandle handle;
        private bool consumed;
        private UninstallParent(string root, SafeWaitHandle parent) { TargetRoot = root; handle = parent; }

        public static UninstallParent Read(string[] args)
        {
            SafeWaitHandle parent = null;
            try
            {
                if (args == null || args.Length != 8 || args[0] != "--staged-root" || args[2] != "--parent-handle" ||
                    args[4] != "--parent-id" || args[6] != "--parent-created") return null;
                InstalledRecord.DirectRoot(args[1]);
                ulong raw, created; uint id;
                if (!UninstallHandoff.Hex(args[3], out raw) || raw == 0 || raw > long.MaxValue ||
                    !uint.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out id) || id == 0 ||
                    id.ToString(CultureInfo.InvariantCulture) != args[5] || id == UninstallHandoff.GetCurrentProcessId() ||
                    !UninstallHandoff.Hex(args[7], out created)) return null;
                // A command-line number does not convey ownership of a handle already in this process. Close only our
                // private duplicate, including on refusal. The inherited original ends with the child process lifetime.
                parent = UninstallHandoff.CopyParent(new IntPtr((long)raw));
                ulong actual;
                if (parent == null) return null;
                if (parent.IsInvalid || UninstallHandoff.GetProcessId(parent.DangerousGetHandle()) != id ||
                    !UninstallHandoff.Creation(parent.DangerousGetHandle(), out actual) || actual != created)
                { parent.Dispose(); return null; }
                return new UninstallParent(args[1], parent);
            }
            catch (Exception) { if (parent != null) parent.Dispose(); return null; }
        }

        /// <summary>Waits once for actual process termination, including image unmapping. A timeout grants no next step.</summary>
        public ParentExitResult Wait(int milliseconds)
        {
            lock (gate)
            {
                if (consumed || handle == null || handle.IsClosed) return new ParentExitResult(ParentExitState.Refused, "CONSUMED");
                if (milliseconds < 1 || milliseconds > 30000) return new ParentExitResult(ParentExitState.Refused, "TIMEOUT");
                consumed = true;
                try
                {
                    uint result = UninstallHandoff.WaitForSingleObject(handle, (uint)milliseconds);
                    if (result == 0) return new ParentExitResult(ParentExitState.Exited, null);
                    if (result == 258) return new ParentExitResult(ParentExitState.TimedOut, "TIMEOUT");
                    return new ParentExitResult(ParentExitState.Unknown, "WAIT");
                }
                catch (Exception) { return new ParentExitResult(ParentExitState.Unknown, "IO"); }
                finally { handle.Dispose(); handle = null; }
            }
        }
        public void Dispose() { lock (gate) { consumed = true; if (handle != null) { handle.Dispose(); handle = null; } } }
    }

    internal static class UninstallHandoff
    {
        private const uint Synchronize = 0x00100000, QueryLimitedInformation = 0x1000;
        private static readonly object gate = new object();
        private static readonly HashSet<UninstallStage> attempted = new HashSet<UninstallStage>();
        [StructLayout(LayoutKind.Sequential)]
        private struct FileTime { public uint Low, High; }
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out SafeWaitHandle target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);

        internal static bool Creation(IntPtr process, out ulong created)
        {
            FileTime start, end, kernel, user; created = 0;
            if (!GetProcessTimes(process, out start, out end, out kernel, out user)) return false;
            created = ((ulong)start.High << 32) | start.Low; return true;
        }
        internal static SafeWaitHandle CopyParent(IntPtr supplied)
        {
            SafeWaitHandle owned;
            IntPtr self = GetCurrentProcess();
            if (!DuplicateHandle(self, supplied, self, out owned, Synchronize | QueryLimitedInformation, false, 0) || owned == null || owned.IsInvalid)
            { if (owned != null) owned.Dispose(); return null; }
            return owned;
        }
        internal static bool Hex(string text, out ulong value)
        {
            value = 0;
            if (text == null || text.Length != 16) return false;
            foreach (char c in text) if (!(c >= '0' && c <= '9' || c >= 'a' && c <= 'f')) return false;
            return ulong.TryParse(text, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out value);
        }

        /// <summary>Starts the private issued stage once, holding its verified image and directory through Process.Start.
        /// The caller must then exit naturally. It must never wait for the child, which is waiting for this process.</summary>
        public static UninstallHandoffResult Start(UninstallStage stage)
        {
            if (stage == null) return new UninstallHandoffResult(HandoffState.Refused, "STAGE", null, null, null);
            lock (gate) if (!attempted.Add(stage)) return new UninstallHandoffResult(HandoffState.Refused, "CONSUMED", null, stage.Directory, null);
            bool startAttempted = false;
            string failure = "IO";
            UninstallStagePin pin = null;
            SafeWaitHandle parent = null;
            try
            {
                UninstallStagePinResult ready = stage.TryPin(); pin = ready.Pin;
                if (ready.State != UninstallPinState.Pinned || pin == null) failure = ready.Code ?? "STAGE";
                else
                {
                    IntPtr self = GetCurrentProcess(); ulong created;
                    if (!Creation(self, out created) || !DuplicateHandle(self, self, self, out parent, Synchronize | QueryLimitedInformation, true, 0) || parent == null || parent.IsInvalid)
                        failure = "PARENT";
                    else
                    {
                        string root = pin.TargetRoot;
                        // DirectRoot admits neither quotes nor a trailing separator. It is an argument, never shell code.
                        InstalledRecord.DirectRoot(root);
                        string args = "--staged-root \"" + root + "\" --parent-handle " + parent.DangerousGetHandle().ToInt64().ToString("x16", CultureInfo.InvariantCulture) +
                            " --parent-id " + GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) + " --parent-created " + created.ToString("x16", CultureInfo.InvariantCulture);
                        using (Process child = new Process())
                        {
                            child.StartInfo = new ProcessStartInfo(pin.Executable, args)
                            {
                                UseShellExecute = false, WorkingDirectory = stage.Directory, CreateNoWindow = true,
                                // .NET Framework enables handle inheritance for redirected standard handles. The child does not
                                // use stdin as evidence; only its inherited kernel process handle proves actual parent exit.
                                RedirectStandardInput = true
                            };
                            startAttempted = true;
                            if (child.Start()) return new UninstallHandoffResult(HandoffState.Started, null, child.Id, stage.Directory, null);
                            failure = "START";
                        }
                    }
                }
            }
            catch (Exception) { failure = startAttempted ? "START" : "IO"; }
            finally { if (parent != null) parent.Dispose(); if (pin != null) pin.Dispose(); }
            // Once native start was attempted, delivery may be unknown. Keep the image rather than race an unobserved child.
            if (startAttempted) return new UninstallHandoffResult(HandoffState.Unknown, failure, null, stage.Directory, null);
            UninstallStageCleanup cleanup = stage.Cleanup();
            return new UninstallHandoffResult(cleanup.Complete ? HandoffState.Refused : HandoffState.Unknown, failure, null, cleanup.Complete ? null : stage.Directory, cleanup);
        }
    }
}
