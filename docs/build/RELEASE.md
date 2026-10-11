# Local release and startup

Status: an unsigned, credential-excluding source-directory package and startup checker are implemented. This is not an Electron installer, a signed executable, a hosted service, or proof that every native workflow works.

## Build, diagnose, run

From the Arcane repository or a generated package, in your own terminal:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run build:plugin
npm run doctor
npm run start:arcane
```

Requires Node 24+. Dependency installation does not run package lifecycle scripts. Normal certificate verification must remain enabled. A missing runtime or dependency produces an explicit error; the launcher does not silently substitute a provider, modify antivirus, log in, install the Studio plugin, or configure VS Code.

The launcher prints a private loopback workbench link. Open it locally. The link contains a human control bearer: do not paste it into Git, public logs or screenshots. Ctrl+C stops that launcher and its own daemon. Use the workbench to issue a masked Arcane Studio API key with explicit roots; read-only is the default. The plugin accepts only that key. Provider login remains with the provider's native client.

`ARCANE_PROJECT` selects the project folder. `ARCANE_PORT` selects the daemon port (default 45871; 0 requests an ephemeral port for isolated testing). A key embeds its port; use a stable port for persistent-key workflows. Startup checker success means local files/dependencies are ready, not that Studio, Blender or a provider inference turn was tested.

## Generate a local package

```text
npm run release:local
npm run test:release
node scripts/create-local-release.mjs --verify ABSOLUTE_RELEASE_DIRECTORY
```

The first command builds current TypeScript and the deterministic plugin, then creates a fresh directory under `runtime/releases/arcane-local-*`. Existing packages are not overwritten. A SHA-256 manifest records exact source/compiled/plugin/worker/skill/documentation bytes. Modified or unlisted immutable payloads fail verification. Packaging fails if a source changes during copying; incomplete output is retained for diagnosis, never returned as a successful package.

Only named source/build roots and allowed file extensions are copied. Provider credentials, `.env*`, runtime/session databases, generated client configurations, dependencies, caches, logs, symlinks/junctions and hardlinked files are excluded or refused. Additional checks reject actual local-key/session-link strings and credential-like JSON fields. These checks are defense in depth, not a universal secret scanner.

Dependencies are **not bundled**. Install pinned dependencies inside the package before running it; the startup checker refuses dependencies accidentally inherited from a parent checkout. `node_modules`, `runtime`, and `apps/mcp/generated` are mutable installation/user-state roots and explicitly outside package integrity verification. Their contents are not evidence of a verified distribution. The manifest is unsigned: a malicious party able to replace the files and manifest can forge it. Do not treat hashes as proof of publisher identity.

## Verification scopes

- `doctor`: read-only local files/dependencies/plugin-source freshness; no network, credentials, installs or inference.
- `test:release`: disposable packaging/path/credential-exclusion/tampering fixtures, not a production Studio test.
- `test`: TypeScript/unit/controller fixtures and offline skill contracts; any skipped browser checks are reported.
- `test:plugin`: package contracts plus official Luau compiler/VM checks when explicitly configured. VM engine doubles are not native Studio.
- Genuine Blender generation: separate worker-native acceptance artifacts.
- Genuine Studio connect/editor/undo/restore: separately requires the installed plugin and an explicitly selected disposable place. User deferred this gate on 11 October 2026; do not run it automatically.

Clean-package installation/build/start evidence is recorded separately from fixture tests. Windows signing, automatic updates, native desktop packaging, complete model/import/player-quality workflows and a full release audit remain required work.
