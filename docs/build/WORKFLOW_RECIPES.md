# Deterministic production workflow recipes

`packages/core/src/workflow-recipes.ts` constructs bounded work DAGs for `code-change`, `production-asset`, and `playtest-repair`. Every recipe follows prompt → requirements → plan → implementation → verification → review, with explicit plan, preview and final human acceptance. This is a pure planning and readiness module: its only computation outside ordinary data processing is deterministic SHA-256 hashing. It performs no database, filesystem, provider, process, network or Studio operations.

It reads the existing `WorkRun`, `WorkTask`, `Evidence`, `Selection`, `Connection` and `StudioSession` contracts. Storage imports are type-only, so importing a recipe does not open SQLite. Direct imports of the module work under the existing strict NodeNext tsconfig; no export index or integration files are needed.

## Choose a deliverable

```ts
import {
  createWorkflowRecipe, toWorkStoreInput, assessWorkflow,
} from '../../packages/core/src/workflow-recipes.js';

const recipe = createWorkflowRecipe({
  deliverable: 'production-asset', engine: 'roblox',
  title: 'Production workshop prop',
  prompt: 'Build an editable Blender prop against the supplied reference. '
    + 'Deliver a local engine export and approved scale/silhouette previews.',
  scope: ['art/workshop-prop'],
  // Copy only the exact selection fields from the developer's current selection.
  model: {
    provider: selection.provider, model: selection.model,
    effort: selection.effort, connectionRevision: selection.connectionRevision,
  },
  assetBudget: { triangles: 12000, materials: 8, textureBytes: 16777216 },
  verificationAttempts: 2,
});

const draft = toWorkStoreInput(recipe); // Valid input shape for WorkStore.create.
const readiness = assessWorkflow(recipe); // Missing capabilities/approvals stay pending.
```

`model: null` is supported: model steps require an explicit future selection and remain pending. No default model, effort, provider or catalogue revision is invented. Equivalent normalized inputs produce the same content-derived recipe ID, keys, graph and audit ordering. Changing the prompt, scope, budgets, selection or target creates a different identity and requires fresh human decisions.

| Deliverable | Concrete implementation and proof |
| --- | --- |
| `code-change`, Roblox or Blender | Reviewable local patch; actual hash-pinned reports for syntax/types, focused regression, scope diff and security invariants; human accepts the diff preview and final review. Optional Roblox Studio target adds an explicit patch handoff and recorded playtest proof. |
| `production-asset`, Roblox or Blender | Editable Blender source and local engine export. Technical checks require source reopen, export reparse, scale/pivot/axes, UV/normals, collision/LOD and measured triangle/material/texture budgets. Separate hero, profile, target-scale and reference-comparison artifacts must pass human visual acceptance. A model review additionally requires reported image input capability. |
| `playtest-repair`, Roblox | Original failing logs and reproduction; diagnosis; minimal patch; deterministic local verification; exact Studio patch receipt; human-run repeated scenario with console logs and viewport evidence; recorded proof verification; human preview and final acceptance. |

Production asset budgets default to 12,000 triangles, 8 materials and 16 MiB texture data. These are adjustable technical bounds, not an art score. Passing metrics cannot establish reference match, production art quality or successful Roblox import. Asset exports remain local; importing or uploading them is not implemented here.

Playtests default to three repetitions, configurable to 1–10. Repetitions describe the human-run scenario, not automatic tool retries. A repair without a Studio target still includes the necessary steps, blocked on exact place/session identity. Blender playtest repair is rejected because this recipe requires Roblox runtime evidence.

## Future runner contract

Keep the structured recipe alongside its WorkStore run. `toWorkStoreInput` returns only existing create fields: title, objective and explicit task key/title/instructions/acceptance/scope/dependencies. It creates no IDs, timestamps, worker leases, completed states or approvals. Its instructions include the exact provider and Studio requirements and retry policy.

**WorkStore alone does not enforce these recipe gates.** Its readiness checks only dependency completion; its reviewer API does not establish human identity. A runner must call `assessWorkflow` before claim, handoff, submission and review, and must continue to use the existing storage and Studio policy checks. The projection is not a permission grant or a runnable adapter.

The host supplies current sanitized catalogues, adapter capabilities, paired sessions, actual WorkStore state, trusted submissions and human decisions. Snapshot `complete` is accepted only when dependencies, exact capabilities, required human decisions and artifact checks all pass. Otherwise even that snapshot projects to `pending`. `needs_review` remains review work; evidence never automatically becomes completion. Owned leases remain pending, failed tasks remain failed, and interrupted tasks require human reconciliation.

An eligible step has disposition `verify` only for allowlisted safe local verifiers. Other eligible work has disposition `human-handoff`. A capability or gate blocker always leaves it pending, including `unsupported` verification results. There is no skip-to-success behavior and no fallback provider. The future host should schedule one bounded action at a time and account for attempts in its persistent run state.

Treat recipes and callbacks as host-owned objects. Recompute readiness from current observations immediately before dispatch. Content hashes detect changed recipes and stale evidence; they are not authentication signatures. Do not accept arbitrary agent-supplied graphs, callbacks, capability attestations, verifier reports or WorkStore snapshots as trusted state.

## Exact capabilities and approvals

Each model step requires the selected provider, installed connection, current catalogue revision, exact model/effort pair, reported input modalities, and the `coding` feature on the `native-client` route in `available` or `native-handoff` state. A model catalogue's unverified entitlement is never upgraded into proof that inference ran. Every model step has a separate human native-handoff gate. API/cloud, signed-out and unknown auth stay pending; this policy does not launch paid models.

Adapter capability IDs are exact:

| Capability | Required safety |
| --- | --- |
| `local.patch`, `blender.author`, `blender.preview` | `human-handoff` |
| `local.code.verify`, `blender.verify`, `local.playtest.verify` | `read-only-deterministic` |
| `studio.script.update`, `studio.playtest` | `human-handoff` |

The host must attest safe verifier behavior, including side-effect-free execution, disabled script auto-execution when reopening Blender files, and no model or Studio calls. A boolean capability field cannot itself make an arbitrary command safe. Missing, duplicate, unsupported or incorrectly classified adapters stay pending. No shell commands or generic tool-execution payloads are emitted.

A requested Studio target contains exact session/place/universe IDs, supported roots and `method: 'script.update'`. The current paired session must match identity and protocol, remain unrevoked, allow the requested roots, advertise the exact method and allow writes for a patch. The future host must obtain a fresh live observation and use the bridge's expected-source baseline checks and receipts. Authorization binds the exact patch hashes; ambiguous outcomes require reconciliation.

The current protocol in `packages/protocol/src/studio.ts` has no playtest method. Merely pairing Studio or advertising script writes cannot satisfy `studio.playtest`. It stays pending until a separately implemented, explicitly authorized native adapter and session actually expose that exact capability. This module never changes Studio.

Human gates cover model handoff, plan acceptance, local writes, Studio patch/playtest, preview acceptance and final review. To form a decision:

1. Gather the current output hashes from the step's `subjectSteps` (dependency ancestors).
2. Compute `workflowGateBinding(recipe, stepKey, gate, subjectHashes)`.
3. Have the authenticated human host issue an approved/rejected decision and SHA-256 receipt reference bound to that command.
4. Pass that decision and a trusted `authorizeHuman(command)` verifier to `assessWorkflow`.

The verifier receives the recipe ID, step key, gate, binding, decision and receipt hash. Only literal `true` authorizes its supplied decision. Missing callbacks, thrown errors, truthy strings, stale bindings and authenticated rejections fail closed. Approval can precede execution: its binding covers the planned action, exact selection/scope and current input artifacts. Outputs still require evidence and subsequent WorkStore review. Human preview/final gates bind the deliverable and proof inputs they actually review. There is no approval from a prompt, agent `role`, model critique or passing test.

Callbacks are a trusted host seam, not JSON fields from an agent route. Keep human proof verification outside agent-accessible code and issue real authenticated receipts. The deterministic human callbacks in unit tests are synthetic fixtures only.

## Evidence and bounded retries

Each submission identifies its step and has safe relative artifact paths, nonzero bounded byte counts, lowercase SHA-256 digests, artifact roles, subject hashes and check results. Paths and hashes must be distinct. Source/preview/report roles are mandatory as specified by the recipe. Every required check must report `pass`, reference an attached report artifact and carry `workflowSubjectDigest` for the exact current subjects. Numeric measurements must be finite, nonnegative and satisfy the declared threshold. A missing report, stale source, failed/pending/unsupported check or over-budget metric leaves work pending.

The pure evaluator does not read bytes or independently trust measurements. The host must hash actual files, match file bytes and sizes, verify report origin, map roles to the actual outputs, and recheck the manifest before accepting it. Existing WorkStore submission/review protects project containment and unchanged evidence; physical path, symlink and concurrent-change checks remain the host/store's responsibility. Synthetic unit manifests are not production evidence.

`canRetryWorkflowStep` permits only `evidence-read-busy` after at least one attempt, below the step's maximum and with an unchanged subject digest. It never sleeps, invokes tools or persists attempts. A failed assertion, changed evidence, unsupported capability, interrupted lease, model timeout or Studio timeout cannot trigger retry. Requirements, planning, model review, code/asset writes, rendering, Studio writes and playtests always have one attempt. Rejected work needs a fresh explicit bounded recipe, not an automatic model repair loop.

| Bound | Hard maximum |
| --- | --- |
| DAG steps | 24 (below WorkStore's 64) |
| Relative scopes per task | 20 |
| Attempts per safe verifier, including first | 3; default 2 |
| Total planned attempts | 48 |
| Artifacts per submission | 20 |
| Bytes per artifact | 16 MiB, matching WorkStore |
| Prompt | 8,000 UTF-8 bytes |
| Quality checks per step | 20 |
| Feedback references / evidence hashes each | 8 / 8 |

The fixed policy prohibits silent approvals, weight training, paid-model launch, automatic Studio edits, publishing, uploading and deletion. Those actions have no recipe execution path. A human decision cannot override these prohibitions.

## Learning feedback and privacy

Learning means **context learning not weights**, with authority `untrusted_supplemental_hints`. The assessment can reference separately human-approved project hints; it never imports history, writes learning records, includes hint text in a recipe, trains weights or promotes learned data into policy.

Supply only `projectId`, `recordId`, `reviewReceiptHash` and `evidenceHashes`, all SHA-256 references. `authorizeLearningReference` must verify current project consent, an approved/enabled record and its actual human review receipt/evidence against the existing LearningStore. Missing authorization, off consent, another project, rejected/disabled/proposed records or verifier errors must exclude the reference. The module cannot independently identify a physical human or inspect LearningStore; the callback is the explicit trust boundary. The host can use `LearningStore.settings`, `getRecord` and its trusted receipt ledger to check these facts.

Returned references include no learning text, proof, credential, source URL or raw native history. Audit entries are deterministic bounded structural sequences containing kind, optional fixed step key and a hash of the recipe, blocker, verified human receipt or approved learning reference. There is no automatic outcome recording, consent grant, collection or recipe promotion.

Text is normalized and credential-like content is rejected as a whole, without echoing submitted values. Guards cover common provider/cloud keys, private keys, bearer/basic auth, JWTs, credential assignments and authenticated URLs. Unknown payload fields and credential/config scope directories are refused. Catalogues and sessions are inspected without copying raw labels, warnings or account metadata into recipes/audits. Pattern guards can produce false positives and cannot recognize every possible secret; callers must supply minimal reviewed content rather than raw auth/config/history dumps.

## Scoped offline verification

`tests/unit/workflow-recipes.test.ts` uses Node's test runner and synthetic in-memory catalogues, sessions, manifests and human receipts. It covers DAG order/determinism, cycles/missing keys, unsupported work, exact provider/Studio gates, default-deny human approvals, stale artifacts, technical thresholds versus visual acceptance, repair proof, lease/review state, secrets, resource bounds, safe retries, human-approved learning references and immutable inputs. No external service, inference, Studio action, production file access or full suite is involved.

Typecheck only these roots with the compiler flags from the current tsconfig and `--noEmit`. Normal product builds include both through existing glob patterns. No tasks, UI, providers, Studio files or export indices were modified for this foundation.
