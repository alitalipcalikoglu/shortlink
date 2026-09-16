# Click statistics

## One link

```bash
slcurl "$SL/v1/links/spring/stats?days=30"
```

```json
{
  "code": "spring", "days": 30, "since": "2026-08-17T10:00:00.000Z",
  "total": 1284,
  "clicks": 1301, "visitors": 902, "bots": 41,
  "byDay": [ { "day": "2026-09-14", "clicks": 120, "visitors": 98 }, { "day": "2026-09-15", "clicks": 233, "visitors": 190 } ],
  "byReferrer": [ { "referrer": null, "clicks": 700 }, { "referrer": "instagram.com", "clicks": 310 }, { "referrer": "t.co", "clicks": 120 } ],
  "byDevice": { "mobile": 980, "desktop": 280, "bot": 41 },
  "recent": [ { "at": "2026-09-16T09:59:12.000Z", "visitor": "9f2c…", "referrer": "instagram.com", "device": "mobile" } ]
}
```

| Field | Meaning |
|---|---|
| `total` | Counted clicks over the link's whole life (bots excluded); the same number as `clicks` on the link object. Survives click-log retention. |
| `clicks` | Rows in the click log for the window, bots included. |
| `visitors` | Distinct visitor hashes in the window (same address and browser = one visitor). |
| `bots` | Requests classified as crawler, link checker or preview fetcher. |
| `byDay` | Per UTC day, bots excluded. Days without clicks are absent. |
| `byReferrer` | Referrer **host**, top 10, bots excluded. `null` means no referrer: typed, from an app, or from a QR scan. |
| `byDevice` | `mobile`, `desktop`, `bot`, `other`. |
| `recent` | Last 20 log rows. |

`days` is 1–365, default 30.

## QR scans

Scans come with no referrer and usually a mobile user agent. A link used only on printed material therefore shows `referrer: null` and `device: mobile`. To separate channels, create one link per channel (`spring-poster`, `spring-instagram`) and compare.

## Service overview

```bash
slcurl "$SL/v1/stats?days=7"
```

```json
{ "days": 7, "since": "…", "links": { "total": 412, "active": 390, "clicks": 88120 }, "clicksInWindow": 5120, "topLinks": [ { "code": "spring", "url": "…", "shortUrl": "…", "clicks": 1301 } ] }
```

Time series for dashboards: scrape `/metrics` (see [operations](operations.md)).
