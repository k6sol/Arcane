# Managed parent turns

An owned managed task can hold a bounded chain of parent turns alongside its one repair turn. This is a host capability in `@arcane/codex-client`; it is not a browser action or an MCP tool.

The host opens one chain with the original managed-task continuation and a maximum of one to three steps. It issues a single opaque permit for the next step after the preceding owned turn is acknowledged and terminal. Each permit is consumed before asynchronous isolation checks. A refused, rejected or uncertain dispatch ends the chain and cannot be replayed with a replacement permit.

Each step retains the original thread object, session, account revision and identity, model, effort and write policy. The client checks this continuity before preflight and again immediately before dispatch. It also requires the preceding turn to belong to that chain; an unrelated completed turn cannot supply continuity. Capability envelopes must contain exact own data fields, and proxies are refused without evaluating their traps.

Incorporation does not spend the repair continuation. Repair cannot overlap an incorporation dispatch; reserving repair ends the chain. Human follow-up, task replacement, permission revocation, interruption, account change and client closure revoke the chain and any pending preflight. Original isolation, approval and per-turn write behavior still apply.

Verification uses the production session with owned JSONL peers. It covers sequential steps and repair, policy continuity, forged and duplicate capabilities, proxy/accessor refusal, overlapping requests, retirement during preflight, uncertain acknowledgement, bounded steps and revocation. These checks do not establish installed-provider inference or Windows descendant containment.

The [task plan journal](task-plan-journal.md) provides durable bounded reservations and canonical proposal fan-in commitments. Automatic planning still requires coordinator and service integration and task-bound evidence review. A parent turn or proposal is not proof of task acceptance. The host must reserve steps durably before invoking this capability, record unknown outcomes without replay, and keep evidence acceptance separate from generated text.
