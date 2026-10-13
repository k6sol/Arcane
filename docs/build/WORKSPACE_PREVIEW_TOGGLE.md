# Workspace model preview presentation

The workspace starts with the conversation visible and `#artifact-panel` hidden.
`#workspace-preview-toggle` manually shows or hides the existing panel;
`#workspace-preview-close` and unhandled Escape inside the panel close it.
The shell synchronizes `hidden`, `.preview-open` on `#workspace-stage`, and the
toggle's `aria-controls`, `aria-expanded`, `aria-pressed` and accessible label.
Opening manually focuses the close control. Closing restores the opener, falling
back to the toggle or existing composer if the opener is detached, disabled,
hidden or inert. Automatic opening preserves the current focus. Closing also
exits preview fullscreen, including an entry that completes after the close.

The UI owner supplies the two buttons, the panel's initial `hidden` attribute,
and the stage's single-column/default and `.preview-open` two-column styles.
The shell creates no markup and changes no theme tokens.

## Parent integration contract

`workspace-shell.ts` exports `WORKSPACE_ASSET_ACTIVITY_EVENT` and the
`WorkspaceAssetActivity` type. StudioWorkbench must dispatch this presentation
event on its document after the shell is bound:

```ts
import { WORKSPACE_ASSET_ACTIVITY_EVENT, type WorkspaceAssetActivity } from './workspace-shell.js';

document.dispatchEvent(new CustomEvent<WorkspaceAssetActivity>(
  WORKSPACE_ASSET_ACTIVITY_EVENT,
  { detail: { jobId: observedJob.jobId, state: 'running' }, bubbles: false },
));
```

The exact detail is `{ jobId: string, state: 'queued' | 'running' | 'succeeded' }`.
Job IDs contain 1–128 ASCII characters, beginning with a letter or digit and
continuing with letters, digits, `.`, `_`, `:`, or `-`. Only these two own data
fields are accepted. Extra fields, accessors, inherited fields, invalid states
and oversized IDs are ignored. Do not include request text, errors, paths,
secrets, tokens, URLs, receipts or model configuration.

Emit from genuine, current asset state only:

- `queued`: an actual creation/admission receipt establishes the exact queued
  job; a click, draft, permission request or speculative placeholder is insufficient.
- `running`: a current validated asset observation identifies an actual running
  job in the active scope. Emit on first observation/identity transition, not
  on every poll, tool-tab change or historical job selection alone.
- `succeeded`: a completed job's authenticated, hash-verified preview has been
  decoded, drawn and appended to `#asset-previews` for that exact current job.
  Dispatch after the existing current-context, preview-epoch and job-ID checks
  in `loadAssetManifest`, immediately after appending a drawn canvas. Mere job
  completion or manifest availability is insufficient. The consumer also
  requires a positive-size `figure canvas[role="img"]` in `#asset-previews`.

This change implements the consumer and documents the producer integration.
It does **not** edit StudioWorkbench (`studio.ts`), which is outside this task's
ownership. Without a parent producer, manual controls work but real asset jobs
do not automatically open the panel. The parent owner must add the emissions
above; browser fixtures explicitly emit synthetic activity for validation.

Each accepted job identity can auto-open once per document. Repeated queued,
running and loaded-preview events cannot reopen a dismissed job, even after a
different job, canvas replacement, tool switch or pagehide/pageshow rebind.
A different genuine job can auto-open. Manual controls remain available at all
times. The document retains at most 256 observed job IDs in a WeakMap, without
storage or eviction; additional identities do not auto-open until a new document
is loaded. This keeps memory bounded without forgetting deliberate dismissals.

`#asset-job-summary` remains sanitized display text, not a lifecycle signal.
The existing preview MutationObserver still selects real figures and updates
the guide; it never opens the panel. Empty placeholders, text such as “running”,
and canvas mutations alone cannot establish a job identity or trigger opening.
The parent event is presentation only and never authorization: no provider,
Studio, model, creation, cancellation, connection, draft, thread, grant or
security action is performed by the consumer.

## Private validation

Compile with a temporary configuration extending the repository's `tsconfig.json`,
explicitly listing the desktop source files, `workspace-preview-toggle.test.ts`
and `workspace-shell.test.ts`. Include `studio.ts` and its desktop imports because
the existing shell suite dynamically imports Studio using a string variable.
Override `outDir` to an owned temporary directory and `typeRoots` to the
checkout's absolute `node_modules/@types` path; the temporary configuration
cannot discover the checkout's Node types through its own parent directories.
Put `{ "type": "module" }` in the private output directory's `package.json`.
Use the repository's pinned TypeScript compiler; do not invoke the root build
or write `dist`.

From the checkout, run with the saved private configuration and output paths:

```powershell
node node_modules/typescript/bin/tsc -p "$previewRoot/tsconfig.json"
$env:ARCANE_UI_BROWSER_MODULE = (Resolve-Path 'node_modules/playwright-core/index.mjs').Path
$env:ARCANE_UI_BROWSER_EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:ARCANE_UI_FIXTURE_DIR = $previewRoot
node --test --test-concurrency=1 "$previewRoot/compiled/tests/unit/workspace-preview-toggle.test.js" "$previewRoot/compiled/tests/unit/workspace-shell.test.js"
```

Run the compiled tests with `node --test --test-concurrency=1`. Enable the owned,
headless Edge browser fixture by setting `ARCANE_UI_BROWSER_MODULE` to the
repository's `node_modules/playwright-core/index.mjs` and
`ARCANE_UI_BROWSER_EXE` to the installed Edge executable. The fixture loads only
the privately compiled shell into synthetic HTML, blocks and counts all network
requests, and mounts no native controller or installed CLI. It checks keyboard
toggle/close, focus, real canvas loading, repeated polls, job dismissal,
page restoration, desktop/mobile interaction, unchanged draft/transcript and
zero submissions or input events. Unit fixtures additionally cover malformed
events, bounded memory, absent controls, cleanup and fullscreen races.

`ARCANE_UI_FIXTURE_DIR` selects the private directory for a newly created Edge
profile. No existing browser profile is used. Some restricted Windows execution
sandboxes terminate Edge before page creation; the same owned fixture may need
an approved process launch outside that sandbox. The fixture's page requests
remain blocked and no native controller is mounted.

Validation on 2026-10-13: private strict TypeScript compile passed; 25 unit cases
passed (9 new preview cases and 16 existing shell cases); the separate owned
Edge 155.0.4283.45 fixture passed, including desktop/mobile keyboard interaction,
with zero page requests, submissions or draft input events. Compile configuration
and output were kept under
`C:/Users/alexk/AppData/Local/Temp/arcane-workspace-preview-xMEZzT`.
Only `apps/desktop/src/workspace-shell.ts`,
`tests/unit/workspace-preview-toggle.test.ts`, and this document were edited.
