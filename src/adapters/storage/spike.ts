import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function storageSpike(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    db.exec('CREATE TABLE IF NOT EXISTS spike_records (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR REPLACE INTO spike_records VALUES (?, ?)').run('transaction', 'committed');
    db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE spike_records SET value=? WHERE id=?').run('must-rollback', 'transaction');
    db.exec('ROLLBACK');
    const record = db.prepare('SELECT value FROM spike_records WHERE id=?').get('transaction');
    if (record?.value !== 'committed') throw new Error('SQLITE_ROLLBACK_FAILED');
    return { driver: 'node:sqlite', sqlite: db.prepare('SELECT sqlite_version() AS version').get()?.version,
      journalMode: db.prepare('PRAGMA journal_mode').get()?.journal_mode, transaction: 'committed-and-rollback-verified' };
  } finally { db.close(); }
}
