# QR codes

Every link has a QR code of its short URL, and any text can be encoded through the API. The encoder is built in (byte mode, error correction level M, versions 1–10, up to 213 bytes).

## For a link, public

```bash
curl -s $SL/spring/qr -o spring.svg                       # SVG, 4-module margin
curl -s "$SL/spring/qr?format=png&scale=10&margin=2" -o spring.png
```

No key needed, so the image can be embedded directly: `<img src="https://s.example.com/spring/qr?format=png&scale=6">`. Gone links answer `410`, unknown codes `404`.

| Parameter | Values | Meaning |
|---|---|---|
| `format` | `svg` (default), `png` | SVG scales to any size and is tiny; PNG for tools that need a raster. |
| `scale` | 1–20, default 8 | Pixels per module (PNG only; SVG uses a viewBox). |
| `margin` | 0–8, default 4 | Quiet zone in modules. The standard asks for 4; 2 is fine on screens. |

## For a link, authenticated

```bash
slcurl $SL/v1/links/spring/qr?format=png -o spring.png
```

Same image, also for disabled links (useful before enabling a campaign).

## Any text

```bash
slcurl "$SL/v1/qr?text=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("WIFI:T:WPA;S:Office;P:secret;;"))')" -o wifi.svg
```

Text up to 213 bytes; longer answers `400 QR_TOO_LONG`. A short link is the usual way around that: shorten the long URL, encode the short one.

## Caching

Responses carry `Cache-Control: public, max-age=86400` and a strong `ETag` derived from content and options, so browsers and CDNs re-download only when something changed. `If-None-Match` answers `304`.

## Printing

- Prefer SVG for print; it stays crisp at any size.
- Keep the quiet zone (margin 4) and print at least 2 cm wide for a 7-character short URL.
- Test with two different phones before printing 500 flyers. And create the link with `expiresAt` or `maxClicks` only if the flyer says so.
- QR codes encode the **short** URL; changing the destination later does not change the printed code.
