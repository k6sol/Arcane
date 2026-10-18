# Desktop updates

The installed Arcane shortcut follows the active local release. Each build lives in its own directory under `%LOCALAPPDATA%\Arcane\Desktop\releases`; publishing a build uses the existing Windows installation engine and its atomic `installation.json` record. An open app continues running its current build.

Arcane checks for a newer installed release every 15 seconds and when the window regains focus. A verified update shows **An update is ready** with **Restart to update**. Checking status never starts an update. Restart independently verifies the complete target package and checks that the active installation has not changed.

The button waits for the newest ChatGPT draft to receive its native save acknowledgement. Unsent Claude drafts and attachments remain in the current window until sent or cleared; active chat turns must finish or stop. A failed save leaves the window open. Accepted restart requests stop the owned services through their normal shutdown path and relaunch the updated executable with the existing application profile.

## Publish a tested local build

After packaging and executable verification:

```powershell
node scripts/check-windows-executable.mjs C:\path\to\verified-bundle
npm run install:desktop -- --bundle C:\path\to\verified-bundle
```

The deployment verifies the bundle again, retains previous releases, builds the existing native launcher on first installation and creates `Arcane.lnk` on the current user's desktop. It never closes an open app or launches one automatically. Later deployments reuse the same shortcut and launcher. The launcher checks the active installation record, its pinned manifest and the executable it starts; it clears parent-terminal Node startup flags so Arcane opens as a desktop app.

This is local build delivery. The banner observes builds installed on this computer; it does not download builds from a remote service. Future local releases should be published only after their checks and executable verification pass.
