// Current-user uninstall registration plan (C# 5, pure: no registry, filesystem, process or environment access).
// Produces the fixed value set for HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arcane from an engine record,
// a bound setup-ownership journal and verified OwnedFiles placement results. The plan grants no ownership: the
// caller must re-fence the record and re-verify the descriptors immediately before applying it, and must never derive
// ownership from an existing key. Every value is a literal REG_SZ or DWORD; nothing is expanded or executed.
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Text.RegularExpressions;

namespace Arcane.Installer
{
    internal enum RegistrationKind { String, DWord }

    internal sealed class RegistrationValue
    {
        public readonly string Name, Text;
        public readonly RegistrationKind Kind;
        public readonly int Number;
        internal RegistrationValue(string name, string text) { Name = name; Kind = RegistrationKind.String; Text = text; }
        internal RegistrationValue(string name, int number) { Name = name; Kind = RegistrationKind.DWord; Number = number; }
    }

    internal sealed class RegistrationPlan
    {
        public const string Hive = "HKEY_CURRENT_USER", KeyPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Arcane";
        /// <summary>Always true: a plan is a proposal; apply only after re-fencing the record and re-verifying both descriptors.</summary>
        public const bool CallerMustReverifyBeforeApply = true;
        public readonly string InstallationId, Root, RecordSha256;
        public readonly OwnedFileDescriptor Uninstaller, Launcher;
        public readonly IList<RegistrationValue> Values;
        internal RegistrationPlan(string installationId, string root, string recordSha256, OwnedFileDescriptor uninstaller, OwnedFileDescriptor launcher, IList<RegistrationValue> values)
        {
            InstallationId = installationId; Root = root; RecordSha256 = recordSha256; Uninstaller = uninstaller; Launcher = launcher; Values = values;
        }
    }

    internal sealed class RegistrationPlanResult
    {
        public readonly bool Ok;
        /// <summary>null, RECORD, JOURNAL, PLACEMENT, ROOT or VERSION.</summary>
        public readonly string Code;
        public readonly RegistrationPlan Plan;
        internal RegistrationPlanResult(bool ok, string code, RegistrationPlan plan) { Ok = ok; Code = code; Plan = plan; }
    }

    internal static class RegistrationPlanner
    {
        internal const string DisplayName = "Arcane", Publisher = "Arcane", MarkerName = "ArcaneInstallationId";
        private static readonly Regex Version = new Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?\\z");
        private static readonly Regex Uuid = new Regex("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\z");

        private static RegistrationPlanResult Refused(string code) { return new RegistrationPlanResult(false, code, null); }

        /// <summary>Builds the fixed registration plan. Never throws and never touches the registry or filesystem.</summary>
        public static RegistrationPlanResult Create(InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership, OwnedFileResult uninstallerPlacement, OwnedFileResult launcherPlacement)
        {
            try { return CreateCore(record, ownership, uninstallerPlacement, launcherPlacement); }
            catch (Exception) { return Refused("RECORD"); }
        }

        private static RegistrationPlanResult CreateCore(InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership, OwnedFileResult uninstallerPlacement, OwnedFileResult launcherPlacement)
        {
            if (record == null || record.Active == null || record.InstallationId == null || !Uuid.IsMatch(record.InstallationId) || record.RecordSha256 == null) return Refused("RECORD");
            string version = record.Active.Version;
            if (version == null || version.Length > 64 || !Version.IsMatch(version)) return Refused("VERSION");
            string root = record.Root;
            if (!SafeRoot(root)) return Refused("ROOT");
            // The journal must be present and bound to exactly this installation, root and observed record.
            if (ownership == null || !ownership.Present || ownership.Record == null || ownership.InstallationId != record.InstallationId ||
                !string.Equals(ownership.Root, root, StringComparison.Ordinal) || !ownership.RootIdentity.SameAs(record.RootIdentity) ||
                ownership.Record.RecordSha256 != record.RecordSha256 || ownership.Uninstaller == null) return Refused("JOURNAL");
            OwnedFileDescriptor uninstaller = Verified(uninstallerPlacement, SetupOwnership.UninstallerName, record, ownership.Uninstaller);
            if (uninstaller == null) return Refused("PLACEMENT");
            OwnedFileDescriptor launcher = null;
            if (launcherPlacement != null)
            {
                if (ownership.Launcher == null) return Refused("JOURNAL");
                launcher = Verified(launcherPlacement, SetupOwnership.LauncherName, record, ownership.Launcher);
                if (launcher == null) return Refused("PLACEMENT");
            }
            string uninstallerPath = root + "\\" + SetupOwnership.UninstallerName, iconTarget = root + "\\" + (launcher != null ? SetupOwnership.LauncherName : SetupOwnership.UninstallerName);
            List<RegistrationValue> values = new List<RegistrationValue>
            {
                new RegistrationValue("DisplayName", DisplayName),
                new RegistrationValue("DisplayVersion", version),
                new RegistrationValue("Publisher", Publisher),
                new RegistrationValue("InstallLocation", root),
                new RegistrationValue("DisplayIcon", "\"" + iconTarget + "\",0"),
                // A direct quoted path only: no arguments, no quiet or confirmation-bypass form.
                new RegistrationValue("UninstallString", "\"" + uninstallerPath + "\""),
                new RegistrationValue("NoModify", 1),
                new RegistrationValue("NoRepair", 1),
                new RegistrationValue(MarkerName, record.InstallationId),
            };
            return new RegistrationPlanResult(true, null, new RegistrationPlan(record.InstallationId, root, record.RecordSha256, uninstaller, launcher, new ReadOnlyCollection<RegistrationValue>(values)));
        }

        /// <summary>A fresh verified OwnedFiles result for the fixed role that equals the journal's descriptor field for field.</summary>
        private static OwnedFileDescriptor Verified(OwnedFileResult placement, string name, InstalledRecordSnapshot record, OwnedFileDescriptor journal)
        {
            if (placement == null || placement.Descriptor == null || journal == null) return null;
            if (placement.State != OwnedFileState.Placed && placement.State != OwnedFileState.Replaced && placement.State != OwnedFileState.Unchanged) return null;
            if (placement.Code != null && placement.Code != "BACKUP_RETAINED") return null;
            OwnedFileDescriptor d = placement.Descriptor;
            bool bound = string.Equals(d.Name, name, StringComparison.Ordinal) && string.Equals(d.Root, record.Root, StringComparison.Ordinal) && d.RootIdentity.SameAs(record.RootIdentity);
            bool same = string.Equals(journal.Name, name, StringComparison.Ordinal) && journal.Bytes == d.Bytes && journal.Sha256 == d.Sha256 && journal.Identity.SameAs(d.Identity);
            return bound && same ? d : null;
        }

        /// <summary>Drive-absolute literal path safe to embed in quoted REG_SZ values (no quotes, controls, % or trailing separator).</summary>
        private static bool SafeRoot(string root)
        {
            if (root == null || root.Length < 4 || !char.IsLetter(root[0]) || root[1] != ':' || root[2] != '\\' || root.EndsWith("\\", StringComparison.Ordinal) ||
                root.Length + 1 + SetupOwnership.UninstallerName.Length > 259 || root.Substring(2).IndexOf(':') >= 0) return false;
            foreach (char c in root) if (c < 0x20 || c == 0x7f || c == '"' || c == '%' || c == '/' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') return false;
            return true;
        }
    }
}
