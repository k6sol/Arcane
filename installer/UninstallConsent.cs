// Explicit uninstall consent (C# 5, .NET Framework 4.x WinForms). A confirmation dialog shows the exact installation root,
// active version and that projects and profiles are kept. The ONLY code that can construct an UninstallAuthorization is that
// dialog's Uninstall click handler (the dialog is a private class nested in the authorization type). Cancel is the default
// action, and cancelling or closing grants no authorization. Consent is bound to exactly what was displayed and consumed once by a later
// transaction through a live operation lease. This component never deletes, writes, launches, or acquires/releases a lease.
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace Arcane.Installer
{
    internal enum ConsentState { Authorized, Cancelled, Changed, Refused }

    internal sealed class ConsentResult
    {
        public readonly ConsentState State;
        /// <summary>null, RECORD, JOURNAL or CHANGED.</summary>
        public readonly string Code;
        public readonly UninstallAuthorization Authorization;
        internal ConsentResult(ConsentState state, string code, UninstallAuthorization authorization) { State = state; Code = code; Authorization = authorization; }
    }

    internal sealed class ConsentConsume
    {
        public readonly bool Ok;
        /// <summary>null, CONSUMED, LEASE, RECORD_CHANGED or JOURNAL_CHANGED.</summary>
        public readonly string Code;
        /// <summary>Fresh leased snapshots for the caller's transaction; still subject to the caller's own later fences.</summary>
        public readonly InstalledRecordSnapshot Record;
        public readonly SetupOwnershipSnapshot Journal;
        internal ConsentConsume(bool ok, string code, InstalledRecordSnapshot record, SetupOwnershipSnapshot journal) { Ok = ok; Code = code; Record = record; Journal = journal; }
    }

    internal static class UninstallConsent
    {
        /// <summary>Trusted observation seam for the owned test harness only ("load", "shown"); null in production. It cannot
        /// construct an authorization, change bindings or skip the click-time re-check.</summary>
        internal static Action<Form, string> Observe;

        /// <summary>Asks the person to confirm uninstalling the displayed installation. Holds no lease while they decide.</summary>
        public static ConsentResult Ask(IWin32Window owner, InstalledRecordSnapshot displayed)
        {
            try
            {
                if (displayed == null || displayed.Active == null || !InstalledRecord.StillCurrent(displayed)) return new ConsentResult(ConsentState.Refused, "RECORD", null);
                OwnershipRead journal = SetupOwnership.Read(displayed);
                if (journal.State == OwnershipReadState.Kept || journal.Snapshot == null) return new ConsentResult(ConsentState.Refused, "JOURNAL", null);
                return UninstallAuthorization.Prompt(owner, displayed, journal.Snapshot);
            }
            catch (Exception) { return new ConsentResult(ConsentState.Refused, "RECORD", null); }
        }
    }

    internal sealed class UninstallAuthorization
    {
        public readonly string Root, InstallationId, ActiveReleaseId, ActiveVersion, RecordSha256;
        public readonly bool JournalPresent;
        internal readonly FileIdentity RootIdentity, RecordIdentity;
        private readonly long journalBytes;
        private readonly string journalSha256;
        private readonly FileIdentity journalIdentity;
        private int consumed;

        private UninstallAuthorization(InstalledRecordSnapshot record, SetupOwnershipSnapshot journal)
        {
            Root = record.Root; RootIdentity = record.RootIdentity; InstallationId = record.InstallationId; ActiveReleaseId = record.ActiveReleaseId;
            ActiveVersion = record.Active.Version; RecordSha256 = record.RecordSha256; RecordIdentity = record.RecordIdentity;
            JournalPresent = journal.Present;
            if (journal.Present) { journalBytes = journal.Journal.Bytes; journalSha256 = journal.Journal.Sha256; journalIdentity = journal.Journal.Identity; }
        }

        internal static ConsentResult Prompt(IWin32Window owner, InstalledRecordSnapshot displayed, SetupOwnershipSnapshot journal)
        {
            using (ConsentDialog dialog = new ConsentDialog(displayed, journal))
            {
                if (owner == null) dialog.ShowDialog(); else dialog.ShowDialog(owner);
                return dialog.Outcome ?? new ConsentResult(ConsentState.Cancelled, null, null);
            }
        }

        /// <summary>The journal state that was displayed must still be the journal state now (presence, bytes, hash, identity).</summary>
        private static bool SameJournal(SetupOwnershipSnapshot displayed, SetupOwnershipSnapshot current)
        {
            if (displayed == null || current == null || displayed.Present != current.Present) return false;
            if (!displayed.Present) return true;
            return displayed.Journal.Bytes == current.Journal.Bytes && displayed.Journal.Sha256 == current.Journal.Sha256 && displayed.Journal.Identity.SameAs(current.Journal.Identity);
        }

        private bool BoundJournal(SetupOwnershipSnapshot current)
        {
            if (current == null || current.Present != JournalPresent) return false;
            return !JournalPresent || current.Journal.Bytes == journalBytes && current.Journal.Sha256 == journalSha256 && current.Journal.Identity.SameAs(journalIdentity);
        }

        /// <summary>Consumes this authorization once (even on mismatch) under a live lease bound to exactly what was approved, and
        /// returns fresh leased record and journal snapshots. Never throws; never deletes, writes or releases anything.</summary>
        public ConsentConsume TryConsume(OperationLease lease)
        {
            if (Interlocked.Exchange(ref consumed, 1) != 0) return new ConsentConsume(false, "CONSUMED", null, null);
            try
            {
                if (lease == null || !lease.Live || lease.InstallationId != InstallationId || !string.Equals(lease.Root, Root, StringComparison.Ordinal) ||
                    !lease.RootIdentity.SameAs(RootIdentity)) return new ConsentConsume(false, "LEASE", null, null);
                if (lease.RecordSha256 != RecordSha256 || !lease.RecordIdentity.SameAs(RecordIdentity)) return new ConsentConsume(false, "RECORD_CHANGED", null, null);
                InstalledRecordSnapshot record;
                try { record = InstalledRecord.Read(Root, lease); } catch (InstalledRecordException) { return new ConsentConsume(false, "RECORD_CHANGED", null, null); }
                if (!record.RootIdentity.SameAs(RootIdentity) || !record.RecordIdentity.SameAs(RecordIdentity) || record.RecordSha256 != RecordSha256 ||
                    record.InstallationId != InstallationId || record.ActiveReleaseId != ActiveReleaseId) return new ConsentConsume(false, "RECORD_CHANGED", null, null);
                OwnershipRead journal = SetupOwnership.Read(record, lease);
                if (journal.State == OwnershipReadState.Kept || !BoundJournal(journal.Snapshot)) return new ConsentConsume(false, "JOURNAL_CHANGED", null, null);
                return new ConsentConsume(true, null, record, journal.Snapshot);
            }
            catch (Exception) { return new ConsentConsume(false, "RECORD_CHANGED", null, null); }
        }

        private sealed class ConsentDialog : Form
        {
            private readonly InstalledRecordSnapshot displayed;
            private readonly SetupOwnershipSnapshot journal;
            private readonly Button cancel, uninstall;
            private bool decided;
            internal ConsentResult Outcome;

            public ConsentDialog(InstalledRecordSnapshot record, SetupOwnershipSnapshot ownership)
            {
                displayed = record; journal = ownership;
                Text = "Uninstall Arcane"; ClientSize = new Size(600, 360); FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent; Font = new Font("Segoe UI", 10);
                AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
                BackColor = Color.FromArgb(17, 17, 21); ForeColor = Color.FromArgb(239, 239, 243);
                try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
                Label heading = new Label { Name = "heading", Text = "Uninstall Arcane?", Location = new Point(24, 16), Size = new Size(552, 44), Font = new Font("Segoe UI", 17, FontStyle.Bold) };
                // Separate selectable fields keep the full version and literal path available, including '&' characters.
                TextBox version = new TextBox { Name = "version", Text = "Version " + record.Active.Version, Location = new Point(24, 62), Size = new Size(552, 64),
                    Multiline = true, ReadOnly = true, WordWrap = true, BorderStyle = BorderStyle.None, ScrollBars = ScrollBars.None, BackColor = BackColor, ForeColor = ForeColor, TabIndex = 2 };
                TextBox location = new TextBox { Name = "location", Text = "Installed in:\r\n" + record.Root, Location = new Point(24, 138), Size = new Size(552, 72),
                    Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, ScrollBars = ScrollBars.Vertical, BackColor = BackColor, ForeColor = ForeColor, TabIndex = 3 };
                Label kept = new Label { Name = "kept", Text = "Your projects and app profiles are kept. Files you added or changed in the installation folder are kept.", Location = new Point(24, 224), Size = new Size(552, 52), ForeColor = Color.FromArgb(169, 169, 182) };
                cancel = new Button { Name = "cancel", Text = "Cancel", Location = new Point(456, 304), Size = new Size(120, 36), TabIndex = 0,
                    FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(32, 32, 39), ForeColor = ForeColor };
                cancel.FlatAppearance.BorderColor = Color.FromArgb(67, 67, 79);
                uninstall = new Button { Name = "uninstall", Text = "Uninstall", Location = new Point(320, 304), Size = new Size(120, 36), TabIndex = 1,
                    FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(255, 63, 91), ForeColor = Color.White };
                uninstall.FlatAppearance.BorderSize = 0;
                Controls.Add(heading); Controls.Add(version); Controls.Add(location); Controls.Add(kept); Controls.Add(cancel); Controls.Add(uninstall);
                // Cancel is the default and escape action; confirmation requires activating Uninstall.
                AcceptButton = cancel; CancelButton = cancel; ActiveControl = cancel;
                cancel.Click += delegate { Decide(new ConsentResult(ConsentState.Cancelled, null, null)); };
                uninstall.Click += Confirm;
                FormClosing += delegate { if (Outcome == null) { decided = true; Outcome = new ConsentResult(ConsentState.Cancelled, null, null); } };
                Load += delegate { Action<Form, string> observe = UninstallConsent.Observe; if (observe != null) observe(this, "load"); };
                Shown += delegate { Action<Form, string> observe = UninstallConsent.Observe; if (observe != null) observe(this, "shown"); };
            }

            private void Decide(ConsentResult outcome)
            {
                if (decided) return;
                decided = true; cancel.Enabled = false; uninstall.Enabled = false; Outcome = outcome; Close();
            }

            /// <summary>The only place an authorization is constructed: after an explicit Uninstall click and a fresh re-check.</summary>
            private void Confirm(object sender, EventArgs args)
            {
                if (decided) return;
                // First acceptance disables the handler path, so a queued repeated click cannot issue a second authorization.
                decided = true; uninstall.Enabled = false; cancel.Enabled = false;
                ConsentResult outcome;
                try
                {
                    OwnershipRead current = InstalledRecord.StillCurrent(displayed) ? SetupOwnership.Read(displayed) : null;
                    if (current == null) outcome = new ConsentResult(ConsentState.Changed, "RECORD", null);
                    else if (current.State == OwnershipReadState.Kept || !SameJournal(journal, current.Snapshot)) outcome = new ConsentResult(ConsentState.Changed, "JOURNAL", null);
                    else outcome = new ConsentResult(ConsentState.Authorized, null, new UninstallAuthorization(displayed, journal));
                }
                catch (Exception) { outcome = new ConsentResult(ConsentState.Changed, "CHANGED", null); }
                Outcome = outcome; Close();
            }
        }
    }
}
