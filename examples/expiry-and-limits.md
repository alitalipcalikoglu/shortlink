# Expiry and click limits

## Time-limited link

```bash
slcurl -X POST $SL/v1/links -d '{"url":"https://example.com/webinar","slug":"webinar-jun","expiresAt":"2026-06-30T21:00:00Z"}'
```

After `expiresAt` the redirect answers `410 LINK_GONE` with `details.status = "expired"`, the preview page says "This link is expired", and `GET /v1/links/webinar-jun` reports `"status": "expired"`. The link itself is kept: extend it with `PATCH { "expiresAt": "2026-07-31T21:00:00Z" }` or clear the limit with `{ "expiresAt": null }`.

## Single-use or limited link

```bash
slcurl -X POST $SL/v1/links -d '{"url":"https://example.com/download/report.pdf","maxClicks":1}'
```

`remainingClicks` in responses shows what is left. When it reaches zero the status is `exhausted`. Raise or clear the limit with `PATCH { "maxClicks": 10 }` / `{ "maxClicks": null }`.

Only counted clicks consume the limit. Requests whose user agent looks like a crawler, link checker or chat preview fetcher (`bot` device class) are logged but do not count, so a link pasted into a chat is not spent by the chat app's preview.

## Disabling instead of deleting

```bash
slcurl -X PATCH $SL/v1/links/webinar-jun -d '{"enabled":false}'
```

Disabled links keep their code, history and statistics; visitors get `410`. Re-enable with `{ "enabled": true }`. Delete (`DELETE /v1/links/:code`) only when the code should become available again.

## Statuses

| `status` | Meaning | Redirect |
|---|---|---|
| `active` | enabled, not expired, under the limit | yes |
| `disabled` | `enabled: false` | 410 |
| `expired` | `expiresAt` passed | 410 |
| `exhausted` | `clicks >= maxClicks` | 410 |

`disabled` takes precedence over the others in the reported status. Filter lists by status: `GET /v1/links?status=expired`.
