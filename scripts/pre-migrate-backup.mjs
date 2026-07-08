// Pre-migration SQLite snapshot helper (invoked by docker-entrypoint.sh).
//
// Produces a *consistent* copy of the live SQLite database via `VACUUM INTO`,
// which holds a read transaction and folds in any pending WAL frames — unlike a
// raw `cp` of the `.db` file, which can miss committed-but-uncheckpointed WAL
// data and yield a torn/stale snapshot.
//
// Uses the built-in `node:sqlite` module (Node >= 22.5), so the runtime image
// needs neither the `sqlite3` CLI nor any extra npm/apt dependency. The
// entrypoint only calls this when a non-empty DB already exists, so this never
// creates a fresh DB file.
//
// Usage: node scripts/pre-migrate-backup.mjs <db-path> <backup-path>
// Exit codes: 0 = snapshot written; non-zero = failure (entrypoint aborts the
// migrate on an existing non-empty DB rather than risk corrupting it).

import { DatabaseSync } from 'node:sqlite';

const [dbPath, backupPath] = process.argv.slice(2);

if (!dbPath || !backupPath) {
  console.error('[pre-migrate-backup] usage: node pre-migrate-backup.mjs <db> <backup>');
  process.exit(2);
}

// VACUUM INTO takes a single-quoted string literal path; escape any embedded
// single quotes by doubling them (SQL string-literal escaping).
const target = String(backupPath).replace(/'/g, "''");

let db;
try {
  // Open read-write (default). VACUUM only reads the source and writes the new
  // target file, but some SQLite builds want a writable connection for VACUUM.
  db = new DatabaseSync(dbPath);
  db.exec(`VACUUM INTO '${target}'`);
} catch (err) {
  console.error(`[pre-migrate-backup] snapshot failed: ${err?.message ?? err}`);
  process.exit(1);
} finally {
  try {
    db?.close();
  } catch {
    // best-effort close; ignore
  }
}
