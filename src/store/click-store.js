/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').ClickRow} ClickRow */

/** Click log and its aggregates. */
export class ClickStore {
  /** @param {Database} db */
  constructor(db) {
    this.stmt = {
      insert: db.prepare(`INSERT INTO clicks (code, at, visitor, referrer, device) VALUES (?, ?, ?, ?, ?)`),
      totals: db.prepare(`SELECT COUNT(*) AS clicks, COUNT(DISTINCT CASE WHEN device <> 'bot' THEN visitor END) AS visitors, SUM(CASE WHEN device = 'bot' THEN 1 ELSE 0 END) AS bots FROM clicks WHERE code = ? AND at >= ?`),
      byDay: db.prepare(`SELECT (at / 86400000) * 86400000 AS day, COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS visitors FROM clicks WHERE code = ? AND at >= ? AND device <> 'bot' GROUP BY day ORDER BY day`),
      byReferrer: db.prepare(`SELECT COALESCE(referrer, '') AS referrer, COUNT(*) AS n FROM clicks WHERE code = ? AND at >= ? AND device <> 'bot' GROUP BY referrer ORDER BY n DESC LIMIT 10`),
      byDevice: db.prepare(`SELECT device, COUNT(*) AS n FROM clicks WHERE code = ? AND at >= ? GROUP BY device`),
      recent: db.prepare(`SELECT id, code, at, visitor, referrer, device FROM clicks WHERE code = ? ORDER BY id DESC LIMIT ?`),
      since: db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE at >= ?`),
      purge: db.prepare(`DELETE FROM clicks WHERE at < ?`),
      total: db.prepare(`SELECT COUNT(*) AS n FROM clicks`),
    };
  }

  /**
   * @param {Omit<ClickRow, 'id'>} c
   */
  record(c) {
    this.stmt.insert.run(c.code, c.at, c.visitor, c.referrer, c.device);
  }

  /**
   * @param {string} code
   * @param {number} since
   */
  stats(code, since) {
    const t = /** @type {{ clicks: number, visitors: number, bots: number|null }} */ (this.stmt.totals.get(code, since));
    const n = (/** @type {any} */ r) => Number(r.n);
    return {
      clicks: Number(t.clicks),
      visitors: Number(t.visitors),
      bots: Number(t.bots ?? 0),
      byDay: /** @type {{ day: number, clicks: number, visitors: number }[]} */ (this.stmt.byDay.all(code, since)).map((r) => ({ day: new Date(Number(r.day)).toISOString().slice(0, 10), clicks: Number(r.clicks), visitors: Number(r.visitors) })),
      byReferrer: /** @type {{ referrer: string, n: number }[]} */ (this.stmt.byReferrer.all(code, since)).map((r) => ({ referrer: r.referrer || null, clicks: n(r) })),
      byDevice: Object.fromEntries(/** @type {{ device: string, n: number }[]} */ (this.stmt.byDevice.all(code, since)).map((r) => [r.device, n(r)])),
    };
  }

  /**
   * @param {string} code
   * @param {number} limit
   * @returns {ClickRow[]}
   */
  recent(code, limit) {
    return /** @type {ClickRow[]} */ (this.stmt.recent.all(code, limit));
  }

  /** @param {number} since */
  countSince(since) {
    return Number(/** @type {{ n: number }} */ (this.stmt.since.get(since)).n);
  }

  count() {
    return Number(/** @type {{ n: number }} */ (this.stmt.total.get()).n);
  }

  /** @param {number} before */
  purge(before) {
    return Number(this.stmt.purge.run(before).changes);
  }
}
