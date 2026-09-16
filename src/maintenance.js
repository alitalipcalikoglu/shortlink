/**
 * Periodic retention job: drops click log rows older than the retention window. Counters on
 * the links themselves are kept. Runs once at start and then hourly.
 */
export class Maintenance {
  static INTERVAL_MS = 3_600_000;

  /**
   * @param {object} deps
   * @param {import('./store/click-store.js').ClickStore} deps.clicks
   * @param {import('./types.js').Logger} deps.log
   * @param {{ clickRetentionDays: number }} deps.options
   */
  constructor({ clicks, log, options }) {
    this.clicks = clicks;
    this.log = log;
    this.options = options;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.run();
    this.timer = setInterval(() => this.run(), Maintenance.INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @param {number} [now] */
  run(now = Date.now()) {
    try {
      const deleted = this.clicks.purge(now - this.options.clickRetentionDays * 86_400_000);
      if (deleted) this.log.info({ deleted }, 'retention purge removed click rows');
      return deleted;
    } catch (err) {
      this.log.error({ err }, 'maintenance failed');
      return null;
    }
  }
}
