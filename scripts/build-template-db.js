'use strict';

/**
 * Build the pre-migrated template SQLite DB shipped with the desktop app.
 *
 * The desktop app copies this into the user's data dir on first run, so a fresh
 * install needs no migration engine. Run as part of `desktop:build`. Contains
 * ONLY the empty schema + migration history — no user data, no secrets — so it
 * is safe to commit to the public repo.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'desktop', 'template.db');

fs.rmSync(out, { force: true });
fs.rmSync(`${out}-journal`, { force: true });

execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: `file:${out.replace(/\\/g, '/')}` },
});

if (!fs.existsSync(out)) {
  throw new Error(`template DB not created at ${out}`);
}
console.log(`[build-template-db] wrote ${out} (${fs.statSync(out).size} bytes)`);
