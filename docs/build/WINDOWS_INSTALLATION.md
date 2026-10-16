# Windows installation engine

The installation engine stages verified Windows directory packages and publishes an active release record. The setup executable, launcher, shortcuts, uninstall registration and clean-machine acceptance remain separate work.

`createWindowsInstallation()` from `scripts/windows-installation.mjs` exposes two host-only operations:

- `install({ bundle, installRoot, signal?, onProgress? })` verifies the complete source package with the production bundle verifier, copies its exact inventory into a fresh release directory, verifies the copy, then publishes `installation.json` through a single file replacement.
- `status(installRoot)` reads bounded installation metadata. Its `integrityVerified: false` explicitly distinguishes a record observation from a verified executable.

The installer host chooses the program directory. The engine requires its parent to exist and admits only an empty new directory or a valid existing Arcane installation. App profiles and projects remain separate. Updates retain previous releases and unrelated files. Failed candidates remain available for inspection and are never automatically adopted or removed.

On Windows, admission reserves the complete release and bundled runtime path below 260 characters. This check happens before verification or target mutation: copying files successfully alone cannot establish that Windows can start a child from that directory. See Microsoft's [current-directory restriction](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory). No machine path policy is changed.

An exclusive operation lock fences concurrent installers. Its identity and contents are checked throughout the operation. Changed records, locks, copied files, directories, extra entries, links and junctions refuse publication. The final tree must match the verified inventory, including when reactivating a retained release. Filesystem checks use cooperative ownership and identity; operating-system isolation remains separate.

An optional `AbortSignal` cancels before publication, retaining the previous selection and the candidate. Cancellation after completed publication still reports the installed release. The trusted, synchronous `onProgress` observer returns `undefined` and receives frozen phase/file/byte counters. It supplies presentation metadata rather than installation authority.

Failures preserve the primary cause and report `published: false`, `true` or `null` for retained selection, completed publication or unconfirmed publication. Lock-cleanup failures are retained separately. There is no automatic retry, stale-lock takeover, program launch, shortcut creation, registry write or profile deletion. Retention is bounded to 32 recorded releases; removal and interrupted-install recovery need their own explicit host workflow.

Focused tests use actual temporary filesystems with a labelled small-inventory verifier. Full package acceptance uses the production verifier and separately records the engine source hash and bundle manifest. Neither fixture coverage nor package copying establishes a complete installer or an authenticated customer task.
