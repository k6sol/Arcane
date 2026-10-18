# Desktop updates

The installed Arcane shortcut follows the active local release. Each build lives in its own directory under `%LOCALAPPDATA%\Arcane\Desktop\releases`; publishing a build uses the existing Windows installation engine and its atomic `installation.json` record. An open app continues running its current build.

Arcane checks for a newer installed release every 15 seconds and when the window regains focus. A verified update shows **An update is ready** with **Restart to update**. Checking status never starts an update. Restart independently verifies the complete target package and checks that the active installation has not changed.

Update verification uses the installed release's pinned inventory, allowing later builds to add desktop modules. Every listed file is checked through its open handle against its recorded size and hash; missing, linked and unlisted payloads are refused. Checking an update never imports or runs code from that release. The deployment engine remains responsible for validating a new package before publishing its record.

The button waits for the newest ChatGPT draft to receive its native save acknowledgement. Unsent Claude drafts and attachments remain in the current window until sent or cleared; active chat turns must finish or stop. A failed save leaves the window open. Accepted restart requests stop the owned services through their normal shutdown path and relaunch the updated executable with the existing application profile.

## Publish a tested local build

After packaging and executable verification:

```powershell
node scripts/check-windows-executable.mjs C:\path\to\verified-bundle
npm run install:desktop -- --bundle C:\path\to\verified-bundle
```

The deployment verifies the bundle again, retains previous releases, builds the existing native launcher on first installation and creates `Arcane.lnk` on the current user's desktop. It never closes an open app or launches one automatically. Later deployments reuse the same shortcut and launcher. The launcher checks the active installation record, its pinned manifest and the executable it starts; it clears parent-terminal Node startup flags so Arcane opens as a desktop app.

This is local build delivery. The banner observes builds installed on this computer; it does not download builds from a remote service. Future local releases should be published only after their checks and executable verification pass.

## Saved connections and chat settings

An available-update banner only reads installation status. It neither signs out a provider nor rotates the plugin key. An interrupted state read preserves the open chat surface while native actions continue to require fresh state. Saved Codex sign-in is checked again before a metadata reconnection, with a 5–30 second retry delay. A deliberate Disconnect suppresses that recovery for the current app session. Unknown status offers Check sign-in rather than starting another browser login.

The plugin retains its saved key through extended loopback outages and keeps one recovery worker with a capped delay. Offline requests do not consume its reconciliation budget; rejected keys, changed place identity and unresolved command state retain their existing stop conditions. New chats inherit the active chat’s model and effort through the existing workspace preferences. A choice must still occur in the fresh native catalogue before it can start a turn.
