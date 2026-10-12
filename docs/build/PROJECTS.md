# Open your own project

Arcane can run beside an existing local project in any direct directory. The project does not need to be the Arcane source checkout or a Git repository. Run the launcher from the prepared Arcane installation, supplying exactly one absolute path:

```powershell
npm run open:project -- "C:\Projects\MyGame"
```

On systems using POSIX paths, supply an existing absolute directory such as `/home/me/projects/my-game`. Quote paths containing spaces. Relative paths, missing directories, files, filesystem roots, UNC/device paths, traversal segments, symlinks and junctions in the selected path or its ancestors are rejected. Select the direct local directory instead. Project validation reads filesystem metadata, without enumerating project contents or scanning credentials.

Prepare Arcane's local dependencies, compiled product and plugin using [FIRST_RUN.md](FIRST_RUN.md). The launcher runs `productDoctor` against the Arcane installation before creating project state or starting its daemon. Failed prerequisite checks are reported and startup stops. It does not install or build automatically. Doctor success covers local files and dependencies; it does not verify native inference, Studio or Blender.

The launcher starts one foreground child using the current Node executable and the fixed bundled daemon entry, with Arcane as its source working directory. The selected project's canonical path is supplied separately as `ARCANE_PROJECT`, including to the existing asset service. Open the private workbench link printed by the daemon. Keep this terminal open; Ctrl+C sends shutdown only to its own child. The wrapper returns that child's final exit code. It never looks up, stops or replaces an existing Arcane process.

## Project state and ports

Each canonical project path gets a stable directory in the Arcane installation:

```text
runtime/projects/<SHA-256-of-canonical-project-path>/
  studio.sqlite
  work.sqlite
  daemon.json
  connection-lab/
  assets/
```

On Windows the canonical path is folded to lowercase before hashing, so casing aliases select the same state. The hash names state; it is not a secret or an access credential. Reopening the same path retains its work, Studio key metadata, connection preferences and asset history. A different project starts with separate stores, keys and asset output. With a state override, the asset service uses that directory's `assets` subdirectory for output and history, keeping other projects' jobs out of the selected project's history. Moving or renaming a project selects a new state directory; this launcher does not migrate old state. Existing default startup keeps `runtime/product`, `runtime/connection-lab` and `runtime/assets` for compatibility.

`open:project` defaults to `ARCANE_PORT=0`, letting the OS choose a free loopback port so another Arcane daemon can remain running. For a stable port, explicitly set `ARCANE_PORT` in this terminal before launching. Port values must be decimal integers from 0 through 65535. Studio keys embed the daemon port: a key retained in project state may be unusable after a restart with a different ephemeral port. Use a dedicated stable port for persistent-key workflows, or issue a fresh key in the current project's workbench.

The launcher overrides inherited `ARCANE_PROJECT` and `ARCANE_STATE_DIRECTORY` for its child. Advanced direct daemon startup can supply an absolute `ARCANE_STATE_DIRECTORY` strictly inside this installation's `runtime` directory. Startup checks real paths and rejects redirected directory components, nested links, hardlinked state files and non-regular files before opening stores. Metadata inspection is limited to 4,096 entries and 16 nested directory levels. The state path is internal startup configuration; no HTTP field, route or browser setting is added for it. Use the launcher to obtain project isolation; reusing a manually selected state directory across projects defeats that separation.

## Current limits

- Launching opens the local workbench only. Native Codex starts only after a later explicit human **Connect** action. Arcane's workbench integration supports `personal-local` use with the user's own native ChatGPT subscription session. It is not a shared subscription service. Native sign-in remains a separate user action in the installed CLI; see the official [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth) and [app-server documentation](https://learn.chatgpt.com/docs/app-server), plus [CODEX_CLIENT.md](CODEX_CLIENT.md) for Arcane's narrower supported contract. The launcher changes no global settings, authentication storage or executable configuration.
- A project directory does not choose a Studio place. The human must connect the intended local Studio plugin to this daemon with its own scoped key and explicitly grant writes. Genuine Studio verification remains deferred.
- One daemon owns a project's Studio store lock at a time. A second launch for the same project fails instead of replacing the running daemon. Different projects can run simultaneously with distinct state and ports.
- Native workers, imports and provider capabilities keep their existing limits.
- Project separation and cooperative work scopes are not an OS sandbox. These startup checks do not defend against a process running as the same user concurrently replacing directories. Runtime state remains local private data; the launcher does not copy, migrate or expose it.

`tests/release/projects.test.mjs` uses disposable directories, a synthetic doctor/daemon and metadata-only substitutes for product services. It verifies path rejection, child arguments/environment/cwd, exit propagation, state separation and the asset output-root option with synthetic per-project history. These fixtures do not prove live UI behavior or native asset generation. They run without starting the real product, a native provider, Blender or Studio. Full serial builds, regressions and live UI verification remain separate parent checks.
