/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.redirectRateLimitMax = v.redirectRateLimitMax;
    this.publicBaseUrl = v.publicBaseUrl;
    this.codeLength = v.codeLength;
    this.hashSecret = v.hashSecret;
    this.clickRetentionDays = v.clickRetentionDays;
    this.blockedHosts = v.blockedHosts;
    this.maxUrlLength = v.maxUrlLength;
    this.defaultPermanent = v.defaultPermanent;
    Object.freeze(this);
  }

  /** Host part of the public base URL, lower-case. */
  get publicHost() {
    return new URL(this.publicBaseUrl).hostname.toLowerCase();
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const publicBaseUrl = Config.#origin(r.required('PUBLIC_BASE_URL'), 'PUBLIC_BASE_URL');
    const hashSecret = r.required('HASH_SECRET');
    if (hashSecret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`HASH_SECRET must be at least ${Config.MIN_SECRET_LENGTH} characters`);

    return new Config({
      port: r.integer('PORT', 3006, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      bodyLimit: r.integer('BODY_LIMIT', 16_384, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/shortlink.db',
      apiKeys: Config.#parseApiKeys(r.required('SHORTLINK_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      redirectRateLimitMax: r.integer('REDIRECT_RATE_LIMIT_MAX', 300, { min: 1 }),
      publicBaseUrl,
      codeLength: r.integer('CODE_LENGTH', 7, { min: 4, max: 16 }),
      hashSecret,
      clickRetentionDays: r.integer('CLICK_RETENTION_DAYS', 365, { min: 1 }),
      blockedHosts: r.optional('BLOCKED_HOSTS').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
      maxUrlLength: r.integer('MAX_URL_LENGTH', 2_048, { min: 64, max: 8_192 }),
      defaultPermanent: r.boolean('DEFAULT_PERMANENT', false),
    });
  }

  /**
   * @param {string} value
   * @param {string} name
   */
  static #origin(value, name) {
    let u;
    try {
      u = new URL(value);
    } catch {
      throw new ConfigError(`${name} must be an absolute URL`);
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      throw new ConfigError(`${name} must be a bare origin like https://s.example.com`);
    }
    return u.origin;
  }

  /**
   * Parse `id:secret[:role],…`. Role defaults to `readwrite`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3) throw new ConfigError(`SHORTLINK_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret[:role]`);
      const [id, secret, role = 'readwrite'] = parts;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError(`SHORTLINK_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`SHORTLINK_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      if (role !== 'read' && role !== 'write' && role !== 'readwrite') throw new ConfigError(`SHORTLINK_API_KEYS role for "${id}" must be read, write or readwrite`);
      return { id, secret, role: /** @type {KeyRole} */ (role) };
    });
    if (keys.length === 0) throw new ConfigError('SHORTLINK_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('SHORTLINK_API_KEYS ids must be unique');
    if (new Set(keys.map((k) => k.secret)).size !== keys.length) throw new ConfigError('SHORTLINK_API_KEYS secrets must be unique');
    return keys;
  }
}

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }
}
