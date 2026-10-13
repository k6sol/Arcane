# Workflow native permission-check observation

The full canonical run `native-ready-regression-th0JsL` failed one workflow
assistance draft request with `WORKFLOW_RECEIPT_STORAGE` / HTTP 503. Its overall
result (1,335 passed, 16 failed, 2 cancelled, no skips) and terminal close are
retained. The cause of that specific storage refusal is not established.

An explicitly observational follow-up ran the whole assistance HTTP fixture
through the actual native Windows checker. The loader hook changed only the
native call wrapper to record elapsed time, exit status, signal, error code and
byte lengths. It forwarded the executable, arguments, environment, result and
5,000 ms deadline unchanged. It logged no paths, key bytes, stdout content or
stderr content. The run passed all three cases and closed normally.

`runtime/verification/workflow-acl-observation-20261013/native-calls.jsonl`
records 35 real native calls; every status was zero, no signal/error occurred,
and the responses were the expected bounded descriptors. This demonstrates
successful isolated behavior, **not** that the earlier refusal was harmless,
that its cause was a timeout, or that the full regression is now accepted.

No permission predicate, native check count, timeout, ACL, API authority or
production file was relaxed or changed for this follow-up. A new uninstrumented
canonical full run must pass before a new executable can be accepted. If the
refusal recurs, retain and investigate it rather than silently retrying a
permission decision or advertising success.
