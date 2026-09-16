import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite connection with schema migrations applied on open. */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [
    `
    CREATE TABLE links (
      code          TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      permanent     INTEGER NOT NULL DEFAULT 0,
      enabled       INTEGER NOT NULL DEFAULT 1,
      expires_at    INTEGER,
      max_clicks    INTEGER,
      clicks        INTEGER NOT NULL DEFAULT 0,
      last_click_at INTEGER,
      tags          TEXT NOT NULL DEFAULT '[]',
      note          TEXT,
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX links_created ON links (created_at DESC, code);
    CREATE INDEX links_expires ON links (expires_at);

    CREATE TABLE clicks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      code      TEXT NOT NULL REFERENCES links(code) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      visitor   TEXT NOT NULL,
      referrer  TEXT,
      device    TEXT NOT NULL
    );
    CREATE INDEX clicks_code_at ON clicks (code, at);
    CREATE INDEX clicks_at ON clicks (at);
    `,
  ];

  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < Database.MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(Database.MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * Run `fn` inside a write transaction; rolls back on throw.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  close() {
    this.raw.close();
  }
}
