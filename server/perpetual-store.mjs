import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Bounded latest quotes only: no unbounded tick history or writes on page reads. */
export async function openPerpetualStore(filename) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Unsupported perpetual database version');
    db.exec('CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version=1;');
    const upsert = db.prepare('INSERT INTO quotes(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    let closed = false;
    return {
      load() { return db.prepare('SELECT payload FROM quotes').all().map(row => JSON.parse(row.payload)); },
      save(quotes) {
        db.exec('BEGIN IMMEDIATE');
        try { for (const quote of quotes) upsert.run(`${quote.exchange}:${quote.symbol}`, JSON.stringify(quote)); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      prune(exchange, symbols) {
        const remove = db.prepare('DELETE FROM quotes WHERE id=?');
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of db.prepare('SELECT id,payload FROM quotes').all()) {
            const quote = JSON.parse(row.payload);
            if (quote.exchange === exchange && !symbols.has(quote.symbol)) remove.run(row.id);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
