import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { LinkStore } from '../src/store/link-store.js';

/**
 * Stage 10: maxClicks correctness under REAL concurrency — separate OS threads, separate
 * `DatabaseSync` connections, the same on-disk file. This is the thing a single-process,
 * single-connection test cannot prove: `LinkStore#hitIfActive`'s atomicity has to come from SQLite
 * itself (WAL + busy_timeout serializing writers across connections/processes), not from anything
 * process-local — no mutex, no in-process lock, would even be running here to hide behind.
 */
const WORKER_PATH = new URL('./concurrency-worker.js', import.meta.url);
const HASH_SECRET = 'h'.repeat(40);

/**
 * Best-effort teardown: a worker's SQLite connection (WAL/SHM sidecar files) can release its file
 * handle a moment after `Worker#terminate()` resolves, so an immediate `rmSync` can occasionally
 * race a not-yet-released handle. Retried briefly; a leftover temp dir is harmless (OS temp
 * cleanup), so this never turns into a false test failure over teardown timing.
 * @param {string} dir
 */
function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * @param {string} dbPath
 * @param {string} code
 * @param {number|null} maxClicks
 */
function seed(dbPath, code, maxClicks) {
  const db = new Database(dbPath);
  const now = Date.now();
  new LinkStore(db).insert({
    code, url: 'https://example.com/x', permanent: 0, enabled: 1, expires_at: null,
    max_clicks: maxClicks, tags: '[]', note: null, created_by: 'test', created_at: now, updated_at: now,
  });
  return now;
}

/**
 * @param {string} dbPath
 * @param {string} code
 * @param {number} now
 * @param {number} n
 */
function runConcurrent(dbPath, code, now, n) {
  return Promise.all(Array.from({ length: n }, (_, workerId) => new Promise((resolve, reject) => {
    const w = new Worker(WORKER_PATH, { workerData: { dbPath, code, hashSecret: HASH_SECRET, now, workerId } });
    w.once('message', (/** @type {any} */ msg) => { resolve(msg); w.terminate(); });
    w.once('error', reject);
  })));
}

test('maxClicks=1: two concurrent resolves from separate connections — exactly one succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shortlink-cc-'));
  try {
    const dbPath = join(dir, 'links.db');
    const now = seed(dbPath, 'onlyone', 1);
    const results = /** @type {any[]} */ (await runConcurrent(dbPath, 'onlyone', now, 2));
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    assert.equal(successes.length, 1, `expected exactly 1 success, got ${JSON.stringify(results)}`);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'LINK_GONE');
    assert.equal(failures[0].message, 'link is exhausted');
  } finally { cleanupDir(dir); }
});

test('maxClicks=N under high concurrency: exactly N of many concurrent resolves succeed, the rest deterministically LINK_GONE/exhausted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shortlink-cc-'));
  try {
    const dbPath = join(dir, 'links.db');
    const N = 10;
    const CONCURRENCY = 40;
    const now = seed(dbPath, 'manyclicks', N);
    const results = /** @type {any[]} */ (await runConcurrent(dbPath, 'manyclicks', now, CONCURRENCY));
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    assert.equal(successes.length, N, `expected exactly ${N} successes out of ${CONCURRENCY}, got ${successes.length}`);
    assert.equal(failures.length, CONCURRENCY - N);
    assert.ok(failures.every((r) => r.code === 'LINK_GONE' && r.message === 'link is exhausted'), 'every rejected attempt is a deterministic, correctly-classified failure, never a crash or a generic error');
  } finally { cleanupDir(dir); }
});

test('unlimited (maxClicks=null): concurrent resolves never fail on the limit — every one of them succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shortlink-cc-'));
  try {
    const dbPath = join(dir, 'links.db');
    const CONCURRENCY = 20;
    const now = seed(dbPath, 'unlimited', null);
    const results = /** @type {any[]} */ (await runConcurrent(dbPath, 'unlimited', now, CONCURRENCY));
    assert.equal(results.filter((r) => r.ok).length, CONCURRENCY);
  } finally { cleanupDir(dir); }
});

test('not-found and expired are still distinguished from exhausted under the new atomic path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shortlink-cc-'));
  try {
    const dbPath = join(dir, 'links.db');
    const db = new Database(dbPath);
    const links = new LinkStore(db);
    const now = Date.now();
    links.insert({ code: 'stale', url: 'https://example.com/x', permanent: 0, enabled: 1, expires_at: now - 1000, max_clicks: null, tags: '[]', note: null, created_by: 'test', created_at: now, updated_at: now });
    const results = /** @type {any[]} */ (await runConcurrent(dbPath, 'stale', now, 3));
    assert.ok(results.every((r) => !r.ok && r.code === 'LINK_GONE' && r.message === 'link is expired'));
    const missing = /** @type {any[]} */ (await runConcurrent(dbPath, 'doesnotexist', now, 3));
    assert.ok(missing.every((r) => !r.ok && r.code === 'LINK_NOT_FOUND'));
  } finally { cleanupDir(dir); }
});
