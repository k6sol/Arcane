# Asset worker supervision

Each generated asset job retains a bounded `workers` journal in `job.json`. Arcane saves a reservation before starting each Blender probe, Python probe or generation process. A crash between launch and identity capture therefore leaves an unresolved reservation rather than an apparent absence of workers.

Records move from `reserved` to `captured` or `closed`. A captured Windows identity contains the exact owned PID, OS creation time and executable. Closure comes from the supervisor observing its child's `close` event, or confirming that no process started. Calling `kill()`, reaching a deadline or finding an older probe absent does not establish closure of another stage.

The journal permits six records and never evicts an unresolved record. Probe discovery keeps one slot available for generation. Transitions and persistence are serialized; a failed write prevents further launches for that job. Success, failure and restart recovery retain the records. An unresolved stage leaves the job `interrupted`, preserving the existing admission fence and partial files.

On Windows, a fixed PowerShell/CIM query reads only the recorded PID's creation time and executable. It reads no command lines and performs no process enumeration. Query failure, inaccessible metadata, malformed output and timeout yield uncertainty. A live worker whose identity cannot be captured is stopped and joined. A worker that already exited can finish through its observed closure. On other platforms, the reservation remains unresolved while the worker runs and closes only through its supervisor.

Standalone probes track reservations in memory. They remove only the scratch directory created by that invocation after every owned child has closed and the resolved path remains a direct child of the temporary root. Uncertain scratch is retained. Arcane does not sweep earlier probe directories.

The process runner waits for actual closure before releasing its slot. It requests termination at its deadline and escalates after 500 ms. A failed termination request does not release the slot. There is currently no hard deadline after escalation: an unconfirmed child keeps the job pending and the slot held.

Verification covers durable reservation before spawn, crash points across all three roles, persistence failure, PID reuse, immutable records, overlapping writes, unsupported platforms, uncertainty and throwing termination requests. An additional Windows check captured one disposable owned Node child, observed its matching live identity, closed that child and observed its absence. That receipt covers the exact identity adapter in this environment. [Human worker recovery](asset-worker-recovery.md) uses these records to assess interrupted jobs. Blender generation, Windows descendant containment and native Studio delivery retain separate acceptance requirements.
