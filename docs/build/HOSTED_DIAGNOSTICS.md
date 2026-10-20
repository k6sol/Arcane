# Hosted diagnostics

Arcane's gateway can receive structured failures and let an authorized owner inspect them later. This source prepares
the service and a durable local queue. A host, HTTPS address, managed authentication and deployment are still required.
There is no configured central server or assistant access to a live deployment in this change.

## Report boundary

`packages/diagnostics/src/report.ts` is the shared, closed wire schema. Producers call `diagnosticEvent(input)` before
enqueueing. Every event needs `schemaVersion:1`, a fresh UUID `eventId`, epoch-millisecond `occurredAt`, and reviewed
`component`, `stage` and `code` tokens. `reason` is reconstructed from the code catalogue; an arbitrary reason is refused.
Optional context admits only UUID job/operation references, enumerated exception class/signal and bounded numeric facts.
For example:

```json
{"schemaVersion":1,"eventId":"8e6bc8a1-a0ea-4823-8998-0f82d14469ba","occurredAt":1792500000000,
 "component":"blender","stage":"texture-authoring","code":"MEMORY_LIMIT",
 "context":{"exceptionType":"MemoryError","exitCode":1,"triangleBudget":16000}}
```

The resulting report explains the failed stage and reason alongside its safe facts. Unknown exceptions use
`INTERNAL_ERROR` and a known exception class; do not pass `error.message` or `stack`. New meaningful failure categories
require a reviewed catalogue entry. Both local and server boundaries reject unknown fields, including prompts, script
text, passwords, tokens, emails, user labels, filesystem paths, exception messages, stacks and attachments. This is a
projection onto allowed fields rather than a promise that a regex can detect every secret. UUIDs and numeric facts
still constitute operational metadata; operators must restrict access and apply the retention policy.

## Durable local outbox

`DiagnosticOutbox` accepts a **caller-owned dedicated private SQLite connection**, a `DiagnosticCodec` with `seal/open`,
an exact HTTPS origin allowlist and a current credential accessor. The host must secure the directory/database and use
OS-backed encryption; the queue does not create directories, store bearers or weaken existing path/ACL checks.

1. After account sign-in, request `GET /v1/diagnostics/identity` with the approved device bearer.
2. Compute `diagnosticScope(exactHttpsOrigin, accountId)` and use that stable scope for enqueue and credential access.
   Bearer rotation does not change the scope. A different account/origin has a separate queue scope.
3. `enqueue(scope, event)` validates, encrypts and commits before returning its event id. A repeated identical event is
   idempotent; reuse with different content fails. No raw report is written to disk. Codec failures refuse the write.
4. The host schedules explicit `flush()` calls. Each sends at most five events, with a five-second request timeout,
   no redirects and no browser cookies. No origin, no credential or a changed account means no transmission for that scope.
5. Only a bounded positive response with the matching `eventId` deletes a queued report. Ambiguous acknowledgements,
   network/authorization failures and 429/5xx responses retain it with persisted exponential backoff (one second to one hour).
   Permanent schema/conflict errors are marked blocked for local inspection, not silently treated as delivered.

The queue holds at most 1,000 events across scopes for 30 days. It refuses new entries when full; it does not silently
overwrite earlier evidence. A 30-second persisted lease recovers after a crash between server acceptance and local
acknowledgement. Retrying the same event id prevents a second server record. Expiry removes old queue rows on enqueue
or flush. Signed-out startup errors need a host-owned local retention path until an account scope is known; this library
does not invent an account binding or upload a different user's queue. The caller must surface queue-write failure
locally without recursively reporting that same failure. This bounded store cannot guarantee capture during power loss,
disk failure, process termination or failures before its host initializes.

## Hosted API and administration

- Enable with `DIAGNOSTICS_ENABLED=1`; managed accounts are required. Ingress reuses approved device bearers, including
  existing expiration, revocation, account suspension and enrolled MFA checks. It does not accept an anonymous API key.
- `POST /v1/diagnostics/events` accepts one JSON event, at most 8 KiB. The response is exactly
  `{"accepted":true,"eventId":"..."}` for both initial acceptance and identical retries. Reuse with different content is 409.
- Per-account default limit: 60 requests/minute. Pre-authentication per-IP diagnostic limit: 240/minute. Configure a
  trusted reverse proxy correctly; never trust client-supplied forwarding headers directly.
- `GET /v1/admin/diagnostics` uses the existing browser session and server-authorized owner role, verified MFA and a
  second-factor check within 15 minutes. Device bearers do not grant report-reading access. Pages have at most 50 records
  and a `next` cursor; pass it as `before`. Optional exact `accountId` and UUID `eventId` filters are supported.
- Responses use `no-store`. There is no public log listing, export bucket or unauthenticated log endpoint. An assistant
  must use an operator-authorized authenticated browser/tool session to inspect this API after deployment. Do not paste
  session cookies, account credentials or server encryption keys into chat.

Server payloads use the existing account store's AES-256-GCM encryption with diagnostic/account/event-associated data.
The account id, receipt timestamp and event fingerprint remain database metadata. Encryption keys come from the host's
secret manager; compromise of the running host or its key can expose reports. HTTPS protects transit only when the host's
TLS endpoint is configured correctly. This does not claim that a deployment is leak-proof or already security audited.

## Deployment preparation

Use the gateway's existing `Dockerfile`, managed-account setup and `.env.example`. Build from the repository root so
the image receives the shared report schema:

```sh
docker build -f services/gateway/Dockerfile -t arcane-gateway .
```

`services/gateway/Dockerfile.dockerignore` admits only fixed reviewed source files, excluding `.git`, environment files,
runtime artifacts and databases from the build context. Add a reviewed file exception when adding a runtime import.
This uses [Docker's per-Dockerfile ignore-file convention](https://docs.docker.com/build/concepts/context/#filename-and-location);
the selected fixtures check manifest/dependency closure, not an actual Docker image build.

The container runs as `node` and requires a persistent `/data` volume. Configure HTTPS, `PUBLIC_URL`, managed accounts,
stable `AUTH_SECRET`/`ACCOUNTS_SESSION_KEY`, and owner bootstrap/MFA before enabling diagnostics. This gateway also hosts
billing; its current production configuration requires payment keys. No paid hosting, domain, account creation, keys,
DNS change, deployment or live payment configuration is performed by this source change.

Set retention between 1 and 30 days; default limits are 10,000 reports/account and 100,000 total. Expired rows are swept
on startup, ingress/admin reads and the existing hourly maintenance cycle. Full capacity rejects new events with 503 so
devices retain them for retry. The service is single-instance SQLite; use host disk quotas and monitoring, and account for
SQLite free pages/WAL and encrypted backups when setting storage and deletion policies. If the service is stopped or
disabled, arrange host-side expiration for old databases/backups; no process runs to enforce retention while it is offline.

Before enabling a deployment, exercise the actual domain's approved device flow, revocation, owner MFA, ingress retries,
retention and admin query. Producer hooks, desktop queue initialization/scheduling and a configured service origin are
separate host integrations; merely adding these modules does not capture every error or transmit existing local logs.
