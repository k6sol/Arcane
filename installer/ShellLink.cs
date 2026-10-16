// Fixed Arcane shortcut bytes, built and inspected in memory (C# 5, .NET Framework 4.x, in-box COM only).
// Create: launcher target, install-root working directory, no arguments, description "Arcane", icon (launcher, 0),
// normal show state, no hotkey; serialized through IPersistStream into a memory stream (no file is written).
// Inspect: loads bounded bytes the same way and reports fixed fields; it never calls Resolve, never touches the target and
// never launches anything. A link only describes its target: it proves neither the target's integrity nor its ownership.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;

namespace Arcane.Installer
{
    internal sealed class ShellLinkFields
    {
        public readonly string Target, WorkingDirectory, Arguments, Description, IconPath;
        public readonly int IconIndex, ShowCommand;
        public readonly ushort HotKey;
        internal ShellLinkFields(string target, string workingDirectory, string arguments, string description, string iconPath, int iconIndex, int showCommand, ushort hotKey)
        {
            Target = target; WorkingDirectory = workingDirectory; Arguments = arguments; Description = description;
            IconPath = iconPath; IconIndex = iconIndex; ShowCommand = showCommand; HotKey = hotKey;
        }
    }

    internal sealed class ShellLinkResult
    {
        public readonly bool Ok;
        /// <summary>null, PATH, REDIRECT, TARGET, SIZE, MALFORMED, MISMATCH or COM.</summary>
        public readonly string Code;
        public readonly byte[] Bytes;
        public readonly ShellLinkFields Fields;
        internal ShellLinkResult(bool ok, string code, byte[] bytes, ShellLinkFields fields) { Ok = ok; Code = code; Bytes = bytes; Fields = fields; }
    }

    internal static class ArcaneShellLink
    {
        internal const int MinBytes = 76, MaxBytes = 65536, FieldChars = 1024, MaxNameChars = 100;
        internal const string DescriptionText = "Arcane";
        private const int ShowNormal = 1;
        private const uint RawPath = 0x4; // SLGP_RAWPATH: the stored path, no expansion or resolution

        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLinkObject { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int chars, IntPtr findData, uint flags);
            void GetIDList(out IntPtr idList);
            void SetIDList(IntPtr idList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int chars);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int chars);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int chars);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out ushort hotKey);
            void SetHotkey(ushort hotKey);
            void GetShowCmd(out int showCommand);
            void SetShowCmd(int showCommand);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int chars, out int iconIndex);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, uint reserved);
            void Resolve(IntPtr window, uint flags); // declared for vtable order only; never called
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("00000109-0000-0000-C000-000000000046")]
        private interface IPersistStream
        {
            void GetClassID(out Guid classId);
            [PreserveSig] int IsDirty();
            void Load(IStream stream);
            void Save(IStream stream, [MarshalAs(UnmanagedType.Bool)] bool clearDirty);
            void GetSizeMax(out long size);
        }

        [DllImport("ole32.dll")]
        private static extern int CreateStreamOnHGlobal(IntPtr global, [MarshalAs(UnmanagedType.Bool)] bool deleteOnRelease, out IStream stream);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint length);

        private static ShellLinkResult Refused(string code) { return new ShellLinkResult(false, code, null, null); }

        /// <summary>Builds the fixed Arcane shortcut for <paramref name="launcherPath"/> = installRoot\name. Never throws.</summary>
        public static ShellLinkResult Create(string launcherPath, string installRoot)
        {
            try
            {
                string root;
                try { root = InstalledRecord.DirectRoot(installRoot); }
                catch (InstalledRecordException error) { return Refused(error.Code == "REDIRECT" ? "REDIRECT" : "PATH"); }
                string launcher;
                try { launcher = Launcher(launcherPath, root); } catch (Exception) { launcher = null; }
                if (launcher == null) return Refused("TARGET");
                ShellLinkResult created = Sta(delegate { return Build(launcher, root); });
                if (!created.Ok) return created;
                // Its own bytes must load back to exactly the fixed fields before they are returned.
                ShellLinkResult inspected = Inspect(created.Bytes);
                if (!inspected.Ok) return inspected;
                if (!Describes(inspected.Fields, launcher, root)) return Refused("MISMATCH");
                return new ShellLinkResult(true, null, created.Bytes, inspected.Fields);
            }
            catch (Exception) { return Refused("COM"); }
        }

        /// <summary>Reads fixed fields from bounded link bytes without resolving or touching the target. Never throws.</summary>
        public static ShellLinkResult Inspect(byte[] bytes)
        {
            if (bytes == null || bytes.Length < MinBytes || bytes.Length > MaxBytes) return Refused("SIZE");
            try
            {
                byte[] copy = (byte[])bytes.Clone();
                return Sta(delegate { return Load(copy); });
            }
            catch (Exception) { return Refused("MALFORMED"); }
        }

        /// <summary>True only when every fixed field equals the Arcane shortcut for this launcher and root (ordinal).</summary>
        public static bool Describes(ShellLinkFields fields, string launcherPath, string installRoot)
        {
            return fields != null && launcherPath != null && installRoot != null &&
                string.Equals(fields.Target, launcherPath, StringComparison.Ordinal) && string.Equals(fields.WorkingDirectory, installRoot, StringComparison.Ordinal) &&
                fields.Arguments == string.Empty && fields.Description == DescriptionText && string.Equals(fields.IconPath, launcherPath, StringComparison.Ordinal) &&
                fields.IconIndex == 0 && fields.ShowCommand == ShowNormal && fields.HotKey == 0;
        }

        /// <summary>The launcher must be exactly root\name: one safe component, long-name canonical, an existing regular non-reparse file.</summary>
        private static string Launcher(string launcherPath, string root)
        {
            if (launcherPath == null || launcherPath.Length > 259 || !launcherPath.StartsWith(root + "\\", StringComparison.Ordinal)) return null;
            string name = launcherPath.Substring(root.Length + 1);
            if (name.Length == 0 || name.Length > MaxNameChars || name.EndsWith(".", StringComparison.Ordinal) || name.EndsWith(" ", StringComparison.Ordinal)) return null;
            foreach (char c in name) if (c == '\\' || c == '/' || c == ':' || c < 0x20 || c == 0x7f || c == '"' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*' || c == '%') return null;
            StringBuilder buffer = new StringBuilder(1024);
            uint length = GetLongPathNameW(launcherPath, buffer, (uint)buffer.Capacity);
            if (length == 0 || length >= buffer.Capacity || !string.Equals(buffer.ToString(), launcherPath, StringComparison.Ordinal)) return null;
            if (!string.Equals(Path.GetFullPath(launcherPath), launcherPath, StringComparison.Ordinal)) return null;
            FileAttributes attributes = File.GetAttributes(launcherPath);
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return null;
            return launcherPath;
        }

        private static ShellLinkResult Build(string launcher, string root)
        {
            object link = new ShellLinkObject();
            IStream stream = null;
            try
            {
                IShellLinkW shell = (IShellLinkW)link;
                shell.SetPath(launcher); shell.SetWorkingDirectory(root); shell.SetArguments(string.Empty); shell.SetDescription(DescriptionText);
                shell.SetIconLocation(launcher, 0); shell.SetShowCmd(ShowNormal); shell.SetHotkey(0);
                if (CreateStreamOnHGlobal(IntPtr.Zero, true, out stream) != 0) return Refused("COM");
                ((IPersistStream)link).Save(stream, true);
                System.Runtime.InteropServices.ComTypes.STATSTG stat; stream.Stat(out stat, 1 /* STATFLAG_NONAME */);
                if (stat.cbSize < MinBytes || stat.cbSize > MaxBytes) return Refused("SIZE");
                byte[] bytes = new byte[stat.cbSize];
                stream.Seek(0, 0, IntPtr.Zero);
                IntPtr read = Marshal.AllocHGlobal(4);
                try { stream.Read(bytes, bytes.Length, read); if (Marshal.ReadInt32(read) != bytes.Length) return Refused("COM"); }
                finally { Marshal.FreeHGlobal(read); }
                return new ShellLinkResult(true, null, bytes, null);
            }
            finally
            {
                if (stream != null) Marshal.ReleaseComObject(stream);
                Marshal.FinalReleaseComObject(link);
            }
        }

        private static ShellLinkResult Load(byte[] bytes)
        {
            object link = new ShellLinkObject();
            IStream stream = null;
            try
            {
                if (CreateStreamOnHGlobal(IntPtr.Zero, true, out stream) != 0) return Refused("COM");
                stream.Write(bytes, bytes.Length, IntPtr.Zero);
                stream.Seek(0, 0, IntPtr.Zero);
                try { ((IPersistStream)link).Load(stream); } catch (Exception) { return Refused("MALFORMED"); }
                IShellLinkW shell = (IShellLinkW)link;
                StringBuilder target = new StringBuilder(FieldChars), directory = new StringBuilder(FieldChars), arguments = new StringBuilder(FieldChars),
                    description = new StringBuilder(FieldChars), icon = new StringBuilder(FieldChars);
                int iconIndex, show; ushort hotKey;
                shell.GetPath(target, FieldChars, IntPtr.Zero, RawPath);
                shell.GetWorkingDirectory(directory, FieldChars); shell.GetArguments(arguments, FieldChars); shell.GetDescription(description, FieldChars);
                shell.GetIconLocation(icon, FieldChars, out iconIndex); shell.GetShowCmd(out show); shell.GetHotkey(out hotKey);
                return new ShellLinkResult(true, null, bytes, new ShellLinkFields(target.ToString(), directory.ToString(), arguments.ToString(), description.ToString(), icon.ToString(), iconIndex, show, hotKey));
            }
            finally
            {
                if (stream != null) Marshal.ReleaseComObject(stream);
                Marshal.FinalReleaseComObject(link);
            }
        }

        /// <summary>Runs shell COM on a single-threaded apartment (a dedicated, bounded thread when the caller is not STA).</summary>
        private static ShellLinkResult Sta(Func<ShellLinkResult> body)
        {
            if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) return body();
            ShellLinkResult result = null; Exception failure = null;
            Thread thread = new Thread(delegate() { try { result = body(); } catch (Exception error) { failure = error; } });
            thread.SetApartmentState(ApartmentState.STA); thread.IsBackground = true; thread.Start();
            if (!thread.Join(30000)) return Refused("COM");
            if (failure != null) return Refused("COM");
            return result;
        }
    }
}
