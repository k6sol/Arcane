# Project startup and retained state

Arcane keeps project records in its per-user application-data directory, separately from the portable app folder. Startup retains the remembered local port. It does not choose a replacement port, replace a key, retry a failed launch or downgrade a newer database automatically.

## Retained asset history

Startup validates the state root, its ancestors and metadata files before opening services. The bounded metadata walk checks direct paths, links, hardlinks, file types and depth. It validates the top-level `assets` directory without recursively counting generated artifacts against the 4,096 metadata-entry limit.

Asset owners validate their own job directories and regular files when loading them, including containment, link/hardlink refusal, bounded reads and opened-file identity. Asset history retains its separate job-count and scan bounds. An asset folder appearing below another metadata directory receives the ordinary metadata checks.

This lets a project with retained asset files beyond the metadata limit reach normal service initialization. It does not remove asset admission limits or resolve an interrupted worker. Bounded archival and confirmed-worker recovery remain separate work.

## Abandoned Studio import lock

A local runtime that was killed or shut down uncleanly can leave its Studio import preparation lock file behind. Before, that file blocked every later start of the project with a general startup failure. Startup now removes it, but only when all of these are true:

- this runtime holds the project's exclusive workspace lock, so no other runtime can be writing;
- the file is a plain regular file, 1 KiB or smaller, with no links;
- the file is either empty (a crash between creation and first write) or exactly this project's lock record.

Any other file is left alone, and the preparation records are still fully validated afterwards.

## Startup error log

The desktop app writes the local runtime's error output (stderr) to `daemon-stderr.log` in the project's runtime state folder, up to 64 KiB per run. The previous run's log is kept once as `daemon-stderr.previous.log`. Standard output is never logged because it carries the workspace token. If either name is an unexpected kind of file, logging is turned off instead of replacing it. Logging never delays or fails startup. The general startup failure message points to this log.

## Startup messages

The daemon reports one fixed code over its private launcher channel. It sends no paths, credentials, stderr or exception text.

| Observation | Launcher guidance |
|---|---|
| Actual listener bind reports an occupied port | Resolve the local port conflict and restart; keep the saved port |
| The project's workspace lock belongs to a live process, or `daemon.json` names a live process whose loopback listener answers | "Arcane is already open for this project in another window": an Arcane dialog offers Try again (rechecks) or Quit |
| A store refuses a newer schema | Open the project with the version that saved it or later |
| State path or metadata validation fails | Inspect retained application-data records before restarting |
| Installation resources are unavailable | Replace the complete app folder and restart |
| Unreported exit or other startup failure | Show a general startup failure without assuming a port conflict |
| Startup exceeds its existing deadline | Keep a previously reported cause, or show a general timeout |

Only an observed listener bind conflict receives the port-conflict code. Only a lock whose owner process is alive receives the in-use code; an unreadable lock keeps the general failure. The desktop app never signals the other instance, removes its lock or descriptor, or sends it a token; the one-instance-per-profile check still focuses an existing window first. The first valid report wins; a later ready message cannot override it. Malformed reports do not establish readiness or authorize a retry. Saved-port metadata keeps its independent identity and containment checks.

Startup cleanup still runs before reporting, and the original error is rethrown. Reporting has a bounded fallback when the IPC callback does not return, including when no other Node handles keep the process alive.

## Verification boundary

Filesystem fixtures cover retained history beyond the entry limit, hardlinks, junctions, unsafe segments and the remaining metadata bounds. Launcher fixtures cover failure mapping, timeout, malformed messages and saved-port continuity. Actual daemon subprocess fixtures use disposable state to exercise newer SQLite schemas, hardlinked stores, missing resources and an occupied loopback listener; they inspect the real IPC message and retained records.

These checks make no provider requests and do not connect to Studio. Packaged dialogs, native worker descendants, installer/update delivery and the complete customer journey retain their own acceptance requirements.
