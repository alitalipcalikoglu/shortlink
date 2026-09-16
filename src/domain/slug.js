import { randomBytes } from 'node:crypto';

/**
 * Short codes: random base62 of a configured length, or caller-chosen slugs. Paths the service
 * uses itself are reserved so a slug can never shadow an endpoint.
 */
export class Slug {
  static ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  static PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
  static RESERVED = new Set(['v1', 'health', 'ready', 'metrics', 'qr', 'api', 'admin', 'favicon.ico', 'robots.txt', 'sitemap.xml', '.well-known']);

  /**
   * Unbiased random code: bytes >= 248 are rejected instead of taken modulo 62.
   * @param {number} length
   */
  static random(length) {
    let out = '';
    while (out.length < length) {
      for (const b of randomBytes(length * 2)) {
        if (b < 248) out += Slug.ALPHABET[b % 62];
        if (out.length === length) break;
      }
    }
    return out;
  }

  /** @param {string} slug */
  static isValid(slug) {
    return Slug.PATTERN.test(slug);
  }

  /** @param {string} slug */
  static isReserved(slug) {
    return Slug.RESERVED.has(slug.toLowerCase());
  }
}
