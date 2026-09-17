# `shortlink` readiness contract

## Purpose
`shortlink` lets the rest of the platform turn long URLs into short, brandable, trackable links:
random or custom codes, `301`/`302` redirects with expiry and click limits, a script-free preview
page, click statistics without storing visitor addresses, and QR codes generated in-process. The
public redirect path serves end users directly on the short domain; the management API stays
behind API keys.

## Dependencies
- `audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither. Identical mechanism to
  `flags` — `src/net/audit-client.js` is byte-identical between the two services (verified with
  `diff`). When unset, writes still succeed; when set, write events are buffered in memory and
  flushed on a 2s timer in the background, never on the request path, so an unreachable or slow
  audit service never slows down or fails a shortlink request. Buffered-and-unflushed events are
  lost on an ungraceful restart (no on-disk queue).

No other service or external system is called by `shortlink`. It never fetches redirect
destinations itself (`LinkService.#url` only validates the URL's shape).

## Persistence
Engine: SQLite via `node:sqlite`'s `DatabaseSync` (`src/db.js`), WAL journal mode, `synchronous =
NORMAL`, `busy_timeout = 5000`, foreign keys on. File location: `DB_PATH`, default
`./data/shortlink.db` (Docker image sets `/data/shortlink.db`).

Schema (one migration block, `Database.MIGRATIONS[0]`):
- `links` — one row per short code: `code` (PK), `url`, `permanent`, `enabled`, `expires_at`,
  `max_clicks`, `clicks` (counter), `last_click_at`, `tags` (JSON), `note`, `created_by`,
  `created_at`, `updated_at`; indexes `links_created(created_at DESC, code)` (keyset pagination) and
  `links_expires(expires_at)`.
- `clicks` — append-only click log: `id` (autoincrement PK), `code` (FK to `links.code`, `ON DELETE
  CASCADE`), `at`, `visitor` (HMAC, never the raw address), `referrer` (host only), `device`;
  indexes `clicks_code_at(code, at)` and `clicks_at(at)`.

Migration mechanism: identical pattern to `flags` — `Database.MIGRATIONS` is an ordered array of
SQL blocks gated by `PRAGMA user_version`, each applied in its own transaction. Fresh install: file
created, all migrations run from `user_version = 0`. Upgrade: only migrations beyond the stored
`user_version` run; today there is exactly one, so both cases behave the same. No down-migration
mechanism.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` unconditionally, no I/O, cannot be slow or fail while the
process is otherwise alive. Logged at `warn` level.

## Readiness endpoint
`GET /ready` calls `this.db.ping()` (`SELECT 1`), cached for `ShortlinkApi.READY_CACHE_MS =
10_000`ms — identical mechanism to `flags`. A poll inside the cache window touches nothing; a stale
cache re-pings and on failure caches `{ ok: false, error }` and the route answers `503`. Safe to
poll at any interval: read-only, no mutation, no discarded in-flight work.

## Graceful shutdown
`SIGTERM`/`SIGINT` → `Application.shutdown(reason)` (idempotent guard). Order: stop the maintenance
timer → `await this.app.close()` (Fastify drains in-flight requests, including any redirect
mid-click-write) → `await this.audit.close()` (stop timer, flush what's buffered) → `this.db.close()`.
A `30_000`ms unref'd force-exit timer runs in parallel (`process.exit(1)` if shutdown hangs).
`unhandledRejection` routes through the same graceful path; `uncaughtException` calls
`process.exit(1)` immediately, skipping drain and final audit flush. PM2 `kill_timeout: 35000`ms in
`ecosystem.config.cjs` — 5s above the internal 30s force-exit, matching `flags`' configuration
exactly (same comment, same numbers).

## Resource limits
- `BODY_LIMIT` (env, default `16_384` bytes / 16 KiB — smaller than `flags`' 64 KiB, since link
  bodies are just a URL plus metadata, not arbitrary JSON values).
- `MAX_URL_LENGTH` (env, default `2_048`, range 64–8192) — destination URL character cap.
- `CODE_LENGTH` (env, default `7`, range 4–16) — generated code length; `LinkService.CODE_ATTEMPTS
  = 5` random-generation collision retries before giving up with a hard error telling the operator
  to raise `CODE_LENGTH`.
- `RATE_LIMIT_MAX` (env, default `600`) requests per API key per minute on `/v1/*`.
- `REDIRECT_RATE_LIMIT_MAX` (env, default `300`) requests per client address per minute on the
  public redirect/preview/QR routes.
- QR text: encoder caps input at 213 bytes (`QrTooLongError`, surfaced as `400 QR_TOO_LONG`); QR
  `scale` 1–20, `margin` 0–8 (schema-validated).
- List page size: caller-supplied `limit`, default 50, capped at 200 per the README/schema.
- `max_memory_restart: '300M'` in `ecosystem.config.cjs`.

## Timeouts
- Audit outbound call: `timeoutMs = 5_000` default (unchanged by `Application`), same as `flags`.
- Shutdown force-exit: `30_000`ms, hard-coded.
- PM2 `listen_timeout: 10000`ms.
- No outward per-request timeout beyond the audit client's, because `shortlink` never calls another
  service synchronously in the request path — including the redirect path itself, which only reads
  and writes its own database.

## Retry policy
Only the audit forwarding path retries, on its own background timer, never in the request path.
Same numbers as `flags` (byte-identical `AuditClient`): up to `MAX_ATTEMPTS = 6` per batch, backoff
`min(30_000, 500 * 2 ** attempt)`ms (500ms → 30s), no jitter; a non-429 4xx drops the batch
permanently (logged), a 429/5xx/network error/timeout keeps it in the buffer for the next `flushMs
= 2_000`ms tick after all attempts in the current `#send` call are exhausted.

## Idempotency
- `POST /v1/links` with an explicit `slug` is **not** idempotent: repeating it fails `409
  SLUG_TAKEN`. Without a `slug` (random code), every call by definition creates a new, different
  link — there is no idempotency key to make retries safe, so a client retrying a timed-out create
  request risks creating a duplicate link for the same URL.
- `PATCH /v1/links/:code` is idempotent in result for a fixed patch (same end state on repeat).
- `DELETE /v1/links/:code` is **not** safe to repeat: `LinkService.remove` throws `404
  LINK_NOT_FOUND` on the second call rather than treating it as a no-op.
- **`GET /:code` (the redirect / click-recording path) is emphatically not idempotent by design** —
  every successful hit inserts a `clicks` row and increments the link's counter; it is meant to be
  called once per real visit, and a client retrying a redirect request (or a link scanner following
  it twice) inflates the click count and, once `maxClicks` is set, can push a link into `exhausted`
  status earlier than a single real visit would.
- QR and read routes (`GET /v1/links*`, `/v1/stats`, `/v1/qr`) are naturally idempotent — read-only.

## Backup
State that must survive a disk loss: the SQLite file at `DB_PATH` (default `./data/shortlink.db`)
plus its WAL/SHM sidecars while running. Nothing else is durable state. No backup script exists in
this repository; capture today by stopping the process and copying the file, or via SQLite's own
online-backup mechanism (not wired up here).

## Restore
Stop the service, replace `DB_PATH` (and any stale `-wal`/`-shm` files) with the backup, start the
service — `#migrate()` applies any migrations newer than the backup's `user_version` automatically.
No ordering constraint with other services: link and click data is self-contained (codes are opaque
strings; nothing else in the platform holds a foreign key into this database).

## Metrics
`GET /metrics` (Prometheus text, `read`-role key required):
- `shortlink_links{state="active"|"inactive"}` — durable, from `links` table (`active` = enabled,
  not expired, not exhausted, computed at request time).
- `shortlink_clicks_total` — durable, `SUM(links.clicks)` (bots excluded, since `hit()` is only
  called for non-bot devices).
- `shortlink_clicks_last_hour` — durable, `COUNT(*)` on `clicks` for the last hour (bots included in
  this one, unlike `clicks_total`).
- `shortlink_click_rows` — durable, total row count in the `clicks` table.
- `shortlink_process_uptime_seconds` — process-local (`process.uptime()`), resets on restart.

Unlike `flags`, `shortlink` has **no process-local counters exposed in `/metrics`** — every number
above is a live database read, so restarting the process (or running a second one) does not change
what `/metrics` reports.

## Logging
Same as `flags`: Fastify default request logger, `requestIdHeader: 'x-request-id'`, `genReqId:
randomUUID`, so `reqId` is on every log line per
[OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md); `req.headers.authorization` redacted. Not
emitted: `traceId`, `spanId`, `route`/`op` (raw `req.url` only), `durationMs` (Fastify's own
`responseTime` field, different name), `upstream`/`upstreamMs` (no proxied upstream calls),
`service`, `version`. `code` is in every JSON error body but only additionally logged for 500s via
`request.log.error({ err }, 'unhandled error')`.

## Tracing
Accepts whatever `X-Request-Id` the caller sends (no trust gate — internal service reached only via
gateway, console or peers) and generates one when absent. Does **not** parse, forward, or log
`traceparent` — implemented in `gateway` only, as of this review's Stage 1. No outbound HTTP calls
happen in the request path (the audit call is async and off-path and does not forward any
request-scoped header), so there's nothing to propagate onward regardless.

## Security model
Bearer API keys (`SHORTLINK_API_KEYS=id:secret[:role]`), compared via SHA-256 + `timingSafeEqual`
(same pattern as `flags`' `ApiKeyAuth`). Roles: `read`, `write`, `readwrite`. No environment scoping
(shortlink has no environment concept — one instance, one `PUBLIC_BASE_URL`). No secret rotation
support: edit `SHORTLINK_API_KEYS` and restart. At the boundary: destination URLs must be absolute
`http(s)`, without embedded credentials, not the service's own host, not matching `BLOCKED_HOSTS`
(exact or subdomain); request bodies are schema-validated with unknown fields rejected
(`removeAdditional: false`). Visitor privacy is part of the security model even though it's not
authentication: IP + user agent are never stored, only `HMAC(HASH_SECRET, ip + userAgent)`, and
`HASH_SECRET` itself has no rotation support (rotating it changes every future visitor hash without
being able to correlate against past hashes — that's an accepted trade-off, not a bug). Out of
scope: authenticating end users following a short link (the redirect is public by design), fetching
or validating that a destination URL actually resolves (`shortlink` never fetches destinations).

## Scaling model
**B — single-node stateful**: one process owns one SQLite file, `instances: 1` pinned in
`ecosystem.config.cjs` with the same "one process per SQLite file" comment as `flags`.

Two instances against the same file: the **create/list/stats/read paths** would be no less safe
than `flags`' equivalents — SQLite's own WAL locking serializes writes across processes. The
**redirect path (`GET /:code`) is the one that matters most here**, and it is **not safe** for two
processes sharing one file, specifically for `maxClicks` enforcement:

`LinkService.follow()` reads the link row (`this.links.byCode(code)`), computes `status` from that
already-read `row.clicks` vs `row.max_clicks` (`LinkService.status`), and only *then* opens a
`db.transaction()` that inserts the click row and calls `this.links.hit(code, now)`. `hit()`
(`src/store/link-store.js`) is an **unconditional increment** —
`UPDATE links SET clicks = clicks + 1, last_click_at = ? WHERE code = ?` — not a conditional update
guarded by `AND clicks < max_clicks`. Within a single process this is not exploitable: `follow()`
contains no `await` between the read and the write, and `node:sqlite`'s `DatabaseSync` is
synchronous, so the whole function runs to completion on the event loop with no interleaving
possible between two concurrent requests to the *same* process — the second request's `byCode` read
always happens after the first request's `hit()` has already committed. **Across two processes
sharing the same file, that guarantee disappears**: both processes can read the same
`row.clicks = maxClicks - 1` at effectively the same instant, both compute `status = 'active'`, and
both proceed to record a click and increment — the counter can exceed `max_clicks` by as many as
there are genuinely concurrent cross-process requests at the boundary. `BEGIN IMMEDIATE` inside
`db.transaction()` serializes the *writes* themselves (one process's transaction blocks the other's
until it commits) but does nothing to prevent this, because the decision to proceed was already made
from a stale read taken *before* the transaction opened.

The housekeeping/cleanup worker (`Maintenance`, hourly `clicks.purge()`) running twice would simply
issue the same `DELETE FROM clicks WHERE at < ?` twice — wasted work, not a correctness problem,
since a `DELETE` with no matching rows the second time is a safe no-op.

## Single-node / multi-node guarantees
Running more than one `shortlink` instance against the same `DB_PATH` today is unsupported: reads
and most writes would stay individually consistent (SQLite's own locking), but `maxClicks`
enforcement on the redirect path can be violated by concurrent cross-process traffic (see above) —
a link can accumulate more clicks than `max_clicks` once two processes are both serving its
redirects. There is no shared cache, no coordination, no leader election; only the shipped
single-instance topology has been exercised or is claimed safe.

## Known failure modes
- **Disk full**: a write inside `db.transaction()` throws, rolls back, and the redirect (or
  management write) fails with a `500`; the link/click tables are left in their pre-write state.
- **Audit service times out or is unreachable mid-request**: no effect on the shortlink request —
  `record()` is a synchronous in-memory push; the network call is deferred to the background timer.
  Long enough downtime drops events once `MAX_BUFFER = 5_000` is hit.
- **Process killed without graceful shutdown**: buffered-but-unflushed audit events are lost; the
  SQLite file itself should stay consistent (WAL, atomic commits), but the in-flight request being
  served gets no response, and a request whose click-insert committed but whose HTTP response never
  went out would be recorded as a click with no confirmation reaching the client.
- **Two instances run against one file**: unsupported; specifically, the redirect path's
  `maxClicks` enforcement (read-then-write, not a conditional `UPDATE`) can be exceeded under
  concurrent cross-process traffic, as detailed under Scaling model above — this is the one
  concurrency risk in this service that a second instance would actually expose in production
  behaviour, not just in metrics bookkeeping.
