# Task proposals

An active Codex task can request another approach from the chat's proposal panel. The result appears as **Proposal — not applied** for review. It does not change files, answer approvals, grant access, update the work graph or consume the task's repair turn.

The worker belongs to the original task and uses its captured account, model and effort. It runs one read-only proposal turn. Task stop, replacement, account changes and connection retirement abort that ownership before revoking the parent. Cleanup is joined; an unconfirmed process close keeps its slot quarantined for the process lifetime. The process admits at most two workers at once and one per task.

Each request reserves a durable journal entry before a worker can start. Duplicate request IDs return their recorded observation. Reserved attempts become unknown after restart and are never replayed. Results are immutable, bounded and checked against their text digest. The journal retains at most eight attempts per task and 1024 overall, with no eviction.

The human-only read route returns one exact task's display records without starting work or journaling another action. The chat panel validates response identities and text digests, renders plain text, and clears scoped content when the project, chat, connection, task, account or model changes. Lost replies are inspected through the original request ID. They do not cause another request.

Verification covers real SQLite migration and failure fixtures, retirement and concurrency boundaries, service/HTTP/DOM checks, and an actual Edge panel check with synthetic transport and task scope. The browser check covers trusted keyboard activation, private text, narrow layout and late output after a scope switch. Installed-provider inference, Windows descendant containment and the complete customer journey remain separate acceptance requirements. Automatic parent incorporation and autonomous graph planning remain implementation work.
