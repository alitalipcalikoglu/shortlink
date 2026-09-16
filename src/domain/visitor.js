import { createHmac } from 'node:crypto';

/** @typedef {import('../types.js').Device} Device */

/**
 * Turns request facts into what the click log stores: a keyed hash instead of the address, the
 * referrer's host instead of the full URL, a device class instead of the user agent string.
 */
export class Visitor {
  static BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|fetch|curl|wget|python-requests|go-http-client|headless|monitor|lighthouse|whatsapp|telegram|discord|slack|skype|embedly/i;
  static MOBILE = /mobile|android|iphone|ipad|ipod|windows phone|opera mini|blackberry/i;

  /** @param {string} secret */
  constructor(secret) {
    this.secret = secret;
  }

  /**
   * Stable per (address, agent) pair, unlinkable to the address without the secret.
   * @param {string} ip
   * @param {string} userAgent
   */
  hash(ip, userAgent) {
    return createHmac('sha256', this.secret).update(ip).update('\n').update(userAgent).digest('hex').slice(0, 32);
  }

  /**
   * @param {string} userAgent
   * @returns {Device}
   */
  static device(userAgent) {
    if (!userAgent) return 'other';
    if (Visitor.BOT.test(userAgent)) return 'bot';
    if (Visitor.MOBILE.test(userAgent)) return 'mobile';
    if (/mozilla|chrome|safari|firefox|edge|opera/i.test(userAgent)) return 'desktop';
    return 'other';
  }

  /**
   * Host of the referrer, or null when absent, invalid, or our own.
   * @param {string|undefined} referer
   * @param {string} ownHost
   */
  static referrerHost(referer, ownHost) {
    if (!referer) return null;
    try {
      const host = new URL(referer).hostname.toLowerCase();
      return host && host !== ownHost ? host.slice(0, 253) : null;
    } catch {
      return null;
    }
  }
}
