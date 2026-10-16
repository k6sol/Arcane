# Task plan journal

The host can record one bounded plan for an original running chat task. The journal captures the original account identity hash, connection, incarnation, thread, session, model, effort and write and asset policy. These records carry provenance, not a capability to dispatch work or approve evidence.

Each plan allows two rounds, three workers per round, five worker attempts in total and two parent incorporation steps. Every logical slot is reserved before its effect and can never be replaced. A worker links one reserved proposal for the same task. Proposal reservation and step linkage are separate calls: the coordinator must complete both before creating a worker, and an orphan proposal remains spent. Unknown worker or parent outcomes fence the plan without replay.

Incorporation follows settled workers. Its fan-in records selected proposal IDs in worker index order, the sum of their UTF-8 text bytes, and the SHA-256 of ordered JSON containing each proposal ID, text hash and byte count. This metadata commitment is distinct from a rendered parent prompt hash. Only an observed successful parent terminal permits another round or an evidence request.

An evidence step records one review-run reference. It never marks the chat task accepted. Human review and current file evidence must establish acceptance independently. Late observations may be recorded after a plan stops, but cannot reopen reservations.

Schema version 3 adds bounded plan and step tables. Exact version 1 and 2 schemas, project identity, existing rows and ownership are validated before migration. Migration and ownership acquisition share a transaction. Startup recovery marks interrupted steps unknown and stops active plans; acknowledged evidence references remain available for review. Foreign, newer and inconsistent journals are refused without repair. Task, proposal and plan payloads are bounded before JSON parsing, and persisted proposal links, ordering and fan-in commitments are revalidated.

Verification uses temporary SQLite databases and owned fixture peers. It covers migration, byte-preserving refusals, concurrency faults, budgets, restart, cancellation, binding changes and proxy/accessor rejection. The [bounded runner](task-plan-runner.md) supplies host-side orchestration; coordinator and service integration remain required. Installed-provider inference and native Studio acceptance remain separate verification boundaries.
