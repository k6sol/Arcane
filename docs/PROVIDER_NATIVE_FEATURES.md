# Arcane — provider-native models and features
Version 0.1.0 · 11 October 2026

**Implemented:** a runnable local connection lab, native metadata adapters, exact preference validation/storage and tests. **Not implemented:** inference, feature execution, native desktop packaging or the Studio/plugin bridge. The lab is a development slice, not a subscription proxy or a finished platform.

## 1. Product principle

Arcane should enhance the user's chosen provider, not reduce every provider to a generic text box. Keep the native client as a first-class workflow; implement richer integrations only where the provider actually supports them. A feature can stay useful through a clearly labelled native handoff while its embedded adapter is unavailable.

Separate five facts: executable installed; signed-in status; reported model choices; actual model entitlement; feature execution verified. None proves the next. Also distinguish image input from image output, a visual design canvas from raster generation, and a documented native workflow from one Arcane can execute.

The desired product supports model choice, effort choice, native tools/skills, image workflows, design systems, browser tools, artifacts, connectors, agents and available usage signals. No honest integration can guarantee every platform feature on every account/version. Unsupported and unknown capabilities remain visible with an explanation rather than fake success buttons.

## 2. What this installation actually reported

Read-only observation, not an inference benchmark:

| Client | Installed version | Sanitized native status | Observed choices |
|---|---|---|---|
| Codex | `0.162.0-alpha.17.2` | ChatGPT subscription; native plan label `prolite` | Seven runtime catalogue models, including `gpt-6.1-sol` with `ultra` |
| Claude Code | `2.1.177` | First-party Claude subscription; native plan label `max` | Three help-reported aliases: `fable`, `opus`, `sonnet`; CLI effort flags up to `max` |

These are installation observations, not a permanent public model catalogue or proof of allowance. A Claude help flag is not evidence that every alias/account supports that effort. Do not invent Claude Ultra support to make the providers look equivalent.

The lab successfully saved `codex / gpt-6.1-sol / ultra` through its real panel. It is a **requested preference** with `applied: false`; no model task has run. It does not change the active Codex chat's global settings.

## 3. Connection and billing routes

### Native-client route — first priority

The user signs in using the installed provider's own login flow. Arcane reads bounded, sanitized metadata through that client and exposes local tools through a separately implemented MCP bridge. The native client owns the reasoning session and provider credentials. Arcane never copies credential files, asks for a password, or pretends to be the provider's client.

For Codex, the documented app-server supports initialization, account metadata and a model/effort catalogue; this lab implements only those reads. Session/turn execution is a separate, unimplemented adapter with different permissions. [Codex app-server](https://learn.chatgpt.com/docs/app-server).

Claude's consumer guidance distinguishes native subscription usage from third-party software access. Third-party applications should use the API or authorized cloud routes; provider-approved exceptions can draw usage credits rather than included allowance. Arcane must not route its own embedded traffic through copied native OAuth tokens. Keep Claude Code in control of native sessions with Arcane as a tool provider until an authorized embedded route is established. [Claude authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).

### Direct app connection, personal API and managed API

These remain separate proposed modes, described in [Subscription workflow](SUBSCRIPTION_WORKFLOW.md). They need eligibility checks, explicit consent, protected app-owned credentials and their own capabilities. Native CLI metadata access is not the same as enrolling Arcane in a direct plan-access program.

Show access route on every task. A missing feature or exhausted allowance cannot trigger an automatic API-key fallback, account switch, extra-credit purchase or weaker model. Environment/provider overrides must be surfaced and rechecked before execution; a saved login alone cannot determine billing.

## 4. Model/effort UX and runtime acceptance

Current panel:
1. Explicit provider selection.
2. Codex choices from the live paginated catalogue; Claude aliases from this installed CLI's help, with weaker evidence clearly labelled.
3. Efforts from reported metadata, not a shared invented menu.
4. No automatic default selection or silent replacement of a missing model/effort.
5. Saved pair is bound to a connection revision; saving stale or unsupported choices fails.
6. Subscription-first preference save refuses API/cloud or unavailable authentication modes.
7. Requested settings are never shown as successfully applied.

Future task runner must:
- Resolve and display the actual model behind aliases, where the provider reports it.
- Recheck account, access mode, version, catalogue revision and feature requirements immediately before starting.
- Show **requested** and **applied/reported** model and effort separately. A CLI accepting a flag does not establish that it honored the request. If the provider clamps effort, expose the mismatch and follow the user's explicit strictness policy; never claim Ultra ran when it did not.
- Pin the choice for the task and preserve it on resume. Catalog changes, loss of entitlement or a different provider require an explicit decision.
- Mark access errors as unfinished/blocked, not successful task completion. Do not retry chargeable requests blindly after an unknown outcome.
- Record actual observable usage without estimating hidden subscription quota from text length.

Per-model effort behavior needs version-specific verification. [Claude model configuration](https://code.claude.com/docs/en/model-config).

## 5. Native-feature integration matrix

The current lab displays status/explanations only. The following execution paths are **proposed**, not implemented buttons:

| Feature | Intended path | Quality gate before Arcane claims support |
|---|---|---|
| Code / debugging | Native client + Arcane MCP; separately approved embedded harness | Tool permissions, real edit/test receipt, exact applied model, interruption recovery |
| Codex image generation / edits | Native image workflow first; artifact adapter later | Feature present on this client/account; actual output file, reference fidelity, dimensions/transparency, provenance; no fabricated image |
| Claude Design | Native design workflow; user-approved design/code handoff | Workflow available here, editable design system, real export, reference fidelity; translated Roblox UI is tested separately |
| Browser / computer tools | Installed client tooling under scoped permissions | Actual tool inventory, confirmation behavior, captures, untrusted page handling; no invented browser access |
| Plugins / connectors | Provider-owned installation/authorization with a reviewed integration | Real authorized capability and version, selected data scope, redacted logs; no blanket connector authorization |
| Skills / MCP | Selective Arcane skill/context retrieval and local verified tools | Provenance/hash/status checks, current project identity, no bulk context dumping; behavior approval remains separate |
| Parallel agents | Client-owned agents initially; Arcane job orchestration later | Shared allowance, isolated scopes, review evidence, one fenced live Studio writer |
| Images as references | Provider-supported input and artifact references | Correct attached file, supported modality, bounded size and a clear missing-input error |
| Voice / video | Native feature or separate authorized adapter if genuinely available | Real supported transport, consent, actual media; CLI login never proves availability |
| Research / search | Actual native tools or an explicit separate integration | Current primary evidence with attribution, no imaginary search results |
| Usage / limits | Provider-reported information when available | Source/time/window recorded; unknown stays unknown, not 0% consumed or unlimited |

Codex documents native image creation/editing rather than a generic guarantee that any app-server session includes an image tool. Its CLI workflow uses an interactive session and can take a reference image. Verify the installed tool before running it. [Native image workflow](https://learn.chatgpt.com/docs/image-generation).

Claude's guide documents native `/design` and design/code handoff workflows. Availability in this local installation and automated export have not been tested. [Claude Design guide](https://support.claude.com/en/articles/14604416-get-started-with-claude-design).

Do not strip provider-specific functionality to fit a lowest-common-denominator abstraction. Normalize common events but retain a versioned native payload/artifact reference, safely redacted. Only expose actions that the current adapter can actually execute.

## 6. Proposed capability contract and dispatch

The current protocol types intentionally stay small. Extend them after runtime proof rather than presenting a large fake tool schema as implemented. A future feature snapshot should include:

```text
provider / native client version / adapter version / observed time / revision
feature identifier / state / supported route
account-model-tool requirements / permission class / billing route
evidence kind: docs-only, native metadata, fixture test, real integration test
input-output contract / artifact types / last verified result / failure reason
```

Dispatch sequence:
1. Parse the user's task into required features and artifact types.
2. Read only relevant project state and selected skill/reference bodies.
3. Check exact target, route, native capabilities, chosen model and permissions.
4. If native handoff is needed, provide the actual native workflow and a scoped brief; do not imply execution happened.
5. If execution is supported, reserve task ownership/budget, then start using typed arguments without shell interpolation.
6. Process real streamed events and provider approvals. Preserve native semantics and partial/unknown outcomes.
7. Validate actual artifacts and engine results. Only mark completion when the requested acceptance checks pass.

Media belongs in a manifest: owned file or provider artifact ID, hash, dimensions/duration, origin/rights, generation route, requested/applied settings, and import result. An attractive image is not a Roblox-ready mesh or proof of a working game. A design canvas is not automatically a Roblox GUI.

## 7. Implemented security boundaries

- Loopback listener on a random port; no LAN/public relay.
- Random local session bearer token; exact Host checks and POST Origin checks. CORS is not authentication.
- Fixed static asset routes, restrictive CSP, no raw provider HTML or dynamic `innerHTML`.
- Local lab token in tab-scoped storage for refresh; it is not a provider credential. Closing the tab/restarting the server ends normal use. Anyone with that lab token can read sanitized metadata/save preferences, not run inference or Studio operations. Do not share the launcher URL.
- Native processes use an absolute executable and argv, `shell: false`, hidden windows, time/output/frame bounds and explicit request allowlists.
- Only native initialization, account read without token refresh and model-list reads are allowed through the Codex probe. Provider-initiated execution approvals are refused.
- Claude probe runs only version, authentication status and help. No `-p` inference or OAuth-token extraction.
- No email, raw auth result, credential value or raw stderr persisted in the public state/evidence.
- Atomic serialized preference writes; corrupt state is preserved and blocks saving until manually repaired. This is not a full database, an interprocess lock or an OS sandbox against a malicious local user.

Tests use mock processes for protocol failures and real local HTTP for server boundaries. Separately, genuine installed-client metadata was observed. Neither is a Roblox integration/playability test.

## 8. Run and verify

From the repository root with Node 24+:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run probe:providers
npm run start:lab
```

Open the session link printed by the local launcher; keep it private. Refresh performs bounded read-only discovery. Save stores only a preference under ignored `runtime/connection-lab/`. Missing CLI/cache permissions must be reported, not interpreted as a signed-in connection. Use the provider's own `codex login` or `claude auth login` for a new login; the lab does not launch those flows.

Current evidence is in [provider connection checks](research/provider-connection-checks.json). The prior skill-only check report remains historical evidence of its earlier run, not the latest registry hash.

## 9. Next implementation gates

1. Build the real Studio plugin/read-only MCP path and exact two-window identity. Keep the connection lab as a diagnostic surface, not a substitute for the bridge.
2. Connect a native client to those tools with reviewable, scoped configuration; perform a real disposable-place inspection.
3. Add one authorized Codex task path with completion/cancellation and exact-setting evidence; enforce read-only tools before enabling edits.
4. Prove image artifact return and a native Claude Design handoff separately. Do not bundle all provider integrations into one unverifiable milestone.
5. Only then add embedded UI packaging, durable task execution, conflict-safe writes, Blender/media imports and behavior-tested skills.

Highest quality means recoverable results, purposeful Roblox design and real evidence—not maximal tool permission, more agents by default or promises of perfection.
