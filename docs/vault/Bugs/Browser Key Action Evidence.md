---
type: evidence
project: Arcane
tags: [arcane, chat, ci, diagnostics]
---
# Browser key-action evidence

The Windows Edge job125044718435 in [original run41372156431](https://github.com/k6sol/Arcane/actions/runs/41372156431) failed the Claude activity/change-card/queue scenario while pressing Enter for the first queued message after the tool-activity events. The locator resolved the real composer; its input action then exceeded the existing8-second timeout. The job has102 passes and one failure with zero skips. This proves the original input action did not complete by its deadline, not whether the key handler ran or whether the queued effect was recorded. No failure-time DOM observation was collected for that action. The exact prior compiled-file hash matches a retained local copy, whose reported line2592 identifies this first queue action.

The complete unchanged file passes103 local cases, zero skips, against all2,725 prior strict-compiled/source/UI input hashes. This does not establish the CI failure's cause or erase it. The failing run was not rerun to obtain a passing label; its original log is retained privately.

## Failure-only observations

The existing bounded observer now also wraps the first Enter and both queue Enter actions. A failure records its exact phase/color scheme, elapsed time at observation, browser crash flag, page-error count, focus/disabled/menu state, composer character count, original send count and bounded queue-state counts. It never records draft text, emits another key, resends a prompt, changes a predicate/deadline, or converts an uncertain action into success. Observation is bounded to250ms and rethrows the original failure. If the page is unresponsive, the observation deadline itself is recorded.

Strict compilation still covers660 sources. After this edit, only the test source and its compiled JavaScript/map differ from the earlier2,725-input checkpoint; production TypeScript/UI files remain exact. The complete103-case local file passes with frozen inputs and zero failures/skips/cancellations. Fresh hosted validation is required. No actual customer/provider session or Studio operation is exercised by these loopback fixtures.

The authored cutout-preview source4ccd separately has all seven original component jobs passing in [run41371589498](https://github.com/k6sol/Arcane/actions/runs/41371589498) and both native jobs passing in [run41371589515](https://github.com/k6sol/Arcane/actions/runs/41371589515). Converted-preview sourcef982 has fresh original runs41373903277/41373903288 in progress. Preserve these sources and scopes when assessing the latest checks.

[[Delivery/G02 Reliable Chat]] ? [[Delivery/G08 Diagnostics]] ? [[Operations/Next Session]]
