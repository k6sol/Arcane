# Arcane eight-turn skill evaluation — 2026-10-13

Exactly **8/8 authorized native evaluation turns completed** on **gpt-6.1-sol / ultra**, using the existing CLI subscription. The single-use cap is sealed; there were no retries, replacements, or unknown turn outcomes. **The behavioral evaluation is blocked:** all eight responses reported unavailable fixture execution and no fixture callback reached the harness. Baseline and assisted each have 0/4 task passes. This run supports **no guide approval, no skill-benefit claim, and no product capability claim**.

## Measured results

| Variant | Consumed | Native completed | Task passes | Rubric points | Fixture callbacks | Turn wall seconds | Reported input tokens | Reported output tokens | Reported total tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 4 | 4 | 0/4 | 4/22 | 0 | 68.605 | 53522 | 1416 | 54938 |
| assisted | 4 | 4 | 0/4 | 4/22 | 0 | 78.554 | 58490 | 1568 | 60058 |

| Slot | Case | Repeat | Variant | Native status | Fixture callbacks | Rubric points | Turn wall seconds | Reported total tokens |
| ---: | --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | safe-edit | 1 | baseline | completed | 0 | 1/5 | 15.448 | 13686 |
| 2 | safe-edit | 1 | assisted | completed | 0 | 1/5 | 20.923 | 14869 |
| 3 | asset-reimport | 1 | baseline | completed | 0 | 1/6 | 17.149 | 13753 |
| 4 | asset-reimport | 1 | assisted | completed | 0 | 1/6 | 20.446 | 15178 |
| 5 | safe-edit | 2 | assisted | completed | 0 | 1/5 | 15.084 | 14763 |
| 6 | safe-edit | 2 | baseline | completed | 0 | 1/5 | 19.332 | 13794 |
| 7 | asset-reimport | 2 | assisted | completed | 0 | 1/6 | 22.101 | 15248 |
| 8 | asset-reimport | 2 | baseline | completed | 0 | 1/6 | 16.676 | 13705 |

Each response was genuine native output. The safe-edit responses returned unknown restoration; the asset responses returned blocked reimport. The one point per response is a passive no-stale/no-duplicate-attempt check, not demonstrated editing or reconciliation. No fixture state changed. Zero callbacks means the concurrent-edit, stale-identity recovery, mapping preservation and unknown-operation reconciliation criteria were not exercised. The equal scores cannot establish comparative skill quality or baseline proficiency.

Timing is harness wall time from durable dispatch intent through native completion, excluding discovery/setup/cleanup. Usage is the CLI's reported per-thread total, including its internal response steps. Reasoning output tokens are reported separately in audit.json (baseline 999; assisted 1176) and are not added again. Reported cached input tokens were 13056 and 28416. No billing, quota, savings, or causal latency claim is made.

## Blocker and practical limit

The frozen launch disables `features.code_mode_host` while providing a native dynamic fixture tool. Every final response reports an unavailable execution host. Successful schema registration and zero-turn settings/inventory checks did not prove that the model could execute that tool. The harness configuration caused an execution viability problem that was not caught before the first consumed turn. Settings were kept fixed for all eight slots; no consumed slot was replayed or replaced.

The outer app-server trace contains native turn/item events and final answers, but no dynamic-tool callback or fixture execution receipt. The model's reported failure is consistent with the disabled host configuration; the outer trace does not expose the internal denied execution. This report does not invent a task execution trace. Repairing execution viability and measuring the intended behaviors remains unfinished. The cap is exhausted; no further turns were requested or run.

Initial zero-turn startup attempts failed when native SQLite state was relocated into the sidecar. Native metadata succeeded using the reference's ordinary installed CLI state path. A memory-heavy executable hashing step also failed before any turn; it was replaced with streaming SHA-256. Failed relocated SQLite state was removed only from the validated owned directory, with file hashes retained in startup-state-cleanup.json. Native CLI housekeeping uses its existing private runtime; the harness did not read auth files, copy credentials, or modify native settings.

## Controls and grading

The design was 2 cases × 2 repeats × 2 variants. Each slot used a fresh ephemeral native thread and fresh in-memory fixture. The first repeat ran baseline then assisted; the second reversed the order. Same case prompts, initial fixture hashes, model/effort, declared dynamic tool schema, workspace, common instructions, child feature configuration and native catalog were retained. audit.json verifies four paired control matches. Provider caching and hidden service state were not controlled.

Baseline received no Arcane skill instructions. Assisted received the complete frozen source text of arcane-safe-edits and arcane-studio-context for safe-edit, or arcane-asset-integration, arcane-asset-optimization and arcane-blender-props for asset-reimport. No other native skills were enabled; thread instructionSources were empty. The fixture is explicitly disposable in-memory data, not fake live Studio or a substitute for an engine test.

The safe-edit fixture requires current session/object identity, exact source comparison, handling an injected manual-edit race, restoration of only the owned cooldown literal, preservation of manual edits, and honest final scope. The asset fixture requires actual mapping inspection, reconciliation of an exact unknown operation ID, no duplicate mutation, stable mapping/child ownership, bounded release/moderation/LOD/mobile claims, and named missing evidence. Fixture tools allow only enumerated fixture operations and have an eight-call limit. No tool provides arbitrary commands, file access, external data, Studio, Blender or uploads.

The deterministic grade function and thresholds were frozen before dispatch. It receives case ID, trace, final state, final text, completion status and forbidden-event observations; variant/repeat labels are excluded. audit.json independently regrades opaque, shuffled payloads and matches every stored grade. This is blinded deterministic grading, not an independent human review. Unknown native outcomes would consume a slot and fail the task; none occurred.

The fixed approval threshold required eight complete responses, four assisted task passes, and strictly better assisted points. It was not met. Both conditions of actual task execution and evidence of assisted benefit are absent. **Guide approval remains false; route is no-approval.** Existing guide validation labels and product claims were not changed.

## Native provenance, budget and cleanup

Installed version: `codex-cli 0.162.0-alpha.17.2`. Native account/read returned subscription auth type `chatgpt`; no auth-file content was read by the harness. Native model/list reported exact `gpt-6.1-sol` with supported effort `ultra`. Every thread/start receipt independently acknowledged that model, provider openai, effort ultra, read-only sandbox and networkAccess false. Fallback was disabled. There was no alternate model or API-key path.

The four registered native MCP inventories were reported disabled with zero tools. Shell/unified execution, apps/plugins, browser/computer use, image generation, multi-agent, hooks, memories, skill discovery/search and other unrelated capabilities were disabled in child configuration. No forbidden native item type or non-fixture approval callback was observed. An absent forbidden item is a bounded observation, not a complete native internal execution audit.

single-use-claim.json uses exclusive create and fsync before native setup. Each slot-N-consumed.json is exclusively created and fsynced before the sole turn/start dispatch site. A lost acknowledgement consumes its slot. Eight durable slot receipts match eight outbound turn/start requests and eight native acknowledgements; eight native turn/completed events report completion. Existing-claim exclusive creation was tested and rejected with EEXIST before native startup. sealed.json permanently closes this authorization. The earlier consumed one-turn approval was neither used nor counted.

All eight owned native process trees were stopped by exact spawned PID, with successful tree cleanup and observed process close. Zero-turn discovery/validation process cleanup receipts are retained separately. No live Studio operations, uploads, installations, project production/test edits, Git operations or settings writes were performed by the harness. Auth remains owned by the existing native client. Source/report artifacts are confined to the user-designated sidecar directory and this report.

## Hashes and retained evidence

| Evidence | SHA-256 |
| --- | --- |
| Exact model selection + native catalog entry | `2e4966e103f5d2869a399cad6d1a0bc9a19d990e4f2c458fd119e0b6c9600e3f` |
| Native model catalog | `188f156ab3fcba383af0fcef28d9c0eab09b438beceb612340975dc7a14b07a9` |
| Declared fixture tool | `a0a358578ff9f9244c9106f4381b8811ce0aaad3b82dbea6a72e6d698e51560f` |
| Frozen fixture/rubric module | `73c492245be80258e416fc6f95fb20e1167d84bdd44fd0b57f2b588304b58ada` |
| Frozen source inventory | `968df8b57468eea8c2a3fbab0d86de95b7b8c3ded2d8216709167418e8014d7e` |
| Installed native executable | `d13914ced6c7af174d8d638db938284231227312104b06a25e9608c632a7daec` |
| Child launch arguments | `64214237b6d24a95aa270bb9f75a07de80110fe456f4593c1aa446913861dd1e` |

| Assisted skill source | SHA-256 |
| --- | --- |
| skills/arcane/arcane-safe-edits/SKILL.md | `a35f124e1f11a31cbc056a7f9f9a6d7f7df8208ecbc25ed83d12d600c391cc11` |
| skills/arcane/arcane-studio-context/SKILL.md | `fd0a80252e5e71ee30ae007ad6cbfd862438c46d76297d03653f04fffc42533b` |
| skills/arcane/arcane-asset-integration/SKILL.md | `956eccf968f7abc47b8f842964fd8224e21050f5b8a78b0953ba969c296bbcba` |
| skills/arcane/arcane-asset-optimization/SKILL.md | `35ab8c555c2964b497578e6bf4c376ec8b5cbf6d23430862f0b0c40bc2b0ae55` |
| skills/arcane/arcane-blender-props/SKILL.md | `22e8b1b4b1e120a6d95fc89b63b750cbe6169c4271871b4810993215ac67ef3c` |

Evidence directory: runtime/verification/skill-evaluation-eight-turns-20261013/.

- run.mjs is the durable executable, permanently locked by this run's single-use claim and seal.
- frozen/, sources.json and plan.json retain exact harness/reference/skill/protocol sources, pre-dispatch criteria and schedule.
- preflight.json and ready.json retain real native catalog/account projections and zero-turn isolation receipts.
- receipts/ retains consumed-slot intents; it contains no fixture-tool receipts because no callbacks occurred.
- outputs/slot-N.json retains redacted native final output, item/turn metadata, usage, empty fixture traces and final fixture states.
- results.json, audit.json and verdict.json separate native completion from blocked task execution and keep baseline/assisted measurements separate.
- self-check.json records only local fixture/cap checks; it is not provider task-success evidence.
- Raw native reasoning and raw account/credential payloads were not published. stdout/stderr streams were hashed; public native final text uses the reference bundle's history redactor.

This is a completed eight-turn budgeted run with an unsuccessful fixture execution route. It is not a successful skill evaluation or a live integration/asset/release verification.
