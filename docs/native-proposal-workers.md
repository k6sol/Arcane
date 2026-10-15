# Native proposal workers

Arcane's native client includes a host-only launch component for one read-only code or review proposal. `connectCodexProposalWorker` requires an installed Codex executable, the selected project, and the exact account identity, model and effort captured by the original task. It provides only `snapshot`, `propose` and `close`; it exposes no write-grant, approval, resume or continuation API.

## Launch and admission

1. Initialize a secret-free discovery child. Require the original task's reported subscription identity before reading the server inventory. Discovery sends no model turn.
2. Close discovery and create a separate final child with every discovered inherited MCP server disabled, including plugin servers. Arcane remains explicitly disabled. Neither child receives an Arcane bearer, daemon endpoint, provider-key override or caller-supplied environment.
3. Require the same subscription identity, exact catalogued model/effort, a fresh idle thread, acknowledged read-only sandbox with network disabled, and the `never` approval policy. Verify the effective thread inventory contains only explicitly disabled servers with no tools or errors.
4. Repeat effective inventory verification immediately before the sole proposal turn. Cancel command/file approval callbacks and refuse unsupported callbacks. Reject writes and all subsequent dispatches once a turn operation has been allocated, including uncertain or rejected starts.

The child launch also disables native agent tools, shell tools, apps, plugins, memories, permission requests, web search and automatic skill MCP installation through documented configuration settings. These requested feature settings are distinct from the acknowledged sandbox and observed MCP inventory. Installed-client compatibility still needs native acceptance; fixture checks do not establish it.

Account-change notifications fence an active proposal even if authentication remains a subscription. Failure closes the owned child; there is no fallback account, model or automatic turn replay. The host must close a worker when its parent task stops or changes ownership.

## Integration boundary

This component does not yet connect the chat task coordinator or WorkStore graph to automatic workers. The host integration must capture parent authority privately, reserve dispatch durably, bound concurrency and execution time, join cancellation, and return bounded proposals to the originating task. A serialized task ID or account hash alone is not permission to launch a worker. No browser or MCP launch route is exposed by this change.

Worker text is a proposal. The original task retains edits, measured verification, evidence submission and review. A completed native turn does not establish that code was applied or that acceptance criteria passed.

## Verification

Local Node protocol fixtures exercise the actual production factory, profile, session and transport. Only the process-spawn boundary redirects to synthetic peers; copied product modules are byte-identical. Checks cover both child environments and closure, exact turn settings, disabled inherited/plugin servers, fresh preflight, account changes, unexpected approvals and single dispatch. Existing native-client regressions remain part of the verification cohort. No provider inference or Studio operations are performed.

Configuration references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [native agent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents), and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
