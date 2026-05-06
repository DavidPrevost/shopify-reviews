import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export const getDb = (): Database.Database => {
  if (_db) return _db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  return _db;
};

export const closeDb = (): void => {
  if (_db) {
    _db.close();
    _db = null;
  }
};

export const migrate = (): void => {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    log('warn', 'migrations directory not found', { migrationsDir });
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (db.prepare('SELECT filename FROM _migrations').all() as Array<{ filename: string }>)
      .map((r) => r.filename),
  );

  const insertApplied = db.prepare(
    'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)',
  );

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insertApplied.run(filename, Date.now());
    })();
    log('info', 'migration applied', { filename });
  }
};
