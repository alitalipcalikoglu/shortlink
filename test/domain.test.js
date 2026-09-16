import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkError } from '../src/domain/errors.js';
import { LinkService } from '../src/domain/link-service.js';
import { Slug } from '../src/domain/slug.js';
import { Visitor } from '../src/domain/visitor.js';
import { QrCode, QrTooLongError } from '../src/qr/qr-code.js';
import { testService } from './helpers.js';

test('Slug: random codes use the alphabet, validation and reserved words', () => {
  const codes = new Set(Array.from({ length: 200 }, () => Slug.random(7)));
  assert.equal(codes.size, 200);
  for (const c of codes) assert.match(c, /^[A-Za-z0-9]{7}$/);
  assert.equal(Slug.isValid('ab'), false);
  assert.equal(Slug.isValid('-abc'), false);
  assert.equal(Slug.isValid('promo_2026-a'), true);
  assert.equal(Slug.isReserved('V1'), true);
  assert.equal(Slug.isReserved('health'), true);
  assert.equal(Slug.isReserved('promo'), false);
});

test('Visitor: keyed hash, device classes, referrer host', () => {
  const v = new Visitor('secret'.repeat(8));
  assert.equal(v.hash('1.2.3.4', 'ua'), v.hash('1.2.3.4', 'ua'));
  assert.notEqual(v.hash('1.2.3.4', 'ua'), v.hash('1.2.3.5', 'ua'));
  assert.notEqual(v.hash('1.2.3.4', 'ua'), new Visitor('other'.repeat(8)).hash('1.2.3.4', 'ua'));
  assert.equal(v.hash('1.2.3.4', 'ua').length, 32);
  assert.equal(Visitor.device('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1'), 'mobile');
  assert.equal(Visitor.device('Mozilla/5.0 (Macintosh) Chrome/130'), 'desktop');
  assert.equal(Visitor.device('Twitterbot/1.0'), 'bot');
  assert.equal(Visitor.device('curl/8.0'), 'bot');
  assert.equal(Visitor.device(''), 'other');
  assert.equal(Visitor.referrerHost('https://News.Example.com/a?b', 's.test'), 'news.example.com');
  assert.equal(Visitor.referrerHost('https://s.test/x', 's.test'), null);
  assert.equal(Visitor.referrerHost('not a url', 's.test'), null);
  assert.equal(Visitor.referrerHost(undefined, 's.test'), null);
});

test('LinkService: create with random code or slug, validation, status', () => {
  const { service } = testService({ BLOCKED_HOSTS: 'evil.test' });
  const now = 1_700_000_000_000;
  const a = service.create({ url: 'https://example.com/a?x=1' }, 'shop', now);
  assert.match(a.code, /^[A-Za-z0-9]{7}$/);
  assert.equal(a.created_by, 'shop');
  assert.equal(LinkService.status(a, now), 'active');
  const b = service.create({ url: 'https://example.com/b', slug: 'promo', tags: ['B', 'a', 'a '], note: 'n', expiresAt: new Date(now + 1000).toISOString(), maxClicks: 1, permanent: true }, 'shop', now);
  assert.equal(b.code, 'promo');
  assert.equal(b.tags, '["a","b"]');
  assert.equal(b.permanent, 1);
  assert.equal(LinkService.status(b, now + 2000), 'expired');
  assert.equal(LinkService.status({ ...b, clicks: 1 }, now), 'exhausted');
  assert.equal(LinkService.status({ ...b, enabled: 0 }, now), 'disabled');

  const err = (/** @type {() => unknown} */ fn, /** @type {string} */ code) => assert.throws(fn, (e) => e instanceof LinkError && e.code === code, code);
  err(() => service.create({ url: 'https://example.com', slug: 'promo' }, 'shop', now), 'SLUG_TAKEN');
  err(() => service.create({ url: 'https://example.com', slug: 'health' }, 'shop', now), 'SLUG_RESERVED');
  err(() => service.create({ url: 'https://example.com', slug: '-x' }, 'shop', now), 'SLUG_RESERVED');
  err(() => service.create({ url: 'javascript:alert(1)' }, 'shop', now), 'INVALID_URL');
  err(() => service.create({ url: '/relative' }, 'shop', now), 'INVALID_URL');
  err(() => service.create({ url: 'https://user:pw@example.com' }, 'shop', now), 'INVALID_URL');
  err(() => service.create({ url: 'https://s.test/abc' }, 'shop', now), 'INVALID_URL');
  err(() => service.create({ url: 'https://sub.evil.test/x' }, 'shop', now), 'HOST_BLOCKED');
  err(() => service.create({ url: 'https://example.com', expiresAt: 'yesterday' }, 'shop', now), 'INVALID_EXPIRY');
  err(() => service.create({ url: 'https://example.com', expiresAt: new Date(now - 1).toISOString() }, 'shop', now), 'INVALID_EXPIRY');
  err(() => service.get('nope123'), 'LINK_NOT_FOUND');
});

test('LinkService: follow records clicks, bots do not consume the limit, gone states', () => {
  const { service, clicks } = testService();
  const now = 1_700_000_000_000;
  const l = service.create({ url: 'https://example.com/x', slug: 'limited', maxClicks: 2 }, 'shop', now);
  const human = { ip: '203.0.113.1', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130', referer: 'https://news.example/p' };
  assert.deepEqual(service.follow('limited', human, now + 1), { url: 'https://example.com/x', permanent: false });
  service.follow('limited', { ip: '203.0.113.9', userAgent: 'Twitterbot/1.0' }, now + 2);
  service.follow('limited', { ...human, ip: '203.0.113.2' }, now + 3);
  assert.equal(service.get('limited').clicks, 2, 'bot hit not counted');
  assert.throws(() => service.follow('limited', human, now + 4), (e) => e instanceof LinkError && e.code === 'LINK_GONE' && /exhausted/.test(e.message));
  assert.throws(() => service.follow('missing', human, now), (e) => e instanceof LinkError && e.code === 'LINK_GONE' === false && e.code === 'LINK_NOT_FOUND');
  service.update('limited', { enabled: false }, now + 5);
  assert.throws(() => service.follow('limited', human, now + 6), (e) => e instanceof LinkError && /disabled/.test(e.message));
  const st = service.stats('limited', 30, now + 10);
  assert.equal(st.total, 2);
  assert.equal(st.clicks, 3, 'log counts bots');
  assert.equal(st.visitors, 2, 'bots are not visitors');
  assert.equal(st.bots, 1);
  assert.deepEqual(st.byDevice, { bot: 1, desktop: 2 });
  assert.deepEqual(st.byReferrer, [{ referrer: 'news.example', clicks: 2 }]);
  assert.equal(st.byDay.length, 1);
  assert.equal(st.byDay[0].clicks, 2);
  assert.equal(st.recent.length, 3);
  assert.equal(clicks.recent('limited', 1)[0].device, 'desktop');
  assert.equal(l.code, 'limited');
});

test('LinkService: update, remove, list with filters and cursor, overview', () => {
  const { service } = testService();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) service.create({ url: `https://example.com/p${i}`, slug: `link${i}`, tags: i % 2 ? ['odd'] : ['even'] }, i < 3 ? 'shop' : 'worker', now + i);
  service.update('link1', { enabled: false, note: 'off', url: 'https://example.org/new' }, now + 10);
  const l1 = service.get('link1');
  assert.equal(l1.enabled, 0);
  assert.equal(l1.url, 'https://example.org/new');
  assert.equal(l1.note, 'off');
  service.remove('link4');
  assert.throws(() => service.remove('link4'), (e) => e instanceof LinkError && e.code === 'LINK_NOT_FOUND');

  let page = service.list({}, { limit: 2, now });
  assert.deepEqual(page.items.map((r) => r.code), ['link3', 'link2']);
  page = service.list({}, { limit: 2, cursor: /** @type {string} */ (page.nextCursor), now });
  assert.deepEqual(page.items.map((r) => r.code), ['link1', 'link0']);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(service.list({ status: 'disabled' }, { limit: 10, now }).items.map((r) => r.code), ['link1']);
  assert.deepEqual(service.list({ status: 'active' }, { limit: 10, now }).items.map((r) => r.code), ['link3', 'link2', 'link0']);
  assert.deepEqual(service.list({ tag: 'odd' }, { limit: 10, now }).items.map((r) => r.code), ['link3', 'link1']);
  assert.deepEqual(service.list({ q: 'example.org' }, { limit: 10, now }).items.map((r) => r.code), ['link1']);
  assert.deepEqual(service.list({ q: 'link0' }, { limit: 10, now }).items.map((r) => r.code), ['link0']);
  assert.deepEqual(service.list({ q: '%' }, { limit: 10, now }).items, [], 'LIKE wildcards are escaped');
  assert.deepEqual(service.list({ createdBy: 'worker' }, { limit: 10, now }).items.map((r) => r.code), ['link3']);
  assert.throws(() => service.list({}, { limit: 1, cursor: '!!' }), (e) => e instanceof LinkError && e.code === 'INVALID_CURSOR');

  service.follow('link0', { ip: '1.1.1.1', userAgent: 'Mozilla/5.0 Chrome' }, now + 20);
  const o = service.overview(7, now + 30);
  assert.deepEqual(o.links, { total: 4, active: 3, clicks: 1 });
  assert.equal(o.clicksInWindow, 1);
  assert.deepEqual(o.topLinks, [{ code: 'link0', url: 'https://example.com/p0', clicks: 1 }]);
});

test('QrCode: versions, SVG and PNG output, length limit', () => {
  const q = new QrCode('https://s.test/abc1234');
  assert.equal(q.size, q.version * 4 + 17);
  const svg = q.toSvg({ margin: 2 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  const png = q.toPng({ scale: 4, margin: 2 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), (q.size + 4) * 4, 'width = (modules + 2*margin) * scale');
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 0, 'grayscale');
  assert.equal(new QrCode('x'.repeat(213)).version, 10);
  assert.throws(() => new QrCode('x'.repeat(214)), QrTooLongError);
});
