import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { LinkService } from '../src/domain/link-service.js';
import { Visitor } from '../src/domain/visitor.js';
import { ClickStore } from '../src/store/click-store.js';
import { LinkStore } from '../src/store/link-store.js';

/**
 * Real cross-connection concurrency worker (Stage 10): its own OS thread, its own `Database`/
 * `DatabaseSync` connection to the SAME on-disk file another worker (and the main thread) also
 * hold open — genuine multi-connection contention over SQLite's own file locking (WAL +
 * busy_timeout, see src/db.js), not in-process pseudo-concurrency sharing one JS object.
 */
const { dbPath, code, hashSecret, now, workerId } = /** @type {{ dbPath: string, code: string, hashSecret: string, now: number, workerId: number }} */ (workerData);

const db = new Database(dbPath);
const service = new LinkService({
  db,
  links: new LinkStore(db),
  clicks: new ClickStore(db),
  visitor: new Visitor(hashSecret),
  options: { codeLength: 7, publicHost: 's.test', blockedHosts: [], maxUrlLength: 4096, defaultPermanent: false },
});

/** @type {{ ok: true }|{ ok: false, code: string|null, message: string }} */
let outcome;
try {
  service.follow(code, { ip: `10.0.${workerId >> 8}.${workerId & 0xff}`, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) real-browser-ua' }, now);
  outcome = { ok: true };
} catch (err) {
  outcome = { ok: false, code: /** @type {any} */ (err)?.code ?? null, message: err instanceof Error ? err.message : String(err) };
}
parentPort?.postMessage(outcome);
