# Interrupted asset work

An interrupted asset card offers **Check worker status**. The same action is available for the selected job in recorded asset history. It checks that one job's retained worker records and keeps its partial files. It does not restart generation or make unfinished artifacts available.

Arcane permits new asset work only after every recorded worker is proven gone or was observed closed by its supervisor. It checks exact Windows process identities, with at most two concurrent queries across six records. A running worker, unresolved launch reservation, missing legacy identity or uncertain query keeps work paused. Elapsed time and a restart timestamp do not substitute for worker evidence.

The human control route accepts only an exact job UUID. Native agent and MCP callers cannot perform recovery. The card requires a trusted user action, prevents duplicate requests, aborts its request when the chat changes, and ignores late receipts from an earlier context. A completed check retains the **Interrupted** state and announces that the partial files are kept. Lost or malformed replies remain unknown and require explicit inspection; there is no automatic retry.

The service records the check in `worker-resolution.json`, bound to the exact `job.json` bytes and validated worker records. It re-reads that evidence at startup and before new generation. Changed records, incomplete persistence and unresolved work retain the admission fence. Resolution, generation, probes and adoption cannot interleave through the same service admission window.

Cancellation before persistence saves nothing. Once a marker write starts, the service joins it and checks what actually reached disk. A committed check is reported as committed; an uncertain write remains fenced until explicitly checked again. The advisory history index is not resolution authority. These files use hashes for freshness and integrity; they do not authenticate a same-user process able to rewrite both files. Filesystem checks are observed boundaries, not a cross-file transaction.

Verification includes actual service/HTTP/SQLite fixtures, persistence and cancellation faults, stale evidence at later admission, strict browser receipt parsing, and a real Edge keyboard/card check with a synthetic service. The browser check covers inert scripted activation, one trusted request, preserved interrupted output, focus restoration and narrow layout. Native Blender generation and the complete customer workflow retain separate acceptance requirements.
