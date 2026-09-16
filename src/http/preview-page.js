/** Minimal HTML for `GET /:code+`: shows where a short link leads before following it. */
export class PreviewPage {
  static CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

  /** @param {string} s */
  static escape(s) {
    return s.replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /**
   * @param {{ code: string, shortUrl: string, url: string, status: string, createdAt: string|null, expiresAt: string|null, qrUrl: string }} v
   */
  static render(v) {
    const e = PreviewPage.escape;
    const active = v.status === 'active';
    const host = (() => { try { return new URL(v.url).hostname; } catch { return ''; } })();
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${e(v.code)} · link preview</title>
<style>
  body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
  main{max-width:560px;width:100%;background:#1e293b;border-radius:16px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:1.1rem;margin:0 0 4px;color:#94a3b8;font-weight:500}
  .dest{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;background:#0f172a;padding:12px;border-radius:10px;margin:12px 0}
  .go{display:inline-block;background:#38bdf8;color:#0f172a;font-weight:600;padding:10px 18px;border-radius:10px;text-decoration:none}
  .gone{color:#fca5a5}
  dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:.9rem;color:#94a3b8;margin:16px 0 0}dd{margin:0;color:#e2e8f0}
  img{display:block;width:160px;height:160px;border-radius:8px;margin:16px auto 0;background:#fff}
</style></head><body><main>
<h1>${e(v.shortUrl)} leads to</h1>
<div class="dest">${e(v.url)}</div>
${active ? `<a class="go" href="${e(v.url)}" rel="noreferrer">Continue to ${e(host)}</a>` : `<p class="gone">This link is ${e(v.status)} and no longer redirects.</p>`}
<dl><dt>Created</dt><dd>${e(v.createdAt ?? '–')}</dd><dt>Expires</dt><dd>${e(v.expiresAt ?? 'never')}</dd></dl>
${active ? `<img src="${e(v.qrUrl)}?format=svg" alt="QR code of ${e(v.shortUrl)}" width="160" height="160">` : ''}
</main></body></html>`;
  }
}
