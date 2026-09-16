# Listing and search

```bash
slcurl "$SL/v1/links?limit=2"
```

```json
{ "items": [ { "code": "kX9mQ2a", "...": "…" }, { "code": "spring", "...": "…" } ], "nextCursor": "MTc1ODA…" }
```

Newest first, 50 per page by default, at most 200. Pass `nextCursor` back as `cursor`; `null` means the end.

| Parameter | Matches |
|---|---|
| `q` | Substring of the code or the destination URL: `q=example.com/spring` |
| `tag` | One tag exactly: `tag=poster` |
| `status` | `active`, `disabled`, `expired`, `exhausted` |
| `createdBy` | API key id that created the link |

Everything expired that a campaign created:

```bash
slcurl "$SL/v1/links?tag=2026&status=expired"
```

Links pointing at a domain you are retiring:

```bash
slcurl "$SL/v1/links?q=old.example.com&limit=200"
```

`q` is a plain substring match (`%` and `_` are literal). There is no full-text ranking; for anything beyond this, export the list page by page.
