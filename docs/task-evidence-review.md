# Task-bound evidence review

The host can bind one original chat task and plan to one durable WorkStore run. The binding records the original account identity hash, connection, incarnation, conversation, model, effort, grants, objective digest and validated run-input digest. These are provenance records, not native capabilities. Public work creation cannot manufacture a binding.

Run creation, task creation and the binding share one SQLite transaction. An identical request returns the original run; changed identity or input refuses. Exact binding lookup works beyond the recent-runs display window and does not expire leases or mutate task rows. Bindings are limited to 256 records, with an 8 KiB payload bound and no eviction.

WorkStore version 2 preserves historical runs without assigning them new provenance. Before migration writes, it validates the exact prior schema, bounded record shapes, run/task identity and dependency graphs. New bound runs also revalidate their input commitment on lookup. Foreign, newer and inconsistent records are refused without repair. Version 1 had no project metadata, so historical runs cannot establish an original project association.

Submission, human approval and acceptance observation share a bounded file verifier. Evidence must be a direct single-link regular file inside the project, at most 16 MiB. Opening, reading and final identity checks reject replaced, linked, growing or changed files. Acceptance observation checks the exact run again and verifies the entire evidence set without another asynchronous yield before returning accepted. These are cooperative filesystem checks, not an OS sandbox.

The private acceptance port reports pending submission, awaiting human review, changes requested, unavailable or accepted from actual records. Accepted requires at least one task, every task reviewed complete and all current evidence matching. A proposal, native terminal or generated summary cannot approve work. Retired owners cannot create or accept a new result.

The plan journal reserves its evidence request before calling this port. The two databases are separate: a lost response leaves an unknown spent request, while an explicit binding lookup can reveal the original run. That lookup never authorizes replay or restores a retired native owner.

Verification uses real temporary SQLite/files, HTTP/MCP consumers, owned Edge fixtures and the pinned official standalone Luau compiler. The component's full consumer inventory has 794 verified cases with no skips; one browser prerequisite path was corrected in an isolated follow-up, with the original log retained. Native service and desktop integration, installed inference and the complete Studio/customer journey retain separate acceptance requirements.
