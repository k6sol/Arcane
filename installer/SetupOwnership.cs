// Setup ownership journal (C# 5, .NET Framework 4.x, no NuGet): <root>\setup-ownership.json records which small setup
// files this installation's setup placed. It binds the engine installationId and the root path and identity, holds at
// most one descriptor per fixed role, and is itself updated only through OwnedFiles' verified no-overwrite placement with
// the observed journal as compare-and-swap authority. Descriptors are metadata: they never prove a file is still intact.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Arcane.Installer
{
    internal sealed class SetupOwnershipSnapshot
    {
        public readonly string Root, InstallationId;
        /// <summary>False when no journal exists; a save may then only create it exclusively.</summary>
        public readonly bool Present;
        public readonly OwnedFileDescriptor Launcher, Uninstaller;
        internal readonly FileIdentity RootIdentity;
        internal readonly InstalledRecordSnapshot Record;
        /// <summary>The observed journal file (bytes, hash, identity); null when absent.</summary>
        internal readonly OwnedFileDescriptor Journal;
        internal SetupOwnershipSnapshot(InstalledRecordSnapshot record, bool present, OwnedFileDescriptor launcher, OwnedFileDescriptor uninstaller, OwnedFileDescriptor journal)
        {
            Record = record; Root = record.Root; RootIdentity = record.RootIdentity; InstallationId = record.InstallationId;
            Present = present; Launcher = launcher; Uninstaller = uninstaller; Journal = journal;
        }
    }

    internal enum OwnershipReadState { Absent, Valid, Kept }
    internal enum OwnershipSaveState { Saved, Unchanged, Kept, Refused, Unknown }

    internal sealed class OwnershipRead
    {
        public readonly OwnershipReadState State;
        /// <summary>null, or for Kept: MALFORMED, FOREIGN, LINKED, REDIRECT, IN_USE, RECORD_CHANGED or IO.</summary>
        public readonly string Code;
        public readonly SetupOwnershipSnapshot Snapshot;
        internal OwnershipRead(OwnershipReadState state, string code, SetupOwnershipSnapshot snapshot) { State = state; Code = code; Snapshot = snapshot; }
    }

    internal sealed class OwnershipSave
    {
        public readonly OwnershipSaveState State;
        /// <summary>null, BACKUP_RETAINED, DESCRIPTOR, SNAPSHOT, RECORD_CHANGED, or the OwnedFiles code for Kept/Refused/Unknown placements.</summary>
        public readonly string Code;
        public readonly SetupOwnershipSnapshot Snapshot;
        public readonly OwnedFileResult Placement;
        internal OwnershipSave(OwnershipSaveState state, string code, SetupOwnershipSnapshot snapshot, OwnedFileResult placement)
        {
            State = state; Code = code; Snapshot = snapshot; Placement = placement;
        }
    }

    internal static class SetupOwnership
    {
        internal const string JournalName = "setup-ownership.json", LauncherName = "Arcane.exe", UninstallerName = "Uninstall Arcane.exe";
        internal const int MaxJournalBytes = 8192;
        private static readonly string[] Keys = { "schemaVersion", "kind", "installationId", "root", "rootVolume", "rootIndex", "launcher", "uninstaller", "shortcut", "registration" };
        private static readonly string[] DescriptorKeys = { "name", "bytes", "sha256", "volume", "index" };
        private static readonly Regex Hash = new Regex("^[a-f0-9]{64}\\z"), Volume = new Regex("^[a-f0-9]{8}\\z"), Index = new Regex("^[a-f0-9]{16}\\z");
        private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3, ErrorSharingViolation = 32;

        private static OwnershipRead Kept(string code) { return new OwnershipRead(OwnershipReadState.Kept, code, null); }

        /// <summary>Reads the journal of the installation <paramref name="record"/> describes. Never throws and never writes.</summary>
        public static OwnershipRead Read(InstalledRecordSnapshot record)
        {
            try
            {
                if (record == null || !InstalledRecord.StillCurrent(record)) return Kept("RECORD_CHANGED");
                OwnershipRead read = ReadCore(record);
                // The installation must still be the one the journal was bound to after reading it.
                return InstalledRecord.StillCurrent(record) ? read : Kept("RECORD_CHANGED");
            }
            catch (Exception) { return Kept("IO"); }
        }

        private static OwnershipRead ReadCore(InstalledRecordSnapshot record)
        {
            string path = record.Root + "\\" + JournalName;
            SafeFileHandle handle = NativeFile.Open(path, NativeFile.GenericRead, NativeFile.ShareRead, false);
            if (handle == null)
            {
                int error = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                if (!InstalledRecord.Exists(path)) return new OwnershipRead(OwnershipReadState.Absent, null, new SetupOwnershipSnapshot(record, false, null, null, null));
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) return Kept("REDIRECT");
                return Kept(error == ErrorSharingViolation ? "IN_USE" : "IO");
            }
            using (handle)
            {
                FileIdentity identity; FileAttributes attributes; uint links; long size;
                if (!NativeFile.Describe(handle, out identity, out attributes, out links, out size)) return Kept("IO");
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) return Kept("REDIRECT");
                if (links != 1) return Kept("LINKED");
                if (size < 1 || size > MaxJournalBytes) return Kept("MALFORMED");
                byte[] bytes = new byte[size];
                using (FileStream stream = new FileStream(new SafeFileHandle(handle.DangerousGetHandle(), false), FileAccess.Read, 4096, false))
                {
                    int offset = 0, read;
                    while (offset < bytes.Length && (read = stream.Read(bytes, offset, bytes.Length - offset)) > 0) offset += read;
                    if (offset != bytes.Length || stream.ReadByte() != -1) return Kept("MALFORMED");
                }
                Dictionary<string, object> value; string text;
                try
                {
                    text = new UTF8Encoding(false, true).GetString(bytes);
                    JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = MaxJournalBytes; json.RecursionLimit = 4;
                    value = json.DeserializeObject(text) as Dictionary<string, object>;
                }
                catch (Exception) { return Kept("MALFORMED"); }
                if (value == null || !Exact(value, Keys) || !(value["schemaVersion"] is int) || (int)value["schemaVersion"] != 1 ||
                    !"arcane-windows-setup-ownership".Equals(value["kind"]) || value["shortcut"] != null || value["registration"] != null) return Kept("MALFORMED");
                string installationId = value["installationId"] as string, root = value["root"] as string, rootVolume = value["rootVolume"] as string, rootIndex = value["rootIndex"] as string;
                if (installationId == null || root == null || rootVolume == null || rootIndex == null || !Volume.IsMatch(rootVolume) || !Index.IsMatch(rootIndex)) return Kept("MALFORMED");
                OwnedFileDescriptor launcher, uninstaller;
                if (!Descriptor(value["launcher"], LauncherName, record, out launcher) || !Descriptor(value["uninstaller"], UninstallerName, record, out uninstaller)) return Kept("MALFORMED");
                // Exactly the bytes this component writes: no whitespace, reordering, duplicates or trailing data.
                if (!string.Equals(Serialize(installationId, root, rootVolume, rootIndex, launcher, uninstaller), text, StringComparison.Ordinal))
                    return Kept("MALFORMED");
                // A journal for another installation or another root is never adopted.
                if (installationId != record.InstallationId || !string.Equals(root, record.Root, StringComparison.Ordinal) ||
                    rootVolume != Hex8(record.RootIdentity.Volume) || rootIndex != Hex16(record.RootIdentity.Index)) return Kept("FOREIGN");
                OwnedFileDescriptor journal = new OwnedFileDescriptor(record.Root, record.RootIdentity, JournalName, size, Sha(bytes), identity);
                return new OwnershipRead(OwnershipReadState.Valid, null, new SetupOwnershipSnapshot(record, true, launcher, uninstaller, journal));
            }
        }

        /// <summary>Records <paramref name="launcher"/> and <paramref name="uninstaller"/> (each null or bound to this root and role).
        /// Never throws, never retries and never reports a save whose delivery is unknown.</summary>
        public static OwnershipSave Save(SetupOwnershipSnapshot current, OwnedFileDescriptor launcher, OwnedFileDescriptor uninstaller)
        {
            try
            {
                if (current == null || current.Record == null || current.Present != (current.Journal != null)) return new OwnershipSave(OwnershipSaveState.Refused, "SNAPSHOT", null, null);
                if (!Bound(launcher, LauncherName, current) || !Bound(uninstaller, UninstallerName, current)) return new OwnershipSave(OwnershipSaveState.Refused, "DESCRIPTOR", null, null);
                if (!InstalledRecord.StillCurrent(current.Record)) return new OwnershipSave(OwnershipSaveState.Refused, "RECORD_CHANGED", null, null);
                string text = Serialize(current.InstallationId, current.Root, Hex8(current.RootIdentity.Volume), Hex16(current.RootIdentity.Index), launcher, uninstaller);
                byte[] bytes = new UTF8Encoding(false, true).GetBytes(text);
                if (bytes.Length > MaxJournalBytes) return new OwnershipSave(OwnershipSaveState.Refused, "DESCRIPTOR", null, null);
                string sha = Sha(bytes);
                // Even identical bytes go through OwnedFiles: Unchanged is acknowledged only after the CURRENT journal is
                // re-verified (identity, size, hash) against the observed descriptor, never from the snapshot's old hash alone.
                OwnedFileResult placement = OwnedFiles.Place(current.Root, JournalName, bytes, sha, current.Journal);
                if (placement.State == OwnedFileState.Unchanged)
                {
                    if (!InstalledRecord.StillCurrent(current.Record)) return new OwnershipSave(OwnershipSaveState.Unknown, "RECORD_CHANGED", null, placement);
                    return new OwnershipSave(OwnershipSaveState.Unchanged, null, new SetupOwnershipSnapshot(current.Record, true, launcher, uninstaller, placement.Descriptor), placement);
                }
                if (placement.State != OwnedFileState.Placed && placement.State != OwnedFileState.Replaced)
                {
                    OwnershipSaveState state = placement.State == OwnedFileState.Kept ? OwnershipSaveState.Kept : placement.State == OwnedFileState.Refused ? OwnershipSaveState.Refused : OwnershipSaveState.Unknown;
                    return new OwnershipSave(state, placement.Code, null, placement);
                }
                // The journal was published; it is only a confirmed save if the installation is still the same one.
                if (!InstalledRecord.StillCurrent(current.Record)) return new OwnershipSave(OwnershipSaveState.Unknown, "RECORD_CHANGED", null, placement);
                SetupOwnershipSnapshot next = new SetupOwnershipSnapshot(current.Record, true, launcher, uninstaller, placement.Descriptor);
                return new OwnershipSave(OwnershipSaveState.Saved, placement.Code, next, placement);
            }
            catch (Exception) { return new OwnershipSave(OwnershipSaveState.Unknown, "IO", null, null); }
        }

        private static bool Bound(OwnedFileDescriptor descriptor, string name, SetupOwnershipSnapshot current)
        {
            return descriptor == null || string.Equals(descriptor.Root, current.Root, StringComparison.Ordinal) && descriptor.RootIdentity.SameAs(current.RootIdentity) &&
                string.Equals(descriptor.Name, name, StringComparison.Ordinal) && descriptor.Bytes >= 0 && descriptor.Bytes <= OwnedFiles.MaxBytes &&
                descriptor.Sha256 != null && Hash.IsMatch(descriptor.Sha256);
        }

        private static bool Descriptor(object value, string name, InstalledRecordSnapshot record, out OwnedFileDescriptor descriptor)
        {
            descriptor = null;
            if (value == null) return true;
            Dictionary<string, object> d = value as Dictionary<string, object>;
            if (d == null || !Exact(d, DescriptorKeys) || !name.Equals(d["name"])) return false;
            long bytes;
            if (d["bytes"] is int) bytes = (int)d["bytes"]; else if (d["bytes"] is long) bytes = (long)d["bytes"]; else return false;
            string sha = d["sha256"] as string, volume = d["volume"] as string, index = d["index"] as string;
            if (bytes < 0 || bytes > OwnedFiles.MaxBytes || sha == null || !Hash.IsMatch(sha) || volume == null || !Volume.IsMatch(volume) || index == null || !Index.IsMatch(index)) return false;
            FileIdentity identity = new FileIdentity();
            identity.Volume = uint.Parse(volume, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            identity.Index = ulong.Parse(index, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            descriptor = new OwnedFileDescriptor(record.Root, record.RootIdentity, name, bytes, sha, identity);
            return true;
        }

        /// <summary>Canonical journal text: fixed key order, no whitespace, LF. No field refers to the journal's own bytes.</summary>
        private static string Serialize(string installationId, string root, string rootVolume, string rootIndex, OwnedFileDescriptor launcher, OwnedFileDescriptor uninstaller)
        {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["schemaVersion"] = 1; value["kind"] = "arcane-windows-setup-ownership"; value["installationId"] = installationId; value["root"] = root;
            value["rootVolume"] = rootVolume; value["rootIndex"] = rootIndex; value["launcher"] = Entry(launcher); value["uninstaller"] = Entry(uninstaller);
            value["shortcut"] = null; value["registration"] = null;
            JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = MaxJournalBytes * 4;
            return json.Serialize(value) + "\n";
        }

        private static Dictionary<string, object> Entry(OwnedFileDescriptor descriptor)
        {
            if (descriptor == null) return null;
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["name"] = descriptor.Name; value["bytes"] = descriptor.Bytes; value["sha256"] = descriptor.Sha256;
            value["volume"] = Hex8(descriptor.Identity.Volume); value["index"] = Hex16(descriptor.Identity.Index);
            return value;
        }

        private static bool Exact(Dictionary<string, object> value, string[] keys)
        {
            if (value.Count != keys.Length) return false;
            foreach (string key in keys) if (!value.ContainsKey(key)) return false;
            return true;
        }
        private static string Hex8(uint value) { return value.ToString("x8", CultureInfo.InvariantCulture); }
        private static string Hex16(ulong value) { return value.ToString("x16", CultureInfo.InvariantCulture); }
        private static string Sha(byte[] bytes) { using (SHA256 sha = SHA256.Create()) return InstalledRecord.Hex(sha.ComputeHash(bytes)); }
    }
}
