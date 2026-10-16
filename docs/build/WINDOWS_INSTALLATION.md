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

`createWindowsSetupPayload()` from `scripts/windows-setup-payload.mjs` streams a deterministic stored ZIP containing the verified bundle and a fixed five-module installation kit. The kit manifest independently pins the bundle manifest, bundled Node and each kit file; the returned receipt also pins the entire payload and kit manifest. Changed inputs or replaced outputs refuse acceptance and retain the candidate. The actual C# reader extracts the writer's data-descriptor format in a separate console fixture. This component supplies bytes for a setup executable; the graphical bootstrapper, launcher and registration are still required.

The signed installation-engine snapshot `b898ff2c9749e13a285f9228370bed74acd7917e` installed the existing application package from `186787684c1b964ea03c02d10c00c474889dcb5a` into a fresh owned temporary directory. Production verification covered all 4,174 payload files and the manifest before and after copying; activation took 67,955 ms and retained the separate profile fixture. The installed executable then passed all 32 startup, renderer, bundled MCP and shutdown checks in 32,555 ms. Its screenshot was reviewed. The application manifest remains `d4f015fd7275886ced9f784c6ce4efffc2d812efaec54eb8fe985ac810e422ae`; later application changes are excluded. No setup GUI, shortcuts, registration, application signature, provider inference or Studio operation was involved.
