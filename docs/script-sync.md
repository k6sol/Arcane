# Script sync

Optional two-way sync between the paired Studio place and the open project folder, so you can edit scripts in your own
editor and keep them in git with your own linters while Arcane keeps working in Studio.

It is **off by default** for every project. Turn it on in **Settings › Project memory › Script sync › Sync scripts with project
folder**. The switch is saved in Arcane's own state directory (`script-sync.json`), never in the project folder, so cloning a
repository cannot turn it on.

## Layout

```
<project>/
  src/
    ServerScriptService/Main.server.luau          Script
    ReplicatedStorage/Shared/Util.module.luau      ModuleScript (inside the Folder "Shared")
    StarterPlayer/StarterPlayerScripts/Input.client.luau   LocalScript
  .arcane/sync.json                               index: file -> instance reference + last agreed source hash
```

- Roots: ServerScriptService, ReplicatedStorage, StarterPlayer, StarterGui, ServerStorage and Workspace, but only those the
  Studio pairing grants. Nothing outside the granted roots is read, written or created.
- Names that cannot be file names (reserved Windows names, `<>:"/\|?*`, trailing dots or spaces) and two scripts that share a
  path (case-insensitively) are skipped and listed under **Skipped files**.
- Files are compared as UTF-8 text with LF line endings and no byte-order mark, so editor or git line-ending settings do not
  cause changes in Studio.
- `.arcane/sync.json` also keeps `ignored` (files you chose **Stop syncing** for). Delete the file to start a fresh sync; it is
  tied to one place and universe and refuses to sync a different place.

## How changes move

| Change | What happens |
| --- | --- |
| Studio script changed, file unchanged | The file is rewritten. |
| File changed, Studio unchanged | `script.update` with the exact current Studio source as `expectedSource`. |
| Both changed (or first sync and they differ) | Listed under **Conflicts**; nothing is overwritten. **Keep Studio** rewrites the file, **Keep file** applies the file with a fresh exact baseline. |
| New Studio script | A new file is written. |
| New file | `scene.create` (always disabled) in the existing parent, then `script.update` with its source. If the parent folder does not exist in Studio it waits, listed under Skipped files. |
| File deleted | Never propagated. Listed under **Deletions to confirm**: **Restore file** or **Stop syncing** (delete the script in Studio yourself). |
| Script removed in Studio | Never propagated. **Delete file** or **Recreate in Studio** (disabled). |

Arcane never enables a script. Sync runs:

- right after a file is saved (folder watch, debounced),
- within about two seconds of any Arcane `script.update` receipt (chat or tools) for a tracked script, and a rescan after an
  Arcane `scene.create` of a script,
- on a bounded full poll every minute, and on **Sync now**.

## Safety

- Every Studio call goes through the normal Studio command queue and its admission (session, grants, write permission, plugin
  capabilities). File changes are applied only with a writable pairing and while Studio is in Edit mode; otherwise they wait
  and the reason is shown.
- Files are written only under the project folder (canonical path), atomically. The `src` and `.arcane` folders and every
  folder below them must be plain folders: symbolic links and junctions are refused, linked or hard-linked files are skipped.
- Bounds: 100 KiB per script (as `script.update`), 500 scripts, 4,000 instances, depth 32, 1,000 files and 16 MiB per scan.
  Anything beyond is skipped and listed, and Studio-side deletions are not reported while a scan is incomplete.
- Routes (`/v1/script-sync`, `/run`, `/resolve`, `/deletion`) accept only the human desktop bearer; changes require the local
  panel origin. Agent and scoped credentials are refused.

Code: `apps/daemon/src/script-sync.ts` (engine), `apps/daemon/src/script-sync-routes.ts` (routes),
`apps/desktop/src/script-sync.ts` (Settings card). Tests: `tests/unit/script-sync.test.ts`.
