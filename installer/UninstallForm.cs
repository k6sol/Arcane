using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Arcane.Installer
{
    /// <summary>Progress after a separate human decision. Closing requests cancellation and waits for the actual transaction.
    /// This window cannot create consent, retry an operation or start another executable.</summary>
    internal sealed class UninstallForm : Form
    {
        /// <summary>Trusted native fixture observation only; null in production.</summary>
        internal static Action<UninstallForm> Observe;
        private readonly InstalledRecordSnapshot displayed;
        private readonly UninstallAuthorization authorization;
        private readonly Label status, detail;
        private readonly ProgressBar progress;
        private readonly Button close;
        private CancellationTokenSource operation;
        private bool started, busy;
        public UninstallResult Result { get; private set; }
        public bool Failed { get; private set; }

        public UninstallForm(InstalledRecordSnapshot record, UninstallAuthorization consent)
        {
            displayed = record; authorization = consent;
            Text = "Uninstall Arcane"; ClientSize = new Size(600, 340);
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(17, 17, 21);
            ForeColor = Color.FromArgb(239, 239, 243); Font = new Font("Segoe UI", 10);
            AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
            Controls.Add(new Panel { Dock = DockStyle.Top, Height = 4, BackColor = Color.FromArgb(255, 63, 91) });
            Controls.Add(new Label { Text = "ARCANE", Location = new Point(36, 28), Size = new Size(520, 30), Font = new Font("Segoe UI", 13, FontStyle.Bold) });
            status = new Label { Name = "status", Text = "Preparing to uninstall", Location = new Point(34, 85), Size = new Size(530, 68), Font = new Font("Segoe UI", 22, FontStyle.Bold) }; Controls.Add(status);
            detail = new Label { Name = "detail", Text = "Projects and app profiles stay on this computer.", Location = new Point(37, 163), Size = new Size(525, 75), ForeColor = Color.FromArgb(169, 169, 182) }; Controls.Add(detail);
            progress = new ProgressBar { Location = new Point(37, 248), Size = new Size(525, 6), Style = ProgressBarStyle.Marquee }; Controls.Add(progress);
            close = new Button { Name = "close", Text = "Cancel", Location = new Point(430, 276), Size = new Size(132, 36), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(32, 32, 39), ForeColor = ForeColor };
            close.FlatAppearance.BorderColor = Color.FromArgb(67, 67, 79); Controls.Add(close);
            close.Click += delegate { if (busy) RequestCancel(); else Close(); };
            AcceptButton = close; CancelButton = close;
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) { args.Cancel = true; RequestCancel(); } };
            Shown += BeginRemoval;
            Load += delegate { Action<UninstallForm> observe = Observe; if (observe != null) observe(this); };
        }

        private void RequestCancel()
        {
            if (operation == null || operation.IsCancellationRequested) return;
            operation.Cancel(); close.Enabled = false;
            status.Text = "Finishing the current step";
            detail.Text = "The result will appear when the current operation has finished.";
        }

        private void Report(UninstallProgress value)
        {
            CancellationTokenSource reporting = operation;
            if (reporting == null || IsDisposed || Disposing || !IsHandleCreated) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    if (!busy || IsDisposed || !object.ReferenceEquals(operation, reporting) || reporting.IsCancellationRequested) return;
                    if (value.Phase == UninstallPhase.Activity) status.Text = "Checking running apps";
                    else if (value.Phase == UninstallPhase.Releases) status.Text = "Removing Arcane";
                    else status.Text = "Finishing uninstall";
                }));
            }
            catch (InvalidOperationException) { }
        }

        private async void BeginRemoval(object sender, EventArgs args)
        {
            if (started) return;
            started = true; busy = true; operation = new CancellationTokenSource();
            CancellationTokenSource running = operation;
            try { Result = await Task.Run(delegate { return UninstallTransaction.Run(displayed, authorization, running.Token, Report); }); }
            catch (Exception) { Failed = true; }
            finally { busy = false; operation = null; running.Dispose(); }
            progress.Visible = false; close.Text = "Close"; close.Enabled = true;
            if (Failed || Result == null)
            {
                status.Text = "Review installation files";
                detail.Text = "The uninstall result could not be confirmed. Keep the remaining files for review.";
            }
            else if (Result.State == UninstallState.Removed)
            {
                status.Text = "Arcane is uninstalled";
                detail.Text = Result.RootDirectory == ContainerOutcome.Kept ? "Projects, profiles and additional files have been kept." : "Your projects and app profiles have been kept.";
            }
            else if (Result.State == UninstallState.Cancelled)
            {
                status.Text = "Uninstall cancelled";
                detail.Text = "Installation files were kept. You can start uninstall again when you are ready.";
            }
            else if (Result.Code == "BUSY")
            {
                status.Text = "Close Arcane to continue";
                detail.Text = "A running app is using installation files. Close it, then start uninstall again.";
            }
            else
            {
                status.Text = Result.State == UninstallState.Partial ? "Some installation files remain" : "Installation files kept";
                detail.Text = "Remaining files were kept for review. Projects and app profiles stay on this computer.";
            }
            if (Result != null && Result.RetainedLock != null)
                detail.Text = "An installation operation needs review. Keep the remaining installation files and operation record.";
        }
    }
}
