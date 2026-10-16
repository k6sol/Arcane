// Arcane setup's owned install process: one bundled-Node run of the verified kit CLI.
// Protocol: docs/build/WINDOWS_INSTALLER_PROTOCOL.md. This component never kills, times out or retries
// engine work; it reports Unconfirmed whenever the CLI's single result cannot be proven.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Arcane.Installer
{
    internal enum InstallState { Installed, AlreadyActive, Cancelled, Failed, Unconfirmed }

    internal sealed class InstallProgress
    {
        public readonly string Phase;
        public readonly long FilesCopied, TotalFiles, BytesCopied, TotalBytes;
        internal InstallProgress(string phase, long filesCopied, long totalFiles, long bytesCopied, long totalBytes)
        {
            Phase = phase; FilesCopied = filesCopied; TotalFiles = totalFiles; BytesCopied = bytesCopied; TotalBytes = totalBytes;
        }
    }

    internal sealed class InstallOutcome
    {
        public readonly InstallState State;
        /// <summary>true: new release published; false: previous selection retained; null: unknown.</summary>
        public readonly bool? Published;
        /// <summary>A fixed CLI code, or a controller code for Unconfirmed outcomes. Never diagnostic text.</summary>
        public readonly string Code;
        public readonly string InstallationId, ActiveReleaseId;
        public readonly bool Started, CancelRequested, LockRetained, StagingRetained;
        public readonly int? ExitCode;
        /// <summary>Count only (saturating); stderr contents are never retained.</summary>
        public readonly int StderrBytes;
        internal InstallOutcome(InstallState state, bool? published, string code, string installationId, string activeReleaseId,
            bool started, bool cancelRequested, bool lockRetained, bool stagingRetained, int? exitCode, int stderrBytes)
        {
            State = state; Published = published; Code = code; InstallationId = installationId; ActiveReleaseId = activeReleaseId;
            Started = started; CancelRequested = cancelRequested; LockRetained = lockRetained; StagingRetained = stagingRetained;
            ExitCode = exitCode; StderrBytes = stderrBytes;
        }
    }

    internal static class InstallProcess
    {
        internal const int FrameBytes = 1024, MaxFrames = 16384, StderrLimit = 65536, DrainMilliseconds = 5000, CallbackMilliseconds = 5000;
        private static readonly byte[] CancelFrame = Encoding.ASCII.GetBytes("{\"type\":\"cancel\"}\n");
        private static readonly string[] AdmittedEnvironment = { "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP" };
        private static readonly string[] Phases = { "verifying-source", "copying", "verifying-copy", "publishing", "installed", "already-active" };
        private static readonly string[] ProgressKeys = { "schemaVersion", "type", "phase", "filesCopied", "totalFiles", "bytesCopied", "totalBytes" };
        private static readonly string[] ResultKeys = { "schemaVersion", "type", "state", "published", "code", "installationId", "activeReleaseId", "abort", "lockRetained", "stagingRetained" };
        private static readonly HashSet<string> CliCodes = new HashSet<string>(new string[] {
            "CANCELLED", "CHANGED", "COPY", "INPUT", "IO", "JSON", "LOCKED", "LOCK_CHANGED", "LOCK_UNCONFIRMED", "MANIFEST",
            "OVERLAP", "PATH", "PATH_LENGTH", "PROGRESS", "PUBLISH_UNCONFIRMED", "RECORD", "REDIRECT", "RELEASE_CHANGED", "RELEASE_MISSING", "RETENTION",
            "SIZE", "SOURCE_CHANGED", "UNOWNED", "PROTOCOL", "PARENT_LOST", "OUTPUT", "ARGUMENTS", "RESULT", "ENGINE"
        }, StringComparer.Ordinal);

        /// <summary>Runs the verified kit CLI once. The task always completes with an outcome; it never throws for process or protocol failures.</summary>
        public static Task<InstallOutcome> Run(KitReceipt kit, string installRoot, Action<InstallProgress> onProgress, CancellationToken cancellation)
        {
            return Task.Factory.StartNew(delegate { return RunSafely(kit, installRoot, onProgress, cancellation); },
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }

        private static InstallOutcome NotStarted(string code)
        {
            return new InstallOutcome(InstallState.Unconfirmed, null, code, null, null, false, false, false, false, null, 0);
        }

        private static InstallOutcome RunSafely(KitReceipt kit, string installRoot, Action<InstallProgress> onProgress, CancellationToken cancellation)
        {
            ProcessStartInfo info;
            try { info = StartInfo(kit, installRoot); }
            catch (Exception) { return NotStarted("INTERNAL"); }
            if (info == null) return NotStarted("INPUT");
            // No process exists yet, so nothing can have been published.
            if (cancellation.IsCancellationRequested) return new InstallOutcome(InstallState.Cancelled, false, "CANCELLED", null, null, false, true, false, false, null, 0);
            Process process = new Process(); process.StartInfo = info;
            try { if (!process.Start()) { process.Dispose(); return NotStarted("START"); } }
            catch (Exception) { try { process.Dispose(); } catch (Exception) { } return NotStarted("START"); }
            // From here the owned process is always awaited before an outcome is returned.
            return new Session(process, onProgress).Complete(cancellation);
        }

        private static ProcessStartInfo StartInfo(KitReceipt kit, string installRoot)
        {
            if (kit == null) return null;
            string node = kit.NodeExecutable, entry = kit.EntryPoint, bundle = kit.BundleDirectory;
            if (!DirectPath(node) || !DirectPath(entry) || !DirectPath(bundle) || !DirectPath(installRoot)) return null;
            if (!string.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetFileName(entry), "windows-install-cli.mjs", StringComparison.Ordinal)) return null;
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = Quote(entry) + " --bundle " + Quote(bundle) + " --install-root " + Quote(installRoot);
            info.WorkingDirectory = Path.GetDirectoryName(entry);
            info.UseShellExecute = false; info.CreateNoWindow = true; info.ErrorDialog = false;
            info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.EnvironmentVariables.Clear();
            foreach (string name in AdmittedEnvironment)
            {
                string value = Environment.GetEnvironmentVariable(name);
                if (DirectPath(value)) info.EnvironmentVariables[name] = value;
                else if (name == "SystemDrive" && value != null && value.Length == 2 && char.IsLetter(value[0]) && value[1] == ':') info.EnvironmentVariables[name] = value;
            }
            return info;
        }

        /// <summary>Drive-absolute canonical path without quotes, control characters or trailing separators, below MAX_PATH.</summary>
        private static bool DirectPath(string path)
        {
            if (string.IsNullOrEmpty(path) || path.Length < 4 || path.Length > 259 || !char.IsLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
            foreach (char c in path) if (c < 0x20 || c == 0x7f || c == '"' || c == '/') return false;
            char last = path[path.Length - 1];
            if (last == '\\' || last == ' ' || last == '.') return false;
            try { return string.Equals(Path.GetFullPath(path), path, StringComparison.Ordinal); }
            catch (Exception) { return false; }
        }

        /// <summary>CommandLineToArgvW quoting. Paths contain no quotes; trailing backslashes before the closing quote are doubled.</summary>
        internal static string Quote(string value)
        {
            int trailing = 0;
            while (trailing < value.Length && value[value.Length - 1 - trailing] == '\\') trailing++;
            return "\"" + value + new string('\\', trailing) + "\"";
        }

        private sealed class ResultFrame
        {
            public string State, Code, InstallationId, ActiveReleaseId, Abort;
            public bool? Published;
            public bool LockRetained, StagingRetained;
        }

        private sealed class Session
        {
            private readonly Process process;
            private readonly CallbackPump pump;
            private readonly object gate = new object();
            private bool exited, cancelRequested, frameViolation, duplicateResult, outputFault;
            private int frames, stderrBytes;
            private ResultFrame result;
            private Stream stdin, stdout, stderr;

            public Session(Process owned, Action<InstallProgress> onProgress) { process = owned; pump = new CallbackPump(onProgress); }

            public InstallOutcome Complete(CancellationToken cancellation)
            {
                bool internalFailure = false; Thread outputReader = null, errorReader = null;
                try
                {
                    stdin = process.StandardInput.BaseStream; stdout = process.StandardOutput.BaseStream; stderr = process.StandardError.BaseStream;
                    outputReader = Background(ReadOutput); errorReader = Background(ReadError); pump.Start();
                }
                catch (Exception) { internalFailure = true; }
                CancellationTokenRegistration registration = default(CancellationTokenRegistration);
                try { registration = cancellation.Register(SendCancel); }
                catch (Exception) { internalFailure = true; }
                // The engine decides when it is finished: no timeout, no kill.
                process.WaitForExit();
                lock (gate) exited = true;
                try { registration.Dispose(); } catch (Exception) { }
                try { if (stdin != null) stdin.Dispose(); } catch (Exception) { }
                int exitCode = process.ExitCode;
                // Bounded post-exit drain; descendants holding the pipes cannot hold the setup.
                Stopwatch drain = Stopwatch.StartNew();
                bool drained = outputReader != null && errorReader != null && outputReader.Join(DrainMilliseconds) &&
                    errorReader.Join(Math.Max(0, DrainMilliseconds - (int)drain.ElapsedMilliseconds));
                pump.Complete(drained ? CallbackMilliseconds : 0);
                if (drained) { try { process.Dispose(); } catch (Exception) { } }
                else Background(Abandon);
                try { return Classify(exitCode, drained, internalFailure); }
                catch (Exception) { return Unconfirmed("INTERNAL", exitCode); }
            }

            private void Abandon()
            {
                // Closing an owned pipe can block while its reader is pending, so it never runs on the caller's thread.
                try { if (stdout != null) stdout.Dispose(); } catch (Exception) { }
                try { if (stderr != null) stderr.Dispose(); } catch (Exception) { }
                try { process.Dispose(); } catch (Exception) { }
            }

            private static Thread Background(ThreadStart body)
            {
                Thread thread = new Thread(body); thread.IsBackground = true; thread.Start(); return thread;
            }

            private void SendCancel()
            {
                lock (gate)
                {
                    if (exited || cancelRequested) return;
                    cancelRequested = true;
                    try { stdin.Write(CancelFrame, 0, CancelFrame.Length); stdin.Flush(); } catch (Exception) { /* The CLI reports what it observed. */ }
                }
            }

            private InstallOutcome Unconfirmed(string code, int exitCode)
            {
                bool cancel; int errors; lock (gate) { cancel = cancelRequested; errors = stderrBytes; }
                return new InstallOutcome(InstallState.Unconfirmed, null, code, null, null, true, cancel, false, false, exitCode, errors);
            }

            private InstallOutcome Classify(int exitCode, bool drained, bool internalFailure)
            {
                ResultFrame frame; bool cancel; int errors;
                lock (gate)
                {
                    if (internalFailure) return Unconfirmed("INTERNAL", exitCode);
                    if (!drained || outputFault) return Unconfirmed("DRAIN", exitCode);
                    if (frameViolation) return Unconfirmed("FRAME", exitCode);
                    if (duplicateResult) return Unconfirmed("RESULT_DUPLICATE", exitCode);
                    if (result == null) return Unconfirmed("RESULT_MISSING", exitCode);
                    if (stderrBytes > 0) return Unconfirmed("STDERR", exitCode);
                    frame = result; cancel = cancelRequested; errors = stderrBytes;
                }
                InstallState state; int expected;
                switch (frame.State)
                {
                    case "installed": state = InstallState.Installed; expected = 0; break;
                    case "already-active": state = InstallState.AlreadyActive; expected = 0; break;
                    case "cancelled": state = InstallState.Cancelled; expected = 2; break;
                    default: state = InstallState.Failed; expected = 1; break;
                }
                if (exitCode != expected) return Unconfirmed("EXIT_MISMATCH", exitCode);
                // A cancel or cancel-abort the controller never sent cannot be confirmed.
                if ((state == InstallState.Cancelled || frame.Abort == "cancel") && !cancel) return Unconfirmed("FRAME", exitCode);
                return new InstallOutcome(state, frame.Published, frame.Code, frame.InstallationId, frame.ActiveReleaseId, true, cancel,
                    frame.LockRetained, frame.StagingRetained, exitCode, errors);
            }

            private void ReadError()
            {
                byte[] buffer = new byte[4096];
                try
                {
                    int count;
                    while ((count = stderr.Read(buffer, 0, buffer.Length)) > 0) lock (gate) stderrBytes = (int)Math.Min((long)StderrLimit, (long)stderrBytes + count);
                }
                catch (Exception) { lock (gate) outputFault = true; }
            }

            private void ReadOutput()
            {
                byte[] buffer = new byte[4096], line = new byte[FrameBytes]; int length = 0; bool broken = false;
                try
                {
                    int count;
                    while ((count = stdout.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        for (int i = 0; i < count; i++)
                        {
                            // After a violation the pipe is still drained so the CLI never blocks, but nothing more is parsed.
                            if (broken) continue;
                            if (length == FrameBytes) { broken = true; Violation(); continue; }
                            line[length++] = buffer[i];
                            if (buffer[i] == (byte)'\n') { if (!Frame(line, length)) { broken = true; Violation(); } length = 0; }
                        }
                    }
                    if (length > 0 && !broken) Violation();
                }
                catch (Exception) { lock (gate) outputFault = true; }
            }

            private void Violation() { lock (gate) frameViolation = true; }

            private bool Frame(byte[] line, int length)
            {
                lock (gate) { if (++frames > MaxFrames) return false; }
                string text;
                try { text = new UTF8Encoding(false, true).GetString(line, 0, length - 1); }
                catch (Exception) { return false; }
                bool progress = text.StartsWith("{\"schemaVersion\":1,\"type\":\"progress\",", StringComparison.Ordinal);
                bool terminal = text.StartsWith("{\"schemaVersion\":1,\"type\":\"result\",", StringComparison.Ordinal);
                if (!progress && !terminal) return false;
                Dictionary<string, object> value;
                try
                {
                    JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = FrameBytes * 4; json.RecursionLimit = 4;
                    value = json.DeserializeObject(text) as Dictionary<string, object>;
                    // Canonical form only: exactly what the CLI's JSON.stringify emits (no whitespace, duplicates or reordered keys).
                    if (value == null || json.Serialize(value) != text) return false;
                }
                catch (Exception) { return false; }
                lock (gate)
                {
                    if (result != null) { if (terminal) duplicateResult = true; return terminal; }
                }
                if (progress)
                {
                    if (!Exact(value, ProgressKeys)) return false;
                    string phase = value["phase"] as string; long files = Counter(value["filesCopied"]), totalFiles = Counter(value["totalFiles"]);
                    long bytes = Counter(value["bytesCopied"]), totalBytes = Counter(value["totalBytes"]);
                    if (Array.IndexOf(Phases, phase) < 0 || files < 0 || totalFiles < 0 || bytes < 0 || totalBytes < 0 || files > totalFiles || bytes > totalBytes) return false;
                    pump.Post(new InstallProgress(phase, files, totalFiles, bytes, totalBytes));
                    return true;
                }
                ResultFrame parsed = Result(value);
                if (parsed == null) return false;
                lock (gate) result = parsed;
                return true;
            }

            private static ResultFrame Result(Dictionary<string, object> value)
            {
                if (!Exact(value, ResultKeys) || !(value["lockRetained"] is bool) || !(value["stagingRetained"] is bool)) return null;
                ResultFrame frame = new ResultFrame();
                frame.State = value["state"] as string; frame.Abort = value["abort"] as string;
                frame.LockRetained = (bool)value["lockRetained"]; frame.StagingRetained = (bool)value["stagingRetained"];
                object published = value["published"];
                if (published is bool) frame.Published = (bool)published; else if (published != null) return null;
                object code = value["code"], installation = value["installationId"], release = value["activeReleaseId"], abort = value["abort"];
                if (code != null && !Code(code as string)) return null;
                frame.Code = code as string;
                if (abort != null && Array.IndexOf(new string[] { "cancel", "protocol", "parent-lost", "output" }, frame.Abort) < 0) return null;
                bool success = frame.State == "installed" || frame.State == "already-active";
                if (success)
                {
                    if (frame.Code != null || frame.LockRetained || frame.StagingRetained || !Uuid(installation as string) || !Release(release as string)) return null;
                    if (frame.Published != (frame.State == "installed")) return null;
                    frame.InstallationId = (string)installation; frame.ActiveReleaseId = (string)release;
                    return frame;
                }
                if (installation != null || release != null) return null;
                if (frame.State == "cancelled") return frame.Code == "CANCELLED" && frame.Published == false && frame.Abort == "cancel" ? frame : null;
                return frame.State == "failed" && frame.Code != null ? frame : null;
            }

            private static bool Exact(Dictionary<string, object> value, string[] keys)
            {
                if (value.Count != keys.Length) return false;
                foreach (string key in keys) if (!value.ContainsKey(key)) return false;
                return true;
            }
            private static long Counter(object value)
            {
                if (value is int) return (int)value;
                if (value is long) return (long)value;
                return -1;
            }
            private static bool Code(string value)
            {
                return value != null && CliCodes.Contains(value);
            }
            private static bool Hex(string value, int start, int count)
            {
                for (int i = start; i < start + count; i++) { char c = value[i]; if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return false; }
                return true;
            }
            private static bool Uuid(string value)
            {
                return value != null && value.Length == 36 && value[8] == '-' && value[13] == '-' && value[18] == '-' && value[23] == '-' &&
                    Hex(value, 0, 8) && Hex(value, 9, 4) && Hex(value, 14, 4) && Hex(value, 19, 4) && Hex(value, 24, 12);
            }
            private static bool Release(string value)
            {
                return value != null && value.Length == 101 && Hex(value, 0, 64) && value[64] == '-' && Uuid(value.Substring(65));
            }
        }

        /// <summary>Delivers progress off the pipe reader. Consecutive copy counters coalesce; a failing callback stops further delivery only.</summary>
        private sealed class CallbackPump
        {
            internal const int QueueLimit = 32;
            private readonly Action<InstallProgress> callback;
            private readonly LinkedList<InstallProgress> queue = new LinkedList<InstallProgress>();
            private readonly object gate = new object();
            private bool completed, faulted;
            private Thread thread;

            public CallbackPump(Action<InstallProgress> onProgress) { callback = onProgress; }

            public void Start()
            {
                if (callback == null) return;
                thread = new Thread(Loop); thread.IsBackground = true; thread.Start();
            }

            public void Post(InstallProgress progress)
            {
                lock (gate)
                {
                    if (callback == null || faulted || completed) return;
                    // Hard bound while a callback is slow: never more than QueueLimit pending items, and no per-frame worker tasks.
                    if (queue.Last != null && (queue.Count >= QueueLimit || progress.Phase == "copying" && queue.Last.Value.Phase == "copying")) queue.Last.Value = progress;
                    else queue.AddLast(progress);
                    Monitor.Pulse(gate);
                }
            }

            public void Complete(int waitMilliseconds)
            {
                lock (gate) { completed = true; Monitor.Pulse(gate); }
                // A callback that does not return is abandoned on its background thread; it cannot hold the outcome.
                if (thread != null) thread.Join(waitMilliseconds);
            }

            private void Loop()
            {
                while (true)
                {
                    InstallProgress next;
                    lock (gate)
                    {
                        while (queue.Count == 0 && !completed) Monitor.Wait(gate);
                        if (queue.Count == 0 || faulted) return;
                        next = queue.First.Value; queue.RemoveFirst();
                    }
                    try { callback(next); }
                    catch (Exception) { lock (gate) { faulted = true; queue.Clear(); } return; }
                }
            }
        }
    }
}
