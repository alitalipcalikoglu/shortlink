/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').LinkRow} LinkRow */
/** @typedef {import('../types.js').ListFilter} ListFilter */

/** Persistence for links. */
export class LinkStore {
  static COLUMNS = 'code, url, permanent, enabled, expires_at, max_clicks, clicks, last_click_at, tags, note, created_by, created_at, updated_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = LinkStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO links (${C}) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`),
      byCode: db.prepare(`SELECT ${C} FROM links WHERE code = ?`),
      update: db.prepare(`UPDATE links SET url = ?, permanent = ?, enabled = ?, expires_at = ?, max_clicks = ?, tags = ?, note = ?, updated_at = ? WHERE code = ?`),
      remove: db.prepare(`DELETE FROM links WHERE code = ?`),
      hit: db.prepare(`UPDATE links SET clicks = clicks + 1, last_click_at = ? WHERE code = ?`),
      // The maxClicks correctness primitive: the increment and the "still allowed" check happen in
      // the SAME statement, so there is no read-then-write gap for two concurrent resolves to both
      // slip through. SQLite's own locking (WAL + busy_timeout, see db.js) serializes this across
      // every connection/process sharing the file — not just within one process.
      hitIfActive: db.prepare(`UPDATE links SET clicks = clicks + 1, last_click_at = ?
        WHERE code = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > ?) AND (max_clicks IS NULL OR clicks < max_clicks)`),
      counts: db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1 AND (expires_at IS NULL OR expires_at > ?) AND (max_clicks IS NULL OR clicks < max_clicks) THEN 1 ELSE 0 END) AS active,
        SUM(clicks) AS clicks FROM links`),
      top: db.prepare(`SELECT l.code, l.url, COUNT(c.id) AS n FROM clicks c JOIN links l ON l.code = c.code WHERE c.at >= ? AND c.device <> 'bot' GROUP BY l.code ORDER BY n DESC LIMIT ?`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /**
   * @param {Omit<LinkRow, 'clicks'|'last_click_at'>} row
   * @returns {LinkRow}
   */
  insert(row) {
    this.stmt.insert.run(row.code, row.url, row.permanent, row.enabled, row.expires_at, row.max_clicks, row.tags, row.note, row.created_by, row.created_at, row.updated_at);
    return { ...row, clicks: 0, last_click_at: null };
  }

  /** @param {string} code */
  byCode(code) {
    return /** @type {LinkRow|undefined} */ (this.stmt.byCode.get(code));
  }

  /** @param {LinkRow} row */
  update(row) {
    this.stmt.update.run(row.url, row.permanent, row.enabled, row.expires_at, row.max_clicks, row.tags, row.note, row.updated_at, row.code);
    return row;
  }

  /** @param {string} code */
  remove(code) {
    return Number(this.stmt.remove.run(code).changes) > 0;
  }

  /**
   * Increment the click counter; returns false when the row vanished meanwhile.
   * @param {string} code
   * @param {number} at
   */
  hit(code, at) {
    return Number(this.stmt.hit.run(at, code).changes) > 0;
  }

  /**
   * Atomically increments `clicks` only if the link is still active (enabled, unexpired, under
   * `max_clicks`) — the compare-and-increment that makes `maxClicks` correct under real
   * concurrency. `false` doesn't say WHY (not found vs. disabled vs. expired vs. exhausted); a
   * caller that needs the reason does a plain follow-up `byCode()` read, which is safe precisely
   * because it can no longer grant an extra click — the counting already happened, or didn't.
   * @param {string} code
   * @param {number} now
   */
  hitIfActive(code, now) {
    return Number(this.stmt.hitIfActive.run(now, code, now).changes) > 0;
  }

  /**
   * Newest first, keyset pagination on (created_at, code).
   * @param {ListFilter} f
   * @param {{ limit: number, before?: { createdAt: number, code: string }, now: number }} page
   * @returns {LinkRow[]}
   */
  list(f, { limit, before, now }) {
    /** @type {string[]} */
    const where = [];
    /** @type {(string|number)[]} */
    const params = [];
    if (f.q !== undefined) {
      where.push('(code LIKE ? ESCAPE \'\\\' OR url LIKE ? ESCAPE \'\\\')');
      const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like);
    }
    if (f.tag !== undefined) { where.push('tags LIKE ?'); params.push(`%${JSON.stringify(f.tag)}%`); }
    if (f.createdBy !== undefined) { where.push('created_by = ?'); params.push(f.createdBy); }
    switch (f.status) {
      case 'active': where.push('enabled = 1 AND (expires_at IS NULL OR expires_at > ?) AND (max_clicks IS NULL OR clicks < max_clicks)'); params.push(now); break;
      case 'disabled': where.push('enabled = 0'); break;
      case 'expired': where.push('enabled = 1 AND expires_at IS NOT NULL AND expires_at <= ?'); params.push(now); break;
      case 'exhausted': where.push('enabled = 1 AND (expires_at IS NULL OR expires_at > ?) AND max_clicks IS NOT NULL AND clicks >= max_clicks'); params.push(now); break;
      default: break;
    }
    if (before) { where.push('(created_at < ? OR (created_at = ? AND code < ?))'); params.push(before.createdAt, before.createdAt, before.code); }
    const sql = `SELECT ${LinkStore.COLUMNS} FROM links ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, code DESC LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {LinkRow[]} */ (stmt.all(...params, limit));
  }

  /** @param {number} now */
  counts(now) {
    const r = /** @type {{ total: number, active: number|null, clicks: number|null }} */ (this.stmt.counts.get(now));
    return { total: Number(r.total), active: Number(r.active ?? 0), clicks: Number(r.clicks ?? 0) };
  }

  /**
   * Most clicked links since `since`.
   * @param {number} since
   * @param {number} limit
   */
  top(since, limit) {
    return /** @type {{ code: string, url: string, n: number }[]} */ (this.stmt.top.all(since, limit)).map((r) => ({ code: r.code, url: r.url, clicks: Number(r.n) }));
  }
}
