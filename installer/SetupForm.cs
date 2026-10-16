using System;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Arcane.Installer
{
    internal sealed class SetupForm : Form
    {
        private readonly Label status;
        private readonly Label detail;
        private readonly ProgressBar progress;
        private readonly Button primary;
        private readonly Button cancel;
        private CancellationTokenSource operation;
        private bool busy;
        private bool finished;
        private bool installationBegan;
        private bool preparingPrograms;
        private bool stageRetained;
        private LauncherSetupOutcome launcherSetup;

        public SetupForm()
        {
            Text = "Arcane Setup"; ClientSize = new Size(600, 380);
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(17, 17, 21);
            ForeColor = Color.FromArgb(239, 239, 243); Font = new Font("Segoe UI", 10);
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
            Panel accent = new Panel { Dock = DockStyle.Top, Height = 4, BackColor = Color.FromArgb(255, 63, 91) }; Controls.Add(accent);
            Label brand = new Label { Text = "ARCANE", Location = new Point(36, 30), Size = new Size(280, 30), Font = new Font("Segoe UI", 13, FontStyle.Bold) }; Controls.Add(brand);
            Label title = new Label { Text = "Install Arcane", Location = new Point(34, 84), Size = new Size(530, 48), Font = new Font("Segoe UI", 26, FontStyle.Bold) }; Controls.Add(title);
            Label intro = new Label { Text = "Your local development workspace, ready when you are.", Location = new Point(37, 141), Size = new Size(525, 28), ForeColor = Color.FromArgb(169, 169, 182) }; Controls.Add(intro);
            status = new Label { Text = "Install for your Windows account.", Location = new Point(37, 196), Size = new Size(525, 30) }; Controls.Add(status);
            detail = new Label { Text = "Projects and app profiles stay separate from installation files.", Location = new Point(37, 232), Size = new Size(525, 60), ForeColor = Color.FromArgb(169, 169, 182), Font = new Font("Segoe UI", 9) }; Controls.Add(detail);
            progress = new ProgressBar { Location = new Point(37, 300), Size = new Size(525, 6), Style = ProgressBarStyle.Continuous, Minimum = 0, Maximum = 1000, Visible = false }; Controls.Add(progress);
            primary = new Button { Text = "Install", Location = new Point(430, 316), Size = new Size(132, 36), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(255, 63, 91), ForeColor = Color.White, TabIndex = 0 };
            primary.FlatAppearance.BorderSize = 0; primary.Click += BeginInstall; Controls.Add(primary);
            cancel = new Button { Text = "Cancel", Location = new Point(284, 316), Size = new Size(132, 36), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(32, 32, 39), ForeColor = ForeColor, TabIndex = 1 };
            cancel.FlatAppearance.BorderColor = Color.FromArgb(67, 67, 79); cancel.Click += delegate { if (busy) RequestCancel(); else Close(); }; Controls.Add(cancel);
            AcceptButton = primary; CancelButton = cancel;
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) { args.Cancel = true; RequestCancel(); } };
        }
        private void RequestCancel()
        {
            if (operation == null || operation.IsCancellationRequested) return;
            operation.Cancel(); cancel.Enabled = false;
            status.Text = "Finishing the current step safely...";
            detail.Text = "Setup will confirm the result before closing.";
        }
        private void Post(Action action)
        {
            if (IsDisposed || Disposing || !IsHandleCreated) return;
            try { BeginInvoke(new Action(delegate { if (!IsDisposed && busy) action(); })); }
            catch (InvalidOperationException) { }
        }
        private void Report(InstallProgress value)
        {
            Post(delegate
            {
                if (operation.IsCancellationRequested) return;
                switch (value.Phase)
                {
                    case "verifying-source": status.Text = "Checking installation files..."; break;
                    case "copying": status.Text = "Installing Arcane..."; break;
                    case "verifying-copy": status.Text = "Verifying your installation..."; break;
                    case "publishing": status.Text = "Selecting the installed release..."; break;
                    default: status.Text = "Confirming the installation..."; break;
                }
                if (value.TotalBytes > 0) { progress.Style = ProgressBarStyle.Continuous; progress.Value = (int)Math.Min(1000, value.BytesCopied * 1000.0 / value.TotalBytes); }
            });
        }
        private async void BeginInstall(object sender, EventArgs args)
        {
            if (finished)
            {
                if (launcherSetup != null && launcherSetup.Ready)
                {
                    busy = true; primary.Enabled = false; cancel.Enabled = false;
                    status.Text = "Opening Arcane...";
                    detail.Text = "Checking the selected release before opening your workspace.";
                    LaunchOutcome launched;
                    try { launched = await Task.Run(delegate { return PostInstall.Open(launcherSetup); }); }
                    finally { busy = false; }
                    if (launched.Started) { Close(); return; }
                    status.Text = "Arcane could not be opened.";
                    detail.Text = "The installation has changed or is busy. Open Arcane after setup has finished.";
                    launcherSetup = null; primary.Text = "Close"; primary.Enabled = true;
                }
                else Close();
                return;
            }
            if (busy) return;
            busy = true; installationBegan = false; preparingPrograms = false; stageRetained = false; primary.Enabled = false;
            operation = new CancellationTokenSource(); progress.Visible = true; progress.Style = ProgressBarStyle.Marquee;
            status.Text = "Checking setup files..."; detail.Text = "Previous releases and your projects will be retained.";
            try
            {
                InstallOutcome outcome = await Task.Run(async delegate
                {
                    CancellationToken token = operation.Token; token.ThrowIfCancellationRequested();
                    string parent = StageDirectory.CanonicalTempParent(SetupPins.MaximumRelativePathChars);
                    string stage = StageDirectory.Reserve(parent, SetupPins.MaximumRelativePathChars);
                    PayloadReceipt extracted = null; bool kitValidated = false, cleanupAllowed = false;
                    try
                    {
                        extracted = PayloadArchive.VerifyAndExtract(Application.ExecutablePath, stage, SetupPins.PayloadSha256);
                        token.ThrowIfCancellationRequested();
                        KitReceipt kit = KitVerifier.Verify(stage, SetupPins.KitManifestSha256); kitValidated = true;
                        token.ThrowIfCancellationRequested(); preparingPrograms = true;
                        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                        if (string.IsNullOrEmpty(local) || local.Length < 3 || local[1] != ':') throw new IOException("Program directory unavailable.");
                        DirectDirectories(local);
                        string programs = Path.Combine(local, "Programs"); Directory.CreateDirectory(programs); DirectDirectories(programs);
                        token.ThrowIfCancellationRequested();
                        string target = Path.Combine(programs, "Arcane"); installationBegan = true;
                        InstallOutcome selected = await InstallProcess.Run(kit, target, Report, token);
                        cleanupAllowed = selected.State != InstallState.Unconfirmed && selected.Published.HasValue;
                        if (selected.State == InstallState.Installed || selected.State == InstallState.AlreadyActive)
                        {
                            // Completion failure must never replace the confirmed engine outcome.
                            try
                            {
                                byte[] launcher = PostInstall.LauncherResource(typeof(SetupForm).Assembly, SetupPins.LauncherBytes, SetupPins.LauncherSha256);
                                launcherSetup = PostInstall.CompleteLauncher(target, selected, launcher, SetupPins.LauncherBytes, SetupPins.LauncherSha256);
                            }
                            catch (Exception) { launcherSetup = null; }
                        }
                        return selected;
                    }
                    catch (PayloadException error) { stageRetained = error.RetainedStage != null; throw; }
                    finally
                    {
                        if (extracted != null)
                        {
                            stageRetained = true;
                            if (kitValidated && (!installationBegan || cleanupAllowed))
                            {
                                try { stageRetained = !StageDirectory.Cleanup(extracted).Complete; }
                                catch (Exception) { stageRetained = true; }
                            }
                        }
                    }
                });
                progress.Style = ProgressBarStyle.Continuous;
                if (outcome.State == InstallState.Installed || outcome.State == InstallState.AlreadyActive)
                {
                    status.Text = "Arcane is installed."; detail.Text = "Your projects and app profiles have been kept separate."; progress.Value = 1000;
                    if (launcherSetup == null || !launcherSetup.Ready)
                        detail.Text += launcherSetup != null && launcherSetup.Placement != null && launcherSetup.Placement.Descriptor != null
                            ? "\nA launcher file remains, but setup could not confirm its record. Keep this setup file for review."
                            : "\nSetup could not finish the launcher. Keep this setup file for review.";
                    else if (launcherSetup.Code == "BACKUP_RETAINED") detail.Text += "\nPrevious launcher files have been retained for review.";
                }
                else if (outcome.Published == false)
                {
                    status.Text = outcome.State == InstallState.Cancelled ? "Installation cancelled." : "Setup could not finish.";
                    detail.Text = "The active release was not changed.";
                }
                else if (outcome.Published == true)
                {
                    status.Text = "The release was installed. Setup needs attention.";
                    detail.Text = "The installed release was selected. Keep the setup files for review.";
                }
                else Unknown();
            }
            catch (OperationCanceledException)
            {
                if (installationBegan) Unknown(); else { status.Text = "Installation cancelled."; detail.Text = "The active release was not changed."; }
            }
            catch (Exception)
            {
                if (installationBegan) Unknown();
                else if (preparingPrograms) { status.Text = "Setup could not prepare your programs folder."; detail.Text = "The active release was not changed."; }
                else { status.Text = "Setup could not verify the installation files."; detail.Text = "The active release was not changed. Keep this setup file for review."; }
            }
            finally
            {
                busy = false; finished = true; progress.Style = ProgressBarStyle.Continuous;
                if (stageRetained) detail.Text += "\nSetup files have been retained for review.";
                bool canOpen = launcherSetup != null && launcherSetup.Ready;
                primary.Text = canOpen ? "Open Arcane" : "Close"; primary.Enabled = true;
                cancel.Text = "Close"; cancel.Enabled = canOpen; operation.Dispose(); operation = null;
            }
        }
        private void Unknown()
        {
            status.Text = "Setup could not confirm the installation.";
            detail.Text = "Check the installation before trying again.";
        }
        private static void DirectDirectories(string path)
        {
            for (string current = Path.GetFullPath(path); !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            {
                FileAttributes attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Program directory unavailable.");
            }
        }
    }
    internal static class SetupEntry
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }
}
