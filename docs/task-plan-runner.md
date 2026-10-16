# Bounded task plan runner

The host-only runner connects the [plan journal](task-plan-journal.md) to private worker, parent-continuation and evidence-request ports. It observes the original native terminal, requests three proposal roles in the first round and two in the second, and incorporates useful proposals through two original-parent turns. The existing task owner supplies the ports; there is no browser or MCP dispatch API.

The original objective is limited to 8 KiB for worker context. Its hash and the host's complete original-input hash are bound to the plan. Workers receive bounded context and return proposals only. Fan-in selects whole proposals in worker order within the journal's byte limit; it never truncates generated text. Callback envelopes reject proxies and accessors without evaluating them.

Both proposal and step reservations must succeed before a worker factory runs. A parent step needs its exact acknowledgement and then an observed terminal. Failed parents stop the plan. Unknown outcomes fence it without replacement attempts. The evidence step is reserved before requesting a bound review run, and a lost response is never retried by the runner. Duplicate starts only observe the existing plan, including after restart.

The runner does not approve evidence, accept a task or establish gameplay success. Its final review reference remains pending human evidence review. Original ownership and cancellation checks guard every asynchronous boundary; retained journal observations do not revive authority.

Temporary SQLite and owned callback fixtures cover the complete sequence, duplicate starts, restart, failed and unsettled workers, acknowledgement loss, failed parents, lost evidence responses, cancellation, changed bindings, capacity, whole-proposal byte limits and input refusal. The runner is currently a host component. Coordinator, native service and desktop wiring remain required before chat can use it automatically; installed inference and native Studio acceptance remain separate.
