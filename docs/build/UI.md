# Studio workbench

The local product panel is served at /studio. Open the launcher's /studio#CONTROL_TOKEN link. The browser removes the fragment and retains only the human control token in the existing tab-scoped arcane-lab-session storage entry. Each browser request uses the local bearer, omits cookies, refuses redirects, and supplies Origin automatically on POST. Native fetch is called as a plain function so it does not receive StudioApi as its receiver.

## Studio API keys and operations

The default connection card issues an Arcane API key through POST /v1/studio/keys with explicit allowedRoots and allowWrites. Workspace is selected and writes are disabled by default. The returned key must match arcane_local_v1_PORT_64HEX, this exact literal loopback daemon port, and the human-selected service grants. The plugin infers its local endpoint from the key: open Arcane in Studio’s Plugins toolbar, paste the key, and press Connect. The workbench has no plugin daemon URL or pairing-code inputs or instructions.

The raw API key is returned only on issuance. It starts masked; Reveal key and Copy API key are separate explicit actions. Dismiss secret, in-page navigation, session selection, link navigation and page exit clear the secret from memory and DOM. A response arriving after navigation cannot redisplay it. Browser history restoration resumes refresh with the secret cleared. No API key is added to browser storage. Copying writes to the clipboard only after the user clicks Copy API key.

GET /v1/studio/keys renders metadata only: key ID, roots, write permission, issue/revocation dates and reported last use. The UI refuses a list containing raw keys. API key access & revocation provides a human confirmation for POST /v1/studio/keys/revoke {keyId}; the confirmation displays metadata only. A lost issuance or revocation response is not replayed automatically. The UI refreshes recorded key metadata, then requires an explicit human acknowledgement before another mutation; raw secrets cannot be recovered from history.

Keys are persisted as hashes by the parent-owned store and remain revocable. Human control credentials protect listing, issuance and revocation; scoped native agent credentials cannot grant plugin access. A connected window is chosen by its exact session ID and clientSessionId; place ID and display path never substitute for window or instance identity. Legacy one-use pairing endpoints remain compatible at the lower protocol layer and are absent from the default view.

Browse, search, selection, inspect and source reads use /v1/studio/commands. Returned opaque refs can be selected or copied. Property and editor baselines are captured only from succeeded read receipts whose result ref matches the original request and exact client session. Expected fields come from those receipts. Editable properties, creation classes and source sizes remain bounded by the bridge contract.

History displays queued, dispatched, succeeded, failed, cancelled and needs_reconciliation distinctly. The workbench requires fresh exact-session history and heartbeat before sending commands. An unknown POST retains its original UUID and payload; only an explicit identical command retry reuses the idempotency key. Restore sends only commandId and a fresh requestId to /v1/studio/restore. Its confirmation shows before, after and exact session; the plugin compares current after-state before restoring.

## Durable work and human review

The Work queue reads GET /v1/work/runs and GET /v1/work/ready independently of Studio availability. It shows durable run IDs, task keys, file scopes, dependencies, worker labels, lease expiry, progress, review notes and recorded evidence. Ready status comes from the ready endpoint; completion is never inferred from a worker summary. The authored Project build board remains a separate view of /v1/product/state.

Create a scoped work run expands a structured editor for 1–64 tasks. Each task has a unique key, instructions, acceptance criteria, explicit relative file scopes and a dependency list. The UI checks missing keys, cycles and unsafe scope syntax; the WorkStore remains authoritative for filesystem links, leases and file hashes. POST /v1/work/create records the graph. It does not launch a worker or claim file access.

Select a submitted task to read its evidence paths, SHA-256 digests, byte counts, notes and submission times. A nonempty human decision note and an explicit confirmation are required before POST /v1/work/review. Approve verifies unchanged evidence through the daemon and releases dependent tasks; Request changes returns the task to pending. The confirmation is rejected locally if the displayed submission changed while it was open. Review requires the human control token and exact browser Origin; scoped agent tokens cannot review. The UI does not expose worker lease tokens or silently claim, submit or approve tasks.

Create and review have no idempotency key. An ambiguous response blocks further work decisions, refreshes only through GET, and requires the human to inspect recorded runs and explicitly acknowledge that inspection before a new decision. These pending ambiguity notices are in-memory UI state; recorded runs and decisions survive browser reloads and daemon restarts in WorkStore.

## Native agent connection

Get scoped agent token explicitly POSTs {} to /v1/product/mcp-token with the human browser credential. It accepts only a distinct token with canReview:false and expires:daemon lifetime. The returned scopes and token are displayed in the panel; Copy scoped agent token requires a separate click. The agent token is kept only in memory and the ephemeral DOM, cleared on page exit and replaced only by an explicit handoff. It is never added to localStorage or sessionStorage.

The PowerShell setup displayed in the panel uses ARCANE_DAEMON_URL for this daemon origin, ARCANE_LOCAL_TOKEN for the scoped agent token, and npm run launch:native. The human control token is not inserted into these terminal instructions. A daemon restart requires a fresh launch link and scoped token. This scoped native agent token is separate from the Studio plugin API key and cannot issue, list or revoke Studio keys. Provider credentials are not used by this flow.

## Asset workshop

The panel uses the parent's fixed-template API:

- POST /v1/assets/probe with {} for observed installed runtime capabilities.
- GET /v1/assets/jobs for recorded job identity, state, stages and errors.
- POST /v1/assets/start with bounded AssetInput fields only.
- POST /v1/assets/cancel with the exact selected jobId.
- GET /v1/assets/manifest?jobId=... for a verified completed manifest.
- GET /v1/assets/preview?jobId=...&path=... for authenticated PNG bytes.

Only hero-prop and environment-kit are offered. Size defaults follow the selected template. Slugs, meters, colors, seed, triangle budget, render resolution and samples use the pipeline's bounds. Start requires a successful runtime probe, no running job and no interrupted supervision. Missing endpoints visibly disable actions; no runtime, stages or completion states are fabricated. A job start or cancellation with an unknown outcome is never replayed automatically.

Manifest loading checks the selected job and request identity, then fetches only preview-hero.png and preview-side.png with the bearer header. The browser compares preview bytes and SHA-256 against the manifest and decodes them into canvas elements. It puts no token in preview URLs and creates no blob image URL, so previews work under the parent's self-only image CSP. The panel displays the mesh audit, artifact hashes, warnings and limitations. Export/import quality and Roblox scale remain separate review requirements.

## Verification

Use npm run typecheck for the root no-emit check. For isolated UI verification, compile tests/unit/studio-ui.test.ts with the repository compiler and strict NodeNext settings into a temporary output directory. ARCANE_UI_BUILD_DIR selects the emitted browser JS for the HTTP fixture. The real-daemon browser test uses the product's generated dist/apps/desktop/src/studio.js; copy only that browser build artifact after compiling the assigned source.

Set ARCANE_UI_BROWSER_MODULE to an existing Playwright index.mjs and ARCANE_UI_BROWSER_EXE to an installed Chromium browser. Run node --test against the emitted studio-ui.test.js. ARCANE_UI_SCREENSHOT optionally saves desktop/mobile screenshots and focused panel captures. Temporary output can reference the repository’s existing node_modules through a temporary junction when parent-owned daemon routes import dependencies. No root dependencies are installed by this workflow.

As verified on 2026-10-11, all 24 focused checks passed with Microsoft Edge, including API-key grant/format/port validation, metadata-only history, masked/revealed/copied secrets, dismissal/navigation cleanup, revocation and lost-response handling, the native-fetch receiver regression, safe DOM/CSP, exact references and baselines, restore and ambiguity recovery, responsive layout, fixed-template asset control and authenticated preview corruption rejection. The asset/command browser server is explicitly an HTTP contract fixture: its synthetic runtime and preview bytes are not native integration evidence. A second browser test runs real daemon routes with temporary SQLite WorkStore state and real evidence files: human key issuance and scoped-agent denial, key-based HTTP plugin connection, reported last use, revocation of the key and its connected session, persistent key metadata without raw secrets, create, scoped-token handoff, human Origin enforcement, hash conflict, changes requested, re-submission, approval, readiness, lost create response, reload and daemon restart all passed.

The key-based plugin exchange in these tests is an explicitly labeled HTTP protocol client. No actual native Studio plugin operation, Blender generation, Roblox asset import or Hunted place change was performed by this UI work. Native fixture ownership and verification remain with the parent.
