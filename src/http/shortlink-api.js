import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '../net/audit-client.js';
import { LinkError } from '../domain/errors.js';
import { LinkService } from '../domain/link-service.js';
import { Slug } from '../domain/slug.js';
import { QrCode, QrTooLongError } from '../qr/qr-code.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { PreviewPage } from './preview-page.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */
/** @typedef {import('fastify').FastifyReply} FastifyReply */

/**
 * HTTP surface: a public side (redirects, previews, QR images, rate limited per address) and a
 * management API under /v1 for callers holding an API key.
 */
export class ShortlinkApi {
  static READY_CACHE_MS = 10_000;
  static QR_CACHE = 'public, max-age=86400';

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {LinkService} deps.service
   * @param {import('../store/link-store.js').LinkStore} deps.links
   * @param {import('../store/click-store.js').ClickStore} deps.clicks
   * @param {import('../db.js').Database} deps.db
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('../net/audit-client.js').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, links, clicks, db, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.links = links;
    this.clicks = clicks;
    this.db = db;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    this.views = new Views(config.publicBaseUrl);
    this.readyCache = { at: 0, ok: false, error: '' };
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      loggerInstance: this.logger,
      logger: this.logger ? undefined : { level: config.logLevel, redact: ['req.headers.authorization'] },
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    app.decorateRequest('apiKeyId', '');
    app.decorateRequest('apiKeyRole', 'read');
    app.setErrorHandler(this.#errorHandler);
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    this.#registerProbes(app);
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    await app.register((pub) => this.#registerPublic(pub));
    return app;
  }

  /** @type {FastifyInstance['errorHandler']} */
  #errorHandler = (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (err instanceof LinkError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err instanceof QrTooLongError) return reply.code(400).send({ error: { code: 'QR_TOO_LONG', message: err.message } });
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? 'REQUEST_ERROR', message: err.message } });
  };

  /** @param {FastifyInstance} app */
  #registerProbes(app) {
    app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
    app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
      const ready = this.#readiness();
      if (!ready.ok) {
        app.log.warn({ error: ready.error }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', error: ready.error });
      }
      return { status: 'ok' };
    });
    app.get('/robots.txt', { logLevel: 'warn' }, async (_request, reply) => {
      reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400');
      return 'User-agent: *\nDisallow: /\n';
    });
  }

  #readiness() {
    const now = Date.now();
    if (now - this.readyCache.at > ShortlinkApi.READY_CACHE_MS) {
      try {
        this.db.ping();
        this.readyCache = { at: now, ok: true, error: '' };
      } catch (err) {
        this.readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return this.readyCache;
  }

  /**
   * QR image response with a strong ETag; identical content and options never re-encode on the client.
   * @param {FastifyRequest} request
   * @param {FastifyReply} reply
   * @param {string} text
   * @param {{ format?: string, scale?: string, margin?: string }} q
   */
  static qr(request, reply, text, q) {
    const format = q.format ?? 'svg';
    const scale = q.scale ? Number(q.scale) : 8;
    const margin = q.margin ? Number(q.margin) : 4;
    const etag = `"${createHash('sha1').update(`${format}|${scale}|${margin}|${text}`).digest('base64url')}"`;
    reply.header('cache-control', ShortlinkApi.QR_CACHE).header('etag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    const qr = new QrCode(text);
    if (format === 'png') return reply.type('image/png').send(qr.toPng({ scale, margin }));
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.type('image/svg+xml; charset=utf-8').send(qr.toSvg({ margin }));
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKeyId,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };
    const code = (/** @type {FastifyRequest} */ r) => /** @type {{ code: string }} */ (r.params).code;

    api.post('/links', { config: { audit: AuditClient.route('shortlink.link.create', (_r, b) => ({ type: 'link', id: b.link.code })) }, ...write, schema: { body: Schemas.create } }, async (request, reply) => {
      const row = s.create(/** @type {any} */ (request.body), request.apiKeyId);
      reply.header('location', `/v1/links/${row.code}`);
      return reply.code(201).send({ link: this.views.link(row) });
    });

    api.get('/links', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {Record<string, string|undefined>} */ (request.query);
      const { items, nextCursor } = s.list({ q: q.q, tag: q.tag, status: /** @type {any} */ (q.status), createdBy: q.createdBy }, { limit: q.limit ? Number(q.limit) : 50, cursor: q.cursor });
      const now = Date.now();
      return { items: items.map((r) => this.views.link(r, now)), nextCursor };
    });

    api.get('/links/:code', { ...read, schema: { params: Schemas.codeParams } }, async (request) => ({ link: this.views.link(s.get(code(request))) }));

    api.patch('/links/:code', { config: { audit: AuditClient.route('shortlink.link.update', (r) => ({ type: 'link', id: /** @type {any} */ (r.params).code }), (r) => ({ patch: r.body })) }, ...write, schema: { params: Schemas.codeParams, body: Schemas.patch } }, async (request) => ({
      link: this.views.link(s.update(code(request), /** @type {any} */ (request.body))),
    }));

    api.delete('/links/:code', { config: { audit: AuditClient.route('shortlink.link.delete', (r) => ({ type: 'link', id: /** @type {any} */ (r.params).code })) }, ...write, schema: { params: Schemas.codeParams } }, async (request, reply) => {
      s.remove(code(request));
      return reply.code(204).send();
    });

    api.get('/links/:code/stats', { ...read, schema: { params: Schemas.codeParams, querystring: Schemas.daysQuery } }, async (request) => {
      const q = /** @type {{ days?: string }} */ (request.query);
      const st = s.stats(code(request), q.days ? Number(q.days) : 30);
      return { ...st, since: new Date(st.since).toISOString(), recent: st.recent.map(Views.click) };
    });

    api.get('/links/:code/qr', { ...read, schema: { params: Schemas.codeParams, querystring: Schemas.qrQuery } }, async (request, reply) => {
      const row = s.get(code(request));
      return ShortlinkApi.qr(request, reply, `${this.config.publicBaseUrl}/${row.code}`, /** @type {any} */ (request.query));
    });

    api.get('/qr', { ...read, schema: { querystring: Schemas.qrTextQuery } }, async (request, reply) => {
      const q = /** @type {{ text: string, format?: string, scale?: string, margin?: string }} */ (request.query);
      return ShortlinkApi.qr(request, reply, q.text, q);
    });

    api.get('/stats', { ...read, schema: { querystring: Schemas.daysQuery } }, async (request) => {
      const q = /** @type {{ days?: string }} */ (request.query);
      const o = s.overview(q.days ? Number(q.days) : 7);
      return { ...o, since: new Date(o.since).toISOString(), topLinks: o.topLinks.map((l) => ({ ...l, shortUrl: `${this.config.publicBaseUrl}/${l.code}` })) };
    });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const now = Date.now();
      const c = this.links.counts(now);
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP shortlink_links Links by state.',
        '# TYPE shortlink_links gauge',
        `shortlink_links{state="active"} ${c.active}`,
        `shortlink_links{state="inactive"} ${c.total - c.active}`,
        '# HELP shortlink_clicks_total Counted clicks over all links (bots excluded).',
        '# TYPE shortlink_clicks_total gauge',
        `shortlink_clicks_total ${c.clicks}`,
        '# HELP shortlink_clicks_last_hour Click log rows in the last hour (bots included).',
        '# TYPE shortlink_clicks_last_hour gauge',
        `shortlink_clicks_last_hour ${this.clicks.countSince(now - 3_600_000)}`,
        '# HELP shortlink_click_rows Rows in the click log.',
        '# TYPE shortlink_click_rows gauge',
        `shortlink_click_rows ${this.clicks.count()}`,
        '# HELP shortlink_process_uptime_seconds Process uptime.',
        '# TYPE shortlink_process_uptime_seconds gauge',
        `shortlink_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }

  /**
   * Public routes: no key, rate limited per client address.
   * @param {FastifyInstance} pub
   */
  async #registerPublic(pub) {
    await pub.register(rateLimit, {
      max: this.config.redirectRateLimitMax,
      timeWindow: '1 minute',
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;

    /** Public codes are looked up only when they have the shape of a code; anything else is simply unknown. */
    const codeOf = (/** @type {FastifyRequest} */ request) => {
      const raw = /** @type {{ code: string }} */ (request.params).code;
      const preview = raw.endsWith('+');
      const code = preview ? raw.slice(0, -1) : raw;
      if (!Slug.isValid(code)) throw new LinkError('LINK_NOT_FOUND', 'link not found');
      return { code, preview };
    };

    pub.get('/:code/qr', { schema: { params: Schemas.publicParams, querystring: Schemas.qrQuery }, logLevel: 'warn' }, async (request, reply) => {
      const row = s.get(codeOf(request).code);
      if (LinkService.status(row) !== 'active') throw new LinkError('LINK_GONE', 'link is not active');
      return ShortlinkApi.qr(request, reply, `${this.config.publicBaseUrl}/${row.code}`, /** @type {any} */ (request.query));
    });

    const follow = async (/** @type {FastifyRequest} */ request, /** @type {FastifyReply} */ reply) => {
      const { code, preview } = codeOf(request);
      if (preview) {
        const row = s.get(code);
        const v = this.views.link(row);
        reply.header('content-security-policy', PreviewPage.CSP).header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY');
        return reply.type('text/html; charset=utf-8').send(PreviewPage.render(v));
      }
      const ua = request.headers['user-agent'];
      const referer = request.headers.referer;
      const { url, permanent } = s.follow(code, { ip: request.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : '', referer: typeof referer === 'string' ? referer : undefined });
      reply.header('referrer-policy', 'no-referrer-when-downgrade');
      reply.header('cache-control', permanent ? 'public, max-age=86400' : 'private, max-age=0, no-cache');
      return reply.redirect(url, permanent ? 301 : 302);
    };
    pub.get('/:code', { schema: { params: Schemas.publicParams } }, follow);
  }
}
