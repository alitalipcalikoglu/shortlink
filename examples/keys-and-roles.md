# API keys and roles

`SHORTLINK_API_KEYS=id:secret[:role],…`

| Role | Can | Give to |
|---|---|---|
| `write` | create, edit, delete links | backends that mint links |
| `read` | list, get, stats, QR, `/v1/qr`, `/metrics` | dashboards, exporters |
| `readwrite` | both (default) | the admin console, local development |

```env
SHORTLINK_API_KEYS=shop-backend:3f9a…:write,console:b02e…,grafana:e6d1…:read
```

Ids match `[A-Za-z0-9_-]{1,64}` and are unique; secrets are at least 32 characters and unique. The id is stored as `createdBy` on every link, so a key per application keeps authorship clear.

## Rate limits

- API: `RATE_LIMIT_MAX` requests per key per minute (default 600).
- Public side (redirect, preview, QR): `REDIRECT_RATE_LIMIT_MAX` per client address per minute (default 300). Needs `TRUST_PROXY=true` behind a proxy to see real addresses.

Both answer `429 RATE_LIMITED` with the wait time in the message.

## Responses

| Status | Code | Meaning |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or unknown secret; `WWW-Authenticate: Bearer` is set. |
| 403 | `FORBIDDEN` | Known key, wrong role. |

Keys are compared in constant time against every configured secret.
