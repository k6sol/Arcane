# Arcane skill evaluation protocol

Status: **definitions, not completed behavior runs**. `evaluations.json` contains 69 primary tasks (every skill at least once; extra gameplay-code tasks for systems, DataStore and remote security), 10 guard tasks and 20 routing cases. Routing cases are pinned by `tests/unit/mcp-skill-router.test.ts`. Fixture descriptions are requirements, not installed places, Blender files, executable assertions or an evaluation runner. The Node tests check the pack/tooling and catalogue structure only.

## 1. Separate the gates

1. **Packaging:** metadata, unique IDs, actual hashes, bounded reads and reference selection. Offline Node tests can prove these narrow properties.
2. **Routing:** relevant candidate selection and an appropriate small skill set; include near-miss requests where a skill should not drive implementation.
3. **Behavior:** a real worker completes a task against a pinned fixture; independent review checks artifacts and observations.
4. **Craft and play:** engine-scale visuals, controls and player decisions. Human/player observations supplement technical assertions.
5. **Release approval:** reviewed evidence tied to exact content/tool versions and supported capabilities. A passing catalogue check cannot approve a skill.

## 2. Prepare a safe fixture

Build a disposable project from each case's `fixtureRequirements`. Record its source hash, place/session identity, dependency versions, rig/asset data, devices and supported tool capabilities. Make failure injection reproducible. Keep production stores, paid uploads and live places outside the test.

An evaluator may first use fake transport/storage responses to test orchestration logic; mark these as simulations. Plugin interaction, editor conflicts, physics, engine appearance and multiplayer claims need the actual relevant runtime. Absent capabilities yield **inconclusive/unsupported**, not a pass. Do not weaken a case merely to fit available tools.

Model inference and resource mutations require a configured authorization/budget. No case definition authorizes publishing, credential access or paid work. Use dummy secrets for leakage tests. Do not create abusive live traffic to test remote rate handling.

## 3. Run a controlled comparison

- Freeze worker request, starting fixture, model/version/effort, client, tool versions, permissions, device/workload and maximum spend/time/repair attempts.
- Give the worker only `workerPayloadFields`. Keep skill IDs, grading assertions and expected answers reviewer-side. Selected skills are normal worker context, not a leaked oracle.
- Baseline gets the same project instructions/tools but not the skill under test. Assisted run gets the exact selected skill/reference hashes. Reset independently between runs.
- Order/repeat runs to reduce learning and random-seed effects. For stochastic tasks, a proposed minimum is three paired runs, then extend on unstable outcomes; this is an Arcane test policy, not statistical proof.
- Save complete actual tool/effect traces and artifact references. Do not report a render as an import or a source file as a working mechanic. Record unsuccessful and interrupted attempts too.
- Independent reviewer executes observable assertions against the deliverable. Do not score by counting headings, echoing skill phrases or preferring longer output.

For routing comparisons, do not give the worker the answer's skill IDs. Measure relevant inclusion, unnecessary context and missed domain hazards. A deterministic lexical ranking is only a candidate list, not proof of semantic understanding.

## 4. Domain evidence

| Work | Required observations |
|---|---|
| Live edits | Current editor baseline, exact target, actual changes, manual conflicts, restoration after later edits |
| Network/security | At least legitimate and hostile payloads, server-owned state, delayed/replayed events, bounded workload |
| Persistence/trading | Fault at transitions, restart/rejoin, ownership invariants, durable outcome versus unknown status |
| Controls/combat/physics | Actual input/state traces, authoritative outcomes, observer/latency cases, cleanup |
| GUI/accessibility | Supported device captures and interactions, focus/readability, alternatives for critical cues |
| Blender/assets | Source geometry/rig checks, exports, actual engine scale/material/grip/collision; not render alone |
| Performance | Same workload/device before/after, profiler and resource trends, unchanged intended behavior |
| Design/feel/genre | Complete goal/action/feedback/failure/retry slice; observed player choices/confusion and stated limits |
| Subscription/context | Actual access route, no unrequested billing change, preserved model choice, reported usage or unknown, recoverable limit checkpoint |

Record acceptance completion, critical failures, regressions, human corrections, elapsed time, context bytes and provider-reported usage where available. Do not translate bytes into exact tokens or infer hidden subscription allowance. Smaller context with worse acceptance is not an improvement.

## 5. Review and promotion

Each skill needs its primary task plus relevant guard, failure and near-miss cases. A proposed approval gate is: no unresolved critical safety/data/correctness failure; intended acceptance met; repeated behavior evidence showing usefulness without material regression; independent review of instructions/helpers/licences. Craft claims additionally need the appropriate engine/player review.

Promotion is a reviewed registry change, not an automatic consequence of tests. Current `evaluationRuns` arrays stay empty until runs exist. The offline validator only checks that an approved record has some passing evidence; it does **not** authenticate that evidence. Runtime tooling must verify complete evidence and reviewer identity before treating it as trusted.

Content/helper/reference changes return affected versions to review. Retain approved old versions only where their compatibility still holds. Keep failure cases as regression fixtures and re-evaluate when engine/client/tool behavior changes. Do not silently rehash altered approved content.

## 6. Run record requirements

Future run records need: case/attempt ID; UTC time; baseline/assisted treatment; exact skill/reference hashes; fixture/source/engine/client/tool/model versions; permission and budget scope; scenario inputs/seeds; actual changed artifacts; assertion observations; reviewer; completion state; usage source; human feedback; unresolved limitations.

Use pass/fail/inconclusive per assertion, with evidence. A supported subset can be approved only for its tested capability/compatibility range, not marketed as mastery of every Roblox genre or a guaranteed successful game. No behavior-run results have been recorded yet.
