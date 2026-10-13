# Simple provider onboarding — 2026-10-13

The production `/studio` page uses the existing Arcane mark and `#ff3340` logo
red, soft black surfaces, proportional system typography, and reduced-motion
support. This is a focused update to the existing workspace. Browser preview and
the EXE use the same `apps/desktop/public/studio.html` and `studio.css`; there is
no demo workspace, invented account, sample conversation or separate preview UI.

## Sign in

The first-run card has the heading **Sign in**, **Codex** and **Claude** choices,
one short description and one primary next action. Native availability is checked
from the existing frozen version-1 provider bridge, without calling it at mount.
No credential inputs, credential-file reads or new CLI transport are introduced.

- An unknown or signed-out provider offers native **Sign in with Codex** or
  **Sign in with Claude Code**. Login uses the existing `providerSetup.login`.
- A native sign-in handoff with unknown authentication offers **Check sign-in**. Its
  separate trusted gesture calls the existing `status`; handoff never means
  authentication succeeded. The unchanged bridge can use the parent's verified
  official Codex browser login flow; this UI does not hardcode terminal login.
- Reported Codex subscription sign-in offers **Connect Codex** through the
  existing connect control. The card hides only for the chat controller's
  actually reported **fresh, connected, ready, subscription** state. A native
  setup snapshot or remembered choice alone cannot unlock chat or Send.
- If a freshly observed native account differs from an old connected client,
  **Disconnect old session** and **Connect Codex** remain two explicit gestures.
  Mount, selection and resume never disconnect automatically.
- Claude's description states **Claude Code opens in its native terminal**.
  Verified native sign-in offers **Open Claude Code** via the existing launch
  handoff. Arcane does not represent it as an embedded Claude conversation.
- Without a valid native bridge, setup controls are disabled and the description
  says **Open the desktop app to sign in**. Removing a DOM disabled attribute
  cannot create a bridge or dispatch a connection.

Short setup status stays in Settings → General. Full native messages, CLI
version and API/cloud billing details are behind Settings → Advanced → Provider
details. Installation instructions remain an explicit existing Settings action;
onboarding never invokes them automatically. The original model picker,
permission gates, draft, preview toggle and controller IDs are retained. Empty
workflow disclosure is hidden until its real controller supplies content.

## Remembered provider is presentation only

Browser fallback storage is origin-local `arcane.provider-presentation.v1`.
The only accepted value is bounded JSON `{ "version": 1, "provider": "codex" }`
or the corresponding `claude` value. It accepts at most 80 characters and exactly
those two fields. No authentication result, account, secret, native authority or
credential is saved. Denied, unavailable and malformed storage fails gracefully.

Origin-local storage alone cannot provide EXE restart persistence: the native
host uses a random port and an in-memory browser partition. The chat preference
owner owns the native `workspacePreferences` read/save lifecycle and the complete
bounded per-project provider/tabs payload. This provider controller never reads
or independently saves that whole native payload.

The integration event is exported as `PROVIDER_PREFERENCE_EVENT`:

```ts
// Exact presentation data only; no version, auth, token or connection fields.
document.dispatchEvent(new CustomEvent('workspace:providerpreference', {
  detail: { provider: 'codex' } // or 'claude'
}));
```

Trusted provider selection and the existing model-picker `workspace:providersetup`
selection emit that event. The native preference owner can listen and save its
whole payload. Restoring the same event updates selection without opening
Settings, probing status, invoking native actions or emitting recursively.
Extra fields, non-data properties and accessor getters are rejected. Restoring
Claude preference does not create Claude chat support or signed-in status.

The completed `WORKSPACE_PREFERENCES_20261013.md` and chat restore implementation
were inspected. `startChatTabs` emits exactly this provider event after hydration
and suppresses saves while dispatching restore. Studio currently mounts the
provider listener before chat startup. At handoff, the adapter requires a
versioned `{ version: 1, available, preferences }` read acknowledgement while
the native host/preload/document currently expose only `{ available, preferences }`.
That mismatch was relayed to Faraday and the parent; their owners must align the
intended versioned envelope. The `{ saved: true }` save acknowledgement matches.

Native setup responses retain their exact version/provider/state schema,
accessor rejection, bounded safe text and frozen bridge requirement. Native setup
metadata expires after 60 seconds for presentation reuse and clears on stop.
Provider changes and lifecycle changes discard late responses. Actions still
require trusted, unmodified, non-prevented gestures and respect busy/disposed
guards. The separate chat controller retains authority and acknowledgement
checks; a provider preference event cannot bypass them.

## Other workers' integration mounts

| Mount | Initial production state | Owner |
| --- | --- | --- |
| `workspace-chat-tabs` | Empty `role="tablist"`, label `Open chats` | Chat tabs controller |
| `workspace-new-chat` | Separate button labelled `New chat` | Chat tabs controller |
| `codex-task-usage` | Empty and hidden, `aria-live="polite"` | Native task usage renderer |

The topbar no longer exposes All tools/Roblox/Blender tool tabs. Sidebar tool
buttons continue to select context within the conversation. No old topbar IDs
required a compatibility mount. The old sidebar `new-chat` ID remains separate
for the parent to integrate with the existing WorkspaceShell guards.

Faraday's `enableChatTabs`, state subscription and `.chat-tab`/`.chat-tabs-history`
renderer contract was inspected and relayed. Its rendered tabs and close buttons
have compact horizontal scrolling and accessible selected/focus styling. The
parent owns Studio startup, root-to-`/studio` routing, diagnostics routing, static
module registration and native preference binding. `studio.ts` historically
overwrites `providers-link`; its owner must retain the intended diagnostics
destination instead of sending users back to the former root provider screen.

## Verification and limits

`tests/unit/provider-setup-ui.test.ts` retains its existing validation and Edge
assertions and adds bounded preference parsing. The new
`tests/unit/simple-provider-onboarding.test.ts` covers production mounts/copy,
three viewports, reduced motion, keyboard focus, disabled browser setup,
remembered selection versus authentication, explicit native action sequences,
Claude handoff honesty, expiry, late responses, lifecycle cleanup, storage denial,
hostile status and exact preference restoration without accessor execution.

Edge proof serves byte-identical production HTML/CSS at 1440×900, 1024×768 and
390×844. The screenshot run has no native bridge, account or model catalogue.
Only its test entrypoint mounts the real provider and shell controllers against
empty state; it invokes zero native operations. Behavioral native-contract tests
use an explicitly synthetic bridge, never the user's installed CLI. The proof
JSON records Edge version, source SHA-256 values and screenshot paths.

Strict TypeScript compilation passed for **165 explicit product/test sources**
in private output. The two owned suites passed **8/8 with zero skips** in the
focused run. Existing onboarding, simplicity, preview and shell behavior checks
also passed, including model selection acknowledgements, draft/permission
preservation, modal race protection and preview dismissal.

The broader focused run is **not green**: its initial log has 76 cases, 68 passed
and 8 failed. One failure was private-output `zod` resolution; copying the already
installed dependency into private output enabled a separate Codex run with
**24/25 passed, zero skips**. Remaining failures belong to shared fixture or
controller integration: hidden-gate/visible-welcome expectations, removed Tools
menu/All tools search expectations, a Codex public-card source assertion, and a
Codex service fixture timing out after attempting raw-ID thread resume. No shared
assertion was weakened or edited.
The parent must reconcile these with the requested UI and other workers' changes
before declaring the integrated regression green.

Final byte-identical production screenshots and source hashes:

`C:/Users/alexk/AppData/Local/Temp/arcane-simple-provider-build-UYmNDB/arcane-simple-signin-HPyt2U/proof.json`

- `production-1440.png` — 1440×900
- `production-1024.png` — 1024×768
- `production-390.png` — 390×844
- Edge `155.0.4283.45`; zero native operations in every screenshot state.

HTML SHA-256: `9b914bf3066c845111611e50a8452d3436d0973db656e3fb8bbf2456c959ab56`.
CSS SHA-256: `c13f70eb64211c8d3765d68401cc58574db42bfaf7de794a035626d672e6acfa`.
`focused-regression.log` and `codex-regression.log` are retained in the private
build root above. Edge required an execution environment outside the Windows
app sandbox, where its subprocess failed before page launch; the successful
checks used fresh temporary profiles and controlled local HTTP fixtures.

No native sign-in, native status process, CLI install, live inference, EXE restart
or packaged EXE acceptance was performed by this frontend worker. Native provider
authentication remains owned by the vendor CLI. Native preference persistence
and chat/task integration require their owners' separate host acceptance proof.
