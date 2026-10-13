# Native asset HTTP boundary proof

`tests/unit/native-asset-http-boundaries.test.ts` mounts only the real
`nativeAssetRoutes` on an owned loopback HTTP listener, with the real volatile
native registry, actual SQLite `ConversationWorkStore` and real conversation
host. `fakeAssetService` is an explicit runtime double. There is no provider or
installed-native attestation, and no production source changes.

Eight start/cancel cases send the first real HTTP body byte and observe the shared
parser consuming it after registry capture. Before the remaining bytes arrive,
the trusted fixture revokes/regrants, ends dispatch/opens a new intent, retires the
old incarnation/issues a foreign-chat replacement, or closes the registry.
Every stale request must return `NATIVE_ASSET_AUTHORITY` with zero service starts,
allocations or cancellations. The SQLite binding and job state stay unchanged;
fresh authority cannot upgrade the earlier capture or adopt it into another chat.
Registry retirement represents the host's disconnect fence, without a provider.

Held manifest/probe runtime completions are also released only after retirement
and foreign-chat replacement. Both must deny disclosure. The fake manifest is a
minimal disclosure sentinel, not generated artifact validation; the fake probe
performs no runtime discovery.

Raw HTTP checks cover wrong Host, any Origin, fetch metadata, normalized dot
segments, fragments, absolute request targets and duplicate sensitive headers.
Host/Authorization/Origin/Content-Type duplicates reach the real ingress guard;
duplicate Content-Length/Transfer-Encoding are rejected by Node's HTTP parser
before the fixture listener runs. No client-side URL/header normalization stands
in for these ingress checks.

The existing shared body parser remains unchanged. Tests exercise the 16 KiB
ordinary start/cancel boundary, the custom-recipe upper byte limit and allowance,
compressed-body refusal and fatal UTF-8 decoding. Successful boundary controls
ensure stale/malformed refusals are not merely a broken listener or fake service.

Only this test entry point and its source dependencies are compiled into a
private temporary output directory. Root compilation/dist, provider CLI/auth,
Studio, Blender, system security settings and Git operations are outside scope.
Test failures are retained and reported rather than suppressed.

Validation on 2026-10-13: private scoped compilation passed and all 13 own tests
passed (zero failures, cancellations or skips; approximately 9.65 seconds).
Private output is retained at
`C:/Users/alexk/AppData/Local/Temp/arcane-native-http-boundaries-check-D6jH9d/out`.
The scoped compiler entry point is only
`tests/unit/native-asset-http-boundaries.test.ts`; the emitted test was run with
`node --test --test-concurrency=1`. No production API mismatch was encountered.
The fixture uses the store's actual `list(conversation, kind)` API.
