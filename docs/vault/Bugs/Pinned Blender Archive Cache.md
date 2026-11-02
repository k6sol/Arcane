---
type: bug
project: Arcane
tags: [arcane, release, blender]
---
# Pinned Blender archive cache

Original native run41530614761 on signed8475cd9 completed with Windows success and Ubuntu failure. Windows completed the actual worker query, conversion, foliage, boulder and tree save/reopen checks. Ubuntu failed acquiring the official checksum-pinned Blender archive with HTTP403 before conversion. The failed original and its log are retained; it was not rerun. The component run41530614832 has completed Ubuntu contracts and Windows Edge checks successfully at this observation; remaining original jobs require observation.

The hosted native workflow now restores only the immutable archive, using the official [GitHub cache action](https://github.com/actions/cache) pinned to v5.1.0 commitcaa296126883cff596d87d8935842f9db880ef25. Keys include the OS and exact installer-source hash; there are no broad restore keys. Every cache hit is copied into a fresh owned directory while checking exact length, SHA-256, ordinary single-link identity and unchanged handle metadata. No cached executable or conversion result is trusted. All original extraction bounds, executable hashing and real native tests still run.

A cold miss makes one original official download under the existing deadline, response, redirect, byte and checksum requirements. Verified bytes enter the cache through a staged copy and atomic no-overwrite publication. The workflow saves only after acquisition succeeds. An invalid cache fails without replacement or network fallback; a failed HTTP request is neither retried nor published. Cache reuse does not eliminate a first cold-download outage or prove hosted availability. Acquisition logs explicitly distinguish download and cache; the archive receipt retains the fixed official origin URL and exact content pins.

The complete21-case isolated Windows Python suite passes, including warm/cold reuse, hash/length/link refusal, mutation during reading, no-overwrite, one-request HTTP403 failure, extraction traversal/alias bounds and environment safeguards. The initial sandbox run failed before fixture setup because temporary paths were denied; the first elevated run exposed Python3.14 Windows lstat/fstat ctime semantics. The correction compares ctime through the same handle and binds the named file through device/inode/size/mtime. The original failure is retained. No Blender, provider or Studio operation was performed by these tests. Actual hosted cache restoration and packaged customer acceptance remain open.

[[Delivery/G01 Release Baseline]] - [[Bugs/Windows Native Worker Query]] - [[Operations/Next Session]]
