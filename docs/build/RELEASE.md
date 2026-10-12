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

On Windows, `npm run setup:arcane` checks the local prerequisites. Explicit `-InstallDependencies`, `-Prepare` and `-Launch` switches select installation, sequential builds and launch; `scripts/launch-arcane.cmd` selects launch only. See [FIRST_RUN.md](FIRST_RUN.md) for the commands and troubleshooting. These entry points are included in the source package.

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

The bitmap exception is exactly `apps/desktop/public/brand/arcane-ridges.png`, Arcane's own generated brand art (currently 2,108,459 bytes). It must have a PNG signature and is hashed like every other immutable payload. Other PNGs are excluded across all collected roots. The only PowerShell/CMD exceptions are `scripts/setup-arcane.ps1` and `scripts/launch-arcane.cmd`; arbitrary scripts with those extensions are excluded. Once the first-run command or any first-run file is present, both entry points and `docs/build/FIRST_RUN.md` are required.

Packaging requires the workbench HTML/CSS, compiled Studio/chat modules, `apps/desktop/src/workspace-shell.ts`, its compiled JavaScript/source map and the brand PNG. The existing source-map provenance, dependency-lock, path, credential and copy-race checks still apply. The doctor checks these frontend files and the PNG signature before reporting readiness.

Dependencies are **not bundled**. Install pinned dependencies inside the package before running it; the startup checker refuses dependencies accidentally inherited from a parent checkout. `node_modules`, `runtime`, and `apps/mcp/generated` are mutable installation/user-state roots and explicitly outside package integrity verification. Their contents are not evidence of a verified distribution. The manifest is unsigned: a malicious party able to replace the files and manifest can forge it. Do not treat hashes as proof of publisher identity.

## Verification scopes

- `doctor`: read-only local files/dependencies/plugin-source freshness; no network, credentials, installs or inference.
- `test:release`: disposable packaging/path/credential-exclusion/tampering fixtures, not a production Studio test.
- `node --test tests/release/ui-assets.test.mjs`: small offline UI packaging fixtures, including a synthetic HTTP daemon for acceptance-checker routes, headers and credential redaction. No current application build or native runtime is exercised.
- `node scripts/check-local-release.mjs ABSOLUTE_RELEASE_DIRECTORY`: after the package is independently installed and prepared, checks its own loopback daemon. The current checker expects thirteen acceptance checks, including credential-free `/workspace-shell.js` and `/brand/arcane-ridges.png` responses with exact package bytes, MIME, CSP, `no-store`, `nosniff`, `no-referrer`, and rejection of unlisted static routes. This does not verify browser rendering or interactions.
- `test`: TypeScript/unit/controller fixtures and offline skill contracts; any skipped browser checks are reported.
- `test:plugin`: package contracts plus official Luau compiler/VM checks when explicitly configured. VM engine doubles are not native Studio.
- Genuine Blender generation: separate worker-native acceptance artifacts.
- Genuine Studio connect/editor/undo/restore: separately requires the installed plugin and an explicitly selected disposable place. User deferred this gate on 11 October 2026; do not run it automatically.

Clean-package installation/build/start evidence is recorded separately from fixture tests. Windows signing, automatic updates, native desktop packaging, complete model/import/player-quality workflows and a full release audit remain required work.

## Historical clean-package proof and pending UI acceptance

On 12 October 2026 (Europe/London), `runtime/releases/arcane-local-OYBydj` passed ten recorded acceptance checks: private-loopback startup, workbench/CSP serving, isolated SQLite state, cross-origin denial, human read-only key issuance with redacted lists, agent grant denial, local key revocation, compiled native-chat module serving, inert native-chat state with the exact project, and agent/cross-origin denial before native launch. Its daemon closed through private parent-child IPC with exit 0.

The package manifest SHA-256 is `2d42d1996e318430b860f60c178638a625cc4685b560e759ab712474ae4b6b0c`, recorded in `docs/research/local-release-checks.json`. No Studio, provider inference, or Blender calls were made in that acceptance. The previously recorded 317 regression passes are historical evidence from before this UI slice.

On 12 October 2026, `node --test tests/release/ui-assets.test.mjs` passed 20/20 offline tests, including its synthetic thirteen-check acceptance fixture, safe-header rejection and credential redaction. JavaScript syntax checks passed for the three release scripts and the new fixture file.

The new workspace shell, brand art and first-run entry points still require the parent's fresh serial build, regression and independent clean-package acceptance. Offline packaging fixtures do not extend the historical snapshot's proof to current worktree changes. The legacy `tests/release/local-product.test.mjs` fixture must also be refreshed with the now-required frontend files before the full release test run; that file is outside this slice's ownership. The full product remains incomplete.
