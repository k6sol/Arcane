# Desktop Luau verification setup

The source desktop host now contains native, project-scoped Luau configuration. This is not yet in the previously sealed pxvwBu portable build. A fresh compile, bundle and actual EXE check are still required before distributing this addition.

## User flow

1. Open the desired existing project through **File > Open project** in Arcane. Each project has separate saved settings.
2. Open **Workspace settings > Code verification**. **Refresh setup status** reads saved metadata only; it does not run a compiler or start a native coding client.
3. Click **Set up Luau verification**. Select an existing official Windows x64 luau-compile.exe in the native file dialog. The host accepts only the currently pinned official binary bytes, not a filename or help-text match.
4. Select an existing non-private evidence directory strictly inside the selected project. The setup does not create directories or inspect provider credentials. Use an ordinary project folder such as evidence/luau, not runtime, .git, .codex or .claude.
5. Review the native confirmation and choose **Save configuration**. Cancel is the default. Saving does not stop or restart active jobs, connections or model turns.
6. Restart Arcane manually to load the saved compiler configuration for that project. Recorded configuration is not compiler readiness, successful syntax verification or workflow completion.
7. For an actual scoped workflow, separately review the complete source files, evidence scope and required dependencies, then explicitly run the pinned verification action. See [production verification](WORKFLOW_CODE_HOST.md).

The current accepted SHA-256 is 74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8 (1,403,904 bytes). This pin comes from the already reviewed toolchain used by the local official-Luau checks. Setup never downloads, copies, updates or executes the binary. A different official release requires deliberate host-policy review; there is no PATH or arbitrary-executable fallback.

## What the setup guarantees

- The renderer sends only zero-argument status/configure intents. It cannot provide executable paths, hashes, shell commands, compiler flags or project identity.
- IPC requires the current main window, main frame and canonical loopback origin. Child frames, stale windows, extra arguments and navigation changes are refused.
- Compiler bytes, direct regular single-link identity, physical ancestors, the selected project and evidence directory are checked before and after human confirmation.
- Settings are an exact bounded tuple in the app-owned per-project state directory. Exclusive files and checked atomic replacement preserve the previous file until the rename. Corrupt, linked, replaced or unexpectedly modified settings are refused, not reset.
- Pending requests are fenced across project changes, including A -> B -> A, closing, pagehide and lost responses. Cancel preserves the last observed state. No operation is automatically retried.
- In an ordinary browser without the native bridge, setup is disabled and the UI explains the CLI route. Saving configuration never creates a green verification badge.

This feature currently produces **syntax-only evidence**. Type, security, regression, gameplay and full release approval remain unsupported or unverified. Native provider and Studio acceptance remain user-deferred.

## Verification scope

Parent offline host/IPC/filesystem checks: 49/49, including cold-start compiler failure containment and correction. Parent source-release/doctor/public-route fixtures: 36/36. UI sidecar: 15/15 including explicit fake-bridge Edge fixtures and real trusted keyboard events. These are component checks, not real dialogs or a completed game. No installed provider, Studio operation or compiler execution occurs in the setup fixtures.

A missing or invalid selected compiler now disables optional verification without stopping the core workspace. Arcane forwards no compiler environment keys, retains the settings, and displays a generic warning. Project/state, persisted-settings and evidence-security failures still stop startup; none are silently repaired or reset.

## Current executable mount evidence

The immutable bO9gOu build passed19/19 actual executable checks, including native bridge + controller mounted against the canonical live product ID. Proof: `runtime/verification/windows-executable-eAiI0C/verification.json`. The first rebuilt SpmvHP run exposed that the live metadata route omitted projectId; this was fixed in the route with an independent HTTP hash assertion, not by changing or removing the smoke gate. Current affected browser/HTTP/MCP/controller108/108 and full offline251/251 passed. Actual dialog interactions, full-game verification and native provider/Studio acceptance remain separate and unverified/deferred.
