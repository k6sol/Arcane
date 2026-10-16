// Fixed current-user uninstall registration. Metadata is checked through the same key handle that is changed or deleted.
// Existing unrecorded keys, extra values, subkeys and changed bytes are kept. Registry checks are cooperative: there is
// no atomic compare-and-delete against another process running as the same user. No recursive deletion or CLI paths.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal enum RegistrationState { Created, Updated, Unchanged, Deleted, Absent, Kept, Refused, Unknown }

    internal sealed class RegistrationResult
    {
        public readonly RegistrationState State;
        public readonly string Code;
        public readonly RegistrationDescriptor Descriptor;
        public readonly bool KeyCreated;
        public readonly int ValuesWritten;
        public readonly int ValuesPrepared;
        public readonly bool? Committed;
        internal RegistrationResult(RegistrationState state, string code, RegistrationDescriptor descriptor, bool created, int written)
            : this(state, code, descriptor, created, written, written, state == RegistrationState.Unknown ? (bool?)null : state == RegistrationState.Created || state == RegistrationState.Updated || state == RegistrationState.Deleted) { }
        internal RegistrationResult(RegistrationState state, string code, RegistrationDescriptor descriptor, bool created, int written, int prepared, bool? committed)
        { State = state; Code = code; Descriptor = descriptor; KeyCreated = created; ValuesWritten = written; ValuesPrepared = prepared; Committed = committed; }
    }

    internal sealed class RegistrationPreparation
    {
        public readonly RegistrationResult Observation;
        public readonly RegistrationIntent Intent;
        internal RegistrationPreparation(RegistrationResult observation, RegistrationIntent intent) { Observation = observation; Intent = intent; }
    }

    internal static class RegistryNative
    {
        internal const uint Query = 1, Set = 2, CreateSubKey = 4, Delete = 0x10000, View = 0x100, OpenLink = 8;
        internal const uint Access = Query | Set | Delete | View;
        internal const int Missing = 2;
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegOpenKeyExW(SafeRegistryHandle parent, string name, uint options, uint access, out SafeRegistryHandle key);
        [DllImport("advapi32.dll")] internal static extern int RegOpenCurrentUser(uint access, out SafeRegistryHandle key);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegCreateKeyExW(SafeRegistryHandle parent, string name, uint reserved, string cls, uint options, uint access, IntPtr security, out SafeRegistryHandle key, out uint disposition);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegQueryValueExW(SafeRegistryHandle key, string name, IntPtr reserved, out uint type, byte[] data, ref uint size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegSetValueExW(SafeRegistryHandle key, string name, uint reserved, uint type, byte[] data, uint size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegDeleteKeyExW(SafeRegistryHandle key, string name, uint view, uint reserved);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegCreateKeyTransactedW(SafeRegistryHandle parent, string name, uint reserved, string cls, uint options, uint access, IntPtr security, out SafeRegistryHandle key, out uint disposition, IntPtr transaction, IntPtr extended);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegOpenKeyTransactedW(SafeRegistryHandle parent, string name, uint options, uint access, out SafeRegistryHandle key, IntPtr transaction, IntPtr extended);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] internal static extern int RegDeleteKeyTransactedW(SafeRegistryHandle key, string name, uint view, uint reserved, IntPtr transaction, IntPtr extended);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern int RegQueryInfoKeyW(SafeRegistryHandle key, IntPtr cls, IntPtr clsLength, IntPtr reserved, out uint subkeys, IntPtr maxSubkey,
            IntPtr maxClass, out uint values, IntPtr maxValueName, IntPtr maxValue, IntPtr security, out ulong lastWrite);
        [DllImport("ntdll.dll")] private static extern int NtQueryKey(SafeRegistryHandle key, int informationClass, byte[] data, uint size, out uint resultLength);

        // A native object name checks path binding, not a durable key identity. Never returned in customer diagnostics.
        internal static string Name(SafeRegistryHandle key)
        {
            byte[] data = new byte[8192]; uint size;
            if (key == null || key.IsInvalid || key.IsClosed || NtQueryKey(key, 3, data, (uint)data.Length, out size) != 0 || size < 4 || size > data.Length) return null;
            uint chars = BitConverter.ToUInt32(data, 0);
            if (chars == 0 || (chars & 1) != 0 || chars > size - 4) return null;
            return new UnicodeEncoding(false, false, true).GetString(data, 4, (int)chars);
        }

        internal static bool Info(SafeRegistryHandle key, out uint subkeys, out uint values, out ulong time)
        { return RegQueryInfoKeyW(key, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out subkeys, IntPtr.Zero, IntPtr.Zero, out values, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out time) == 0; }

        internal static byte[] Value(SafeRegistryHandle key, string name, out uint type)
        { int error; return Value(key, name, out type, out error); }

        internal static byte[] Value(SafeRegistryHandle key, string name, out uint type, out int error)
        {
            uint size = 0;
            error = RegQueryValueExW(key, name, IntPtr.Zero, out type, null, ref size);
            if (error != 0 || size > 4096) return null;
            byte[] bytes = new byte[size]; uint expected = size, nextType;
            error = RegQueryValueExW(key, name, IntPtr.Zero, out nextType, bytes, ref size);
            if (error != 0 || nextType != type || size != expected) return null;
            return bytes;
        }

        internal static string Text(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 2 || (bytes.Length & 1) != 0 || bytes[bytes.Length - 1] != 0 || bytes[bytes.Length - 2] != 0) return null;
            string text = new UnicodeEncoding(false, false, true).GetString(bytes, 0, bytes.Length - 2);
            return text.IndexOf('\0') < 0 ? text : null;
        }
    }

    internal sealed class RegistryTransaction : IDisposable
    {
        [DllImport("ktmw32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateTransaction(IntPtr attributes, IntPtr uow, uint options, uint isolation, uint flags, uint timeout, string description);
        [DllImport("ktmw32.dll")] private static extern bool CommitTransaction(IntPtr transaction);
        [DllImport("ktmw32.dll")] private static extern bool RollbackTransaction(IntPtr transaction);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        internal readonly IntPtr Handle;
        private bool disposed;
        internal RegistryTransaction()
        {
            Handle = CreateTransaction(IntPtr.Zero, IntPtr.Zero, 0, 0, 0, 0, "Arcane installation");
            if (Handle == IntPtr.Zero || Handle == new IntPtr(-1)) throw new IOException("Registration transaction unavailable.");
        }
        internal bool Commit() { return !disposed && CommitTransaction(Handle); }
        internal bool Rollback() { return !disposed && RollbackTransaction(Handle); }
        public void Dispose() { if (!disposed) { disposed = true; CloseHandle(Handle); } }
    }

    /// <summary>Issued fixed destination. Production opens only the current user's known 64-bit uninstall parent.
    /// The fixture port takes an already-owned handle, never an arbitrary command-line registry path.</summary>
    internal sealed class RegistrationTarget : IDisposable
    {
        internal const string KeyName = "Arcane", FixtureMarker = "ArcaneFixtureOwner";
        internal readonly SafeRegistryHandle Parent;
        private readonly string nativeName, fixtureOwner;
        private readonly bool owns;
        internal uint CreationOptions { get { return fixtureOwner == null ? 0U : 1U; } }
        private RegistrationTarget(SafeRegistryHandle parent, string name, bool owns, string fixtureOwner)
        { Parent = parent; nativeName = name; this.owns = owns; this.fixtureOwner = fixtureOwner; }

        internal bool Current()
        {
            if (nativeName == null || !string.Equals(RegistryNative.Name(Parent), nativeName, StringComparison.OrdinalIgnoreCase)) return false;
            if (fixtureOwner == null) return true;
            uint type; return RegistryNative.Text(RegistryNative.Value(Parent, FixtureMarker, out type)) == fixtureOwner && type == 1;
        }

        internal bool Contains(SafeRegistryHandle key)
        { return Current() && string.Equals(RegistryNative.Name(key), nativeName + "\\" + KeyName, StringComparison.OrdinalIgnoreCase); }

        // Inside a transaction, do not access the same registry objects through ordinary handles. The parent was
        // admitted before starting; compare the transacted object's actual name to that captured destination.
        internal bool ContainsTransacted(SafeRegistryHandle key)
        { return string.Equals(RegistryNative.Name(key), nativeName + "\\" + KeyName, StringComparison.OrdinalIgnoreCase); }

        internal static RegistrationTarget OwnedFixture(SafeRegistryHandle parent, string marker)
        {
            Guid id;
            if (marker == null || !Guid.TryParseExact(marker, "D", out id) || id == Guid.Empty) throw new IOException("Registration fixture unavailable.");
            RegistrationTarget target = new RegistrationTarget(parent, RegistryNative.Name(parent), false, marker);
            if (!target.Current()) throw new IOException("Registration fixture unavailable.");
            return target;
        }

        internal static RegistrationTarget CurrentUser(bool createParents)
        {
            SafeRegistryHandle current;
            uint access = RegistryNative.Query | RegistryNative.View | (createParents ? RegistryNative.CreateSubKey : 0U);
            if (RegistryNative.RegOpenCurrentUser(access, out current) != 0) throw new IOException("Registration unavailable.");
            try
            {
                string name = RegistryNative.Name(current);
                if (name == null) throw new IOException("Registration unavailable.");
                foreach (string part in new[] { "Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall" })
                {
                    SafeRegistryHandle next;
                    int rc = RegistryNative.RegOpenKeyExW(current, part, RegistryNative.OpenLink, access, out next);
                    if (rc == RegistryNative.Missing && createParents)
                    {
                        if (next != null) next.Dispose(); uint disposition;
                        rc = RegistryNative.RegCreateKeyExW(current, part, 0, null, 0, access, IntPtr.Zero, out next, out disposition);
                    }
                    if (rc != 0) { if (next != null) next.Dispose(); throw new IOException("Registration parent unavailable."); }
                    name += "\\" + part;
                    if (!string.Equals(RegistryNative.Name(next), name, StringComparison.OrdinalIgnoreCase))
                    { next.Dispose(); throw new IOException("Registration parent changed."); }
                    uint linkType, linkSize = 0;
                    int link = RegistryNative.RegQueryValueExW(next, "SymbolicLinkValue", IntPtr.Zero, out linkType, null, ref linkSize);
                    if (link != RegistryNative.Missing) { next.Dispose(); throw new IOException("Registration parent unavailable."); }
                    current.Dispose(); current = next;
                }
                RegistrationTarget target = new RegistrationTarget(current, name, true, null); current = null; return target;
            }
            finally { if (current != null) current.Dispose(); }
        }

        public void Dispose() { if (owns) Parent.Dispose(); }
    }

    internal static class RegistrationStore
    {
        internal const string OwnerMarker = "ArcaneSetupOwner";
        private static readonly string[] Names = { OwnerMarker, "DisplayName", "DisplayVersion", "Publisher", "InstallLocation", "DisplayIcon", "UninstallString", "NoModify", "NoRepair", "ArcaneInstallationId" };
        // Trusted deterministic fixture observation only; production leaves it null.
        internal static Action<string> Barrier;
        private sealed class Entry
        {
            internal readonly string Name; internal readonly uint Type; internal readonly byte[] Bytes;
            internal Entry(string name, uint type, byte[] bytes) { Name = name; Type = type; Bytes = bytes; }
        }

        private static RegistrationResult Result(RegistrationState state, string code, RegistrationDescriptor descriptor, bool created, int written)
        { return new RegistrationResult(state, code, descriptor, created, written); }
        private static void ObserveBarrier(string stage) { Action<string> action = Barrier; if (action != null) action(stage); }

        private static string Hash(IList<Entry> values)
        {
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream, Encoding.Unicode))
            {
                writer.Write(values.Count);
                foreach (Entry value in values) { byte[] name = Encoding.Unicode.GetBytes(value.Name); writer.Write(name.Length); writer.Write(name); writer.Write(value.Type); writer.Write(value.Bytes.Length); writer.Write(value.Bytes); }
                writer.Flush(); return InstalledRecord.Sha256Hex(stream.ToArray());
            }
        }

        private static List<Entry> Desired(RegistrationPlan plan, string owner)
        {
            Guid id;
            if (plan == null || plan.Values == null || plan.Values.Count != 9 || !Guid.TryParseExact(owner, "D", out id) || id == Guid.Empty || id.ToString("D") != owner) return null;
            List<Entry> values = new List<Entry> { new Entry(OwnerMarker, 1, Encoding.Unicode.GetBytes(owner + "\0")) };
            for (int i = 0; i < plan.Values.Count; i++)
            {
                RegistrationValue value = plan.Values[i];
                if (value == null || value.Name != Names[i + 1]) return null;
                bool number = value.Name == "NoModify" || value.Name == "NoRepair";
                if (number ? value.Kind != RegistrationKind.DWord || value.Number != 1 : value.Kind != RegistrationKind.String || value.Text == null || value.Text.Length > 2047 || value.Text.IndexOf('\0') >= 0) return null;
                values.Add(new Entry(value.Name, number ? 4U : 1U, number ? BitConverter.GetBytes(1) : Encoding.Unicode.GetBytes(value.Text + "\0")));
            }
            if (plan.Root == null || plan.Root.Length > 259 || plan.Root.IndexOf('"') >= 0 || plan.Root.IndexOf('\0') >= 0 ||
                plan.Values[0].Text != "Arcane" || plan.Values[2].Text != "Arcane" || plan.Values[3].Text != plan.Root || plan.Values[8].Text != plan.InstallationId ||
                plan.Values[4].Text != "\"" + plan.Root + "\\" + (plan.Launcher == null ? SetupOwnership.UninstallerName : SetupOwnership.LauncherName) + "\",0" ||
                plan.Values[5].Text != "\"" + plan.Root + "\\" + SetupOwnership.UninstallerName + "\"") return null;
            return values;
        }

        // Reads only fixed value names. Counts and timestamps fence added values/subkeys and changes during observation.
        private static List<Entry> Read(SafeRegistryHandle key, int count, out ulong time, bool allowZeroTime = false)
        {
            uint subkeys, values; time = 0; ulong before, after;
            if (!RegistryNative.Info(key, out subkeys, out values, out before)) throw new IOException("Registration state unavailable.");
            if (subkeys != 0 || values != count || count < 0 || count > Names.Length) return null;
            List<Entry> entries = new List<Entry>();
            for (int i = 0; i < count; i++)
            {
                uint type; int error; byte[] bytes = RegistryNative.Value(key, Names[i], out type, out error);
                // A missing or resized value is an observed edit. Other query errors cannot establish a changed state.
                if (error != 0 && error != RegistryNative.Missing && error != 234) throw new IOException("Registration value unavailable.");
                bool number = Names[i] == "NoModify" || Names[i] == "NoRepair";
                if (bytes == null || (number ? type != 4 || bytes.Length != 4 : type != 1 || RegistryNative.Text(bytes) == null)) return null;
                entries.Add(new Entry(Names[i], type, bytes));
            }
            if (!RegistryNative.Info(key, out subkeys, out values, out after)) throw new IOException("Registration state unavailable.");
            if (subkeys != 0 || values != count || before != after || !allowZeroTime && after == 0) return null;
            time = after; return entries;
        }

        private static bool Matches(List<Entry> entries, ulong time, RegistrationDescriptor descriptor, string installationId)
        {
            return entries != null && descriptor != null && time == descriptor.LastWriteTime && Hash(entries) == descriptor.ValuesSha256 && entries.Count == Names.Length &&
                RegistryNative.Text(entries[0].Bytes) == descriptor.OwnerId && RegistryNative.Text(entries[9].Bytes) == installationId;
        }

        /// <summary>Reads only. A returned intent must be durably saved by the host before Apply is allowed to mutate a key.</summary>
        public static RegistrationPreparation Prepare(RegistrationPlan plan, RegistrationDescriptor prior, RegistrationTarget target)
        {
            try
            {
                if (target == null || !target.Current()) return new RegistrationPreparation(Result(RegistrationState.Refused, "TARGET", null, false, 0), null);
                string owner = prior == null ? Guid.NewGuid().ToString("D") : prior.OwnerId;
                List<Entry> desired = Desired(plan, owner);
                if (desired == null) return new RegistrationPreparation(Result(RegistrationState.Refused, "PLAN", null, false, 0), null);
                SafeRegistryHandle key;
                int rc = RegistryNative.RegOpenKeyExW(target.Parent, RegistrationTarget.KeyName, RegistryNative.OpenLink, RegistryNative.Query | RegistryNative.View, out key);
                if (rc != 0)
                {
                    if (key != null) key.Dispose();
                    if (rc != RegistryNative.Missing) return new RegistrationPreparation(Result(RegistrationState.Kept, "IO", null, false, 0), null);
                    owner = Guid.NewGuid().ToString("D"); desired = Desired(plan, owner);
                    return new RegistrationPreparation(Result(RegistrationState.Absent, null, null, false, 0), new RegistrationIntent(owner, Hash(desired)));
                }
                using (key)
                {
                    if (prior == null) return new RegistrationPreparation(Result(RegistrationState.Kept, "UNRECORDED", null, false, 0), null);
                    ulong time; List<Entry> values = Read(key, Names.Length, out time);
                    if (!target.Contains(key) || !Matches(values, time, prior, plan.InstallationId)) return new RegistrationPreparation(Result(RegistrationState.Kept, "CHANGED", null, false, 0), null);
                    string hash = Hash(desired);
                    return new RegistrationPreparation(Result(RegistrationState.Unchanged, null, prior, false, 0), hash == prior.ValuesSha256 ? null : new RegistrationIntent(owner, hash));
                }
            }
            catch (Exception) { return new RegistrationPreparation(Result(RegistrationState.Kept, "IO", null, false, 0), null); }
        }

        /// <summary>Resolves durable pending work only to a previously confirmed state, the exact pending desired state,
        /// or proven absence. Matching an owner alone never admits unknown/edited values.</summary>
        public static RegistrationResult Reconcile(RegistrationDescriptor prior, RegistrationIntent pending, string installationId, RegistrationTarget target)
        {
            try
            {
                if (target == null || !target.Current()) return Result(RegistrationState.Kept, "TARGET", null, false, 0);
                SafeRegistryHandle key;
                int rc = RegistryNative.RegOpenKeyExW(target.Parent, RegistrationTarget.KeyName, RegistryNative.OpenLink, RegistryNative.Query | RegistryNative.View, out key);
                if (rc != 0) { if (key != null) key.Dispose(); return Result(rc == RegistryNative.Missing ? RegistrationState.Absent : RegistrationState.Kept, rc == RegistryNative.Missing ? null : "IO", null, false, 0); }
                using (key)
                {
                    ulong time; List<Entry> values = Read(key, Names.Length, out time);
                    if (!target.Contains(key) || values == null) return Result(RegistrationState.Kept, "CHANGED", null, false, 0);
                    if (Matches(values, time, prior, installationId)) return Result(RegistrationState.Unchanged, null, prior, false, 0);
                    if (pending != null && RegistryNative.Text(values[0].Bytes) == pending.OwnerId && RegistryNative.Text(values[9].Bytes) == installationId && Hash(values) == pending.ValuesSha256)
                        return Result(RegistrationState.Unchanged, null, new RegistrationDescriptor(pending.OwnerId, pending.ValuesSha256, time), false, 0);
                    return Result(RegistrationState.Kept, prior == null && pending == null ? "UNRECORDED" : "CHANGED", null, false, 0);
                }
            }
            catch (Exception) { return Result(RegistrationState.Kept, "IO", null, false, 0); }
        }

        private sealed class Stop : Exception
        {
            internal readonly string Code;
            internal Stop(string code) { Code = code; }
        }

        /// <summary>The caller must durably journal this exact intent before entering Apply. All native writes belong
        /// to one transaction; pending recovery admits only the exact committed desired state or the old descriptor.</summary>
        public static RegistrationResult Apply(RegistrationPlan plan, RegistrationDescriptor prior, RegistrationIntent intent, RegistrationTarget target)
        {
            int prepared = 0; bool creationPrepared = false, attempted = false; bool? committed = false;
            RegistryTransaction transaction = null; SafeRegistryHandle key = null;
            try
            {
                if (intent == null || target == null || !target.Current()) return Result(RegistrationState.Refused, "INTENT", null, false, 0);
                List<Entry> desired = Desired(plan, intent.OwnerId);
                if (desired == null || Hash(desired) != intent.ValuesSha256) return Result(RegistrationState.Refused, "INTENT", null, false, 0);
                RegistrationResult before = Reconcile(prior, intent, plan.InstallationId, target);
                if (before.State == RegistrationState.Unchanged && before.Descriptor != null && before.Descriptor.OwnerId == intent.OwnerId && before.Descriptor.ValuesSha256 == intent.ValuesSha256)
                    return before; // an earlier commit is already exactly the recorded desired state
                if (before.State != RegistrationState.Absent && (before.State != RegistrationState.Unchanged || prior == null)) return before;
                transaction = new RegistryTransaction();
                int rc;
                if (before.State == RegistrationState.Absent)
                {
                    uint disposition;
                    rc = RegistryNative.RegCreateKeyTransactedW(target.Parent, RegistrationTarget.KeyName, 0, null, target.CreationOptions, RegistryNative.Access, IntPtr.Zero, out key, out disposition, transaction.Handle, IntPtr.Zero);
                    if (rc != 0) throw new Stop("CREATE");
                    if (disposition != 1) throw new Stop("APPEARED");
                    creationPrepared = true;
                }
                else
                {
                    rc = RegistryNative.RegOpenKeyTransactedW(target.Parent, RegistrationTarget.KeyName, 0, RegistryNative.Access, out key, transaction.Handle, IntPtr.Zero);
                    if (rc != 0) throw new Stop("OPEN");
                }
                if (!target.ContainsTransacted(key)) throw new Stop("TARGET");
                ulong time; List<Entry> known = Read(key, creationPrepared ? 0 : Names.Length, out time, true);
                if (known == null || !creationPrepared && !Matches(known, time, prior, plan.InstallationId)) throw new Stop("CHANGED");
                for (int i = 0; i < desired.Count; i++)
                {
                    ObserveBarrier("before-value");
                    List<Entry> current = Read(key, known.Count, out time, true);
                    if (current == null || Hash(current) != Hash(known)) throw new Stop("CHANGED");
                    Entry value = desired[i];
                    if (RegistryNative.RegSetValueExW(key, value.Name, 0, value.Type, value.Bytes, (uint)value.Bytes.Length) != 0) throw new Stop("WRITE");
                    prepared++;
                    if (creationPrepared) known.Add(value); else known[i] = value;
                }
                List<Entry> final = Read(key, Names.Length, out time, true);
                if (!target.ContainsTransacted(key) || final == null || Hash(final) != intent.ValuesSha256) throw new Stop("CHANGED");
                key.Dispose(); key = null;
                ObserveBarrier("before-commit");
                attempted = true; committed = null;
                if (!transaction.Commit()) return new RegistrationResult(RegistrationState.Unknown, "COMMIT", null, false, 0, prepared, null);
                committed = true; transaction.Dispose(); transaction = null;
                ObserveBarrier("after-commit");
                RegistrationResult observed = Reconcile(null, intent, plan.InstallationId, target);
                if (observed.State != RegistrationState.Unchanged || observed.Descriptor == null)
                    return new RegistrationResult(RegistrationState.Unknown, "CHANGED", null, creationPrepared, desired.Count, prepared, true);
                return new RegistrationResult(creationPrepared ? RegistrationState.Created : RegistrationState.Updated, null, observed.Descriptor, creationPrepared, desired.Count, prepared, true);
            }
            catch (Stop stop)
            {
                if (key != null) { key.Dispose(); key = null; }
                bool rolledBack = transaction != null && transaction.Rollback();
                return new RegistrationResult(rolledBack ? RegistrationState.Kept : RegistrationState.Unknown, stop.Code, null, false, 0, prepared, rolledBack ? (bool?)false : null);
            }
            catch (Exception)
            {
                if (key != null) { key.Dispose(); key = null; }
                if (!attempted)
                {
                    bool rolledBack = transaction == null || transaction.Rollback();
                    return new RegistrationResult(rolledBack ? RegistrationState.Refused : RegistrationState.Unknown, transaction == null ? "TRANSACTION" : "INTERRUPTED", null, false, 0, prepared, rolledBack ? (bool?)false : null);
                }
                return new RegistrationResult(RegistrationState.Unknown, "IO", null, committed == true && creationPrepared, committed == true ? Names.Length : 0, prepared, committed);
            }
            finally { if (key != null) key.Dispose(); if (transaction != null) transaction.Dispose(); }
        }

        public static RegistrationResult Verify(RegistrationDescriptor descriptor, string installationId, RegistrationTarget target)
        {
            try
            {
                if (descriptor == null || target == null || !target.Current()) return Result(RegistrationState.Kept, "TARGET", null, false, 0);
                SafeRegistryHandle key; int rc = RegistryNative.RegOpenKeyExW(target.Parent, RegistrationTarget.KeyName, RegistryNative.OpenLink, RegistryNative.Query | RegistryNative.View, out key);
                if (rc != 0) { if (key != null) key.Dispose(); return Result(RegistrationState.Kept, "IO", null, false, 0); }
                using (key)
                {
                    ulong time; List<Entry> values = Read(key, Names.Length, out time);
                    return target.Contains(key) && Matches(values, time, descriptor, installationId) ? Result(RegistrationState.Unchanged, null, descriptor, false, 0) : Result(RegistrationState.Kept, "CHANGED", null, false, 0);
                }
            }
            catch (Exception) { return Result(RegistrationState.Kept, "IO", null, false, 0); }
        }

        public static RegistrationResult Remove(RegistrationDescriptor descriptor, string installationId, RegistrationTarget target)
        {
            RegistryTransaction transaction = null; SafeRegistryHandle key = null; bool attempted = false; bool? committed = false;
            try
            {
                if (descriptor == null || target == null || !target.Current()) return Result(RegistrationState.Kept, "TARGET", null, false, 0);
                RegistrationResult before = Reconcile(descriptor, null, installationId, target);
                if (before.State != RegistrationState.Unchanged) return before;
                // The fixture can change its own ordinary key here, before any transaction is active. The transacted
                // read below then proves the exact descriptor again; no ordinary operation touches an active key.
                ObserveBarrier("before-delete");
                transaction = new RegistryTransaction();
                int rc = RegistryNative.RegOpenKeyTransactedW(target.Parent, RegistrationTarget.KeyName, 0, RegistryNative.Query | RegistryNative.Delete | RegistryNative.View, out key, transaction.Handle, IntPtr.Zero);
                if (rc != 0) throw new Stop("OPEN");
                ulong time; List<Entry> values = Read(key, Names.Length, out time, true);
                if (!target.ContainsTransacted(key) || !Matches(values, time, descriptor, installationId)) throw new Stop("CHANGED");
                if (RegistryNative.RegDeleteKeyTransactedW(key, string.Empty, RegistryNative.View, 0, transaction.Handle, IntPtr.Zero) != 0) throw new Stop("DELETE");
                key.Dispose(); key = null;
                ObserveBarrier("before-delete-commit");
                attempted = true; committed = null;
                if (!transaction.Commit()) return new RegistrationResult(RegistrationState.Unknown, "COMMIT", null, false, 0, 0, null);
                committed = true; transaction.Dispose(); transaction = null;
                SafeRegistryHandle after;
                int observed = RegistryNative.RegOpenKeyExW(target.Parent, RegistrationTarget.KeyName, RegistryNative.OpenLink, RegistryNative.Query | RegistryNative.View, out after);
                if (after != null) after.Dispose();
                string code = !target.Current() ? "DESTINATION_UNKNOWN" : observed == RegistryNative.Missing ? null : observed == 0 ? "DESTINATION_KEPT" : "DESTINATION_UNKNOWN";
                return new RegistrationResult(RegistrationState.Deleted, code, null, false, 0, 0, true);
            }
            catch (Stop stop)
            {
                if (key != null) { key.Dispose(); key = null; }
                bool rolledBack = transaction != null && transaction.Rollback();
                return new RegistrationResult(rolledBack ? RegistrationState.Kept : RegistrationState.Unknown, stop.Code, null, false, 0, 0, rolledBack ? (bool?)false : null);
            }
            catch (Exception)
            {
                if (key != null) { key.Dispose(); key = null; }
                if (!attempted)
                {
                    bool rolledBack = transaction == null || transaction.Rollback();
                    return new RegistrationResult(rolledBack ? RegistrationState.Kept : RegistrationState.Unknown, transaction == null ? "TRANSACTION" : "INTERRUPTED", null, false, 0, 0, rolledBack ? (bool?)false : null);
                }
                return new RegistrationResult(RegistrationState.Unknown, "IO", null, false, 0, 0, committed);
            }
            finally { if (key != null) key.Dispose(); if (transaction != null) transaction.Dispose(); }
        }

        public static RegistrationResult Remove(RegistrationDescriptor descriptor, RegistrationIntent pending, string installationId, RegistrationTarget target)
        {
            if (pending == null) return Remove(descriptor, installationId, target);
            RegistrationResult observed = Reconcile(descriptor, pending, installationId, target);
            return observed.State == RegistrationState.Unchanged && observed.Descriptor != null ? Remove(observed.Descriptor, installationId, target) : observed;
        }
    }
}
