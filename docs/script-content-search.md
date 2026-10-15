# Script content discovery

Arcane can find literal text in current editor scripts through `script_search`. The native task guidance selects this tool for source discovery; ordinary chat users do not need to choose it manually. The advanced workbench also offers **Search script contents**. Selecting a returned match opens the current-source read controls.

The tool requires an exact paired `sessionId`, granted `root` and nonempty, single-line `query`. An optional observed `ref` narrows traversal to that subtree, including the referenced script itself. `caseSensitive` defaults to true; false folds ASCII letters and does not provide Unicode case folding. Whitespace and regex punctuation remain literal. A read-only grant is sufficient; older plugins without the `script.search` capability refuse the operation.

| Bound | Limit |
| --- | --- |
| Query | 256 UTF-8 bytes; valid Unicode without ASCII control characters |
| Returned lines | 1–100, default 50; first occurrence per matching line |
| Traversal | 5,000 nodes |
| Script read attempts | 128 |
| Individual source | 100 KiB |
| Scanned source | 2 MiB |
| Match-item JSON | 256 KiB, within the existing 512 KiB result envelope |
| Excerpt | At most 512 UTF-8 bytes, aligned to complete characters around the match |

Each item includes the genuine session ref, display name/class, one-based `line` and `column`, `excerpt`, `excerptStartColumn` and `excerptTruncated`. Columns count UTF-8 bytes. `sourceKind: "editor"` identifies the editor-aware source API. `atomicSnapshot: false` makes clear that a traversal can observe changing scripts.

The result includes `nodesVisited`, successful `scriptsRead`, `skippedScripts`, scanned `sourceBytes`, `truncated` and `reasons`. Reasons distinguish match, node, script, source-byte and result-byte limits, plus unreadable source. Oversized/unavailable scripts are skipped explicitly and make the result incomplete. A successful read that reaches the aggregate source budget can be counted in `scriptsRead` without its bytes being scanned. Narrow an incomplete search instead of claiming that absence proves no occurrence exists.

The plugin checks the current grant and actual subtree before traversal and after each editor read. Revocation or a target moved outside the requested scope stops the operation. Search performs no source assignment, execution-state change, undo recording or mutation receipt. Excerpts never become edit baselines: call `script_read` for the selected ref, then use its exact current source for an authorized `script_update`.

## Verification

Standalone Luau tests compile and run the production plugin modules with in-memory engine doubles. Ten cases cover dirty editor source, repeated display names, literal/Unicode matching, subtree/session/root scope, malformed inputs, exact-limit completion, valid bounded excerpts, unavailable source, all work/result limits, grant loss during a read, and read-only transport admission without writes/history changes.

SDK/HTTP/SQLite checks verify the advertised read tool, exact defaults, input refusal before enqueue and real read-only command admission/result storage. Actual Edge checks verify whitespace preservation, safe excerpt rendering, explicit truncation, source-match selection and a fresh baseline read within the existing workbench regression scenario. Deterministic modular plugin build/check also passes. Native Studio execution and complete packaged customer acceptance remain separate gates.
