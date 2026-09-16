import { LinkService } from '../domain/link-service.js';

/** @typedef {import('../types.js').LinkRow} LinkRow */
/** @typedef {import('../types.js').ClickRow} ClickRow */

/** Response shapes. */
export class Views {
  /** @param {string} publicBaseUrl */
  constructor(publicBaseUrl) {
    this.base = publicBaseUrl;
  }

  /**
   * @param {LinkRow} r
   * @param {number} [now]
   */
  link(r, now = Date.now()) {
    const iso = (/** @type {number|null} */ t) => (t === null ? null : new Date(Number(t)).toISOString());
    return {
      code: r.code,
      shortUrl: `${this.base}/${r.code}`,
      previewUrl: `${this.base}/${r.code}+`,
      qrUrl: `${this.base}/${r.code}/qr`,
      url: r.url,
      permanent: r.permanent === 1,
      enabled: r.enabled === 1,
      status: LinkService.status(r, now),
      expiresAt: iso(r.expires_at),
      maxClicks: r.max_clicks,
      clicks: Number(r.clicks),
      remainingClicks: r.max_clicks === null ? null : Math.max(0, Number(r.max_clicks) - Number(r.clicks)),
      lastClickAt: iso(r.last_click_at),
      tags: /** @type {string[]} */ (JSON.parse(r.tags)),
      note: r.note,
      createdBy: r.created_by,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  /** @param {ClickRow} c */
  static click(c) {
    return { at: new Date(Number(c.at)).toISOString(), visitor: c.visitor, referrer: c.referrer, device: c.device };
  }
}
