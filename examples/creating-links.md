# Creating links

## Random code

```bash
slcurl -X POST $SL/v1/links -d '{"url":"https://example.com/spring-sale?utm_source=poster"}'
```

```json
{
  "link": {
    "code": "kX9mQ2a",
    "shortUrl": "http://localhost:3006/kX9mQ2a",
    "previewUrl": "http://localhost:3006/kX9mQ2a+",
    "qrUrl": "http://localhost:3006/kX9mQ2a/qr",
    "url": "https://example.com/spring-sale?utm_source=poster",
    "permanent": false, "enabled": true, "status": "active",
    "expiresAt": null, "maxClicks": null, "clicks": 0, "remainingClicks": null, "lastClickAt": null,
    "tags": [], "note": null,
    "createdBy": "shop-backend",
    "createdAt": "2026-09-16T10:00:00.000Z", "updatedAt": "2026-09-16T10:00:00.000Z"
  }
}
```

`201 Created`, `Location: /v1/links/kX9mQ2a`. Codes are `CODE_LENGTH` (default 7) characters from `A-Z a-z 0-9`, drawn from a CSPRNG without modulo bias. `createdBy` is the id of the API key used.

## Custom slug

```bash
slcurl -X POST $SL/v1/links -d '{"url":"https://example.com/spring-sale","slug":"spring","tags":["Poster","2026"],"note":"Printed on 500 flyers"}'
```

Slugs: 3–64 characters, letters, digits, `_` and `-`, starting with a letter or digit. Case-sensitive (`Spring` and `spring` are different links). Reserved words (`v1`, `health`, `ready`, `metrics`, `qr`, `api`, `admin`, `robots.txt`, …) are refused with `SLUG_RESERVED`; an existing slug with `SLUG_TAKEN` (`409`).

Tags are lower-cased, trimmed and de-duplicated: `["Poster","2026"]` is stored as `["2026","poster"]`. Up to 20 tags of 40 characters; use them for campaigns and filter by them when listing.

## Options

| Field | Effect |
|---|---|
| `permanent: true` | Redirect with `301` instead of `302`; browsers cache it, so the destination should not change later. Default from `DEFAULT_PERMANENT`. |
| `expiresAt` | ISO 8601, must be in the future. See [expiry and limits](expiry-and-limits.md). |
| `maxClicks` | Positive integer; the link stops redirecting after that many counted (non-bot) clicks. |
| `tags`, `note` | Organisation only; not visible to visitors. |

## Destination rules

- Absolute `http://` or `https://` URL, at most `MAX_URL_LENGTH` (2048) characters, no credentials in the URL.
- Not pointing at the service's own `PUBLIC_BASE_URL` host (redirect loops).
- Host not in `BLOCKED_HOSTS` (`HOST_BLOCKED`), including subdomains.

The service does not fetch the destination; it does not know whether the page exists.

## Editing and deleting

```bash
slcurl -X PATCH $SL/v1/links/spring -d '{"url":"https://example.com/spring-sale-2","tags":["poster","2026","v2"]}'
slcurl -X DELETE $SL/v1/links/spring     # 204; the code becomes free again, click history is removed
```

`PATCH` accepts any subset of `url`, `permanent`, `enabled`, `expiresAt` (or `null` to clear), `maxClicks` (or `null`), `tags`, `note`. Deleting a code that was printed somewhere makes those prints dead; prefer `enabled: false` (see [expiry and limits](expiry-and-limits.md)).
