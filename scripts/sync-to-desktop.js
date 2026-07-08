'use strict';

/**
 * Sync the findtalent app + Electron wrapper into the PUBLIC findtalent-desktop
 * repo. Copies only public-safe files: no secrets, no v2match, no private git
 * history, no build artifacts, no local DBs (except the safe pre-migrated
 * desktop/template.db).
 *
 *   node scripts/sync-to-desktop.js [DEST]   # DEST defaults to ../findtalent-desktop
 *
 * Then: cd DEST && git add -A && git commit -m "release: vX.Y.Z"
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');
const DEST = path.resolve(process.argv[2] || path.join(SRC, '..', 'findtalent-desktop'));

// Directory names skipped anywhere in the tree.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist-desktop', 'services',
  'e2e-report', 'e2e-screenshots', 'test-results', 'visual-shots', '__pycache__',
]);
// Exact top-level entries skipped (private / secret / project-local).
const SKIP_TOP = new Set(['.env', 'CLAUDE.md', 'AGENTS.md', 'tsconfig.tsbuildinfo']);

/** true = copy this entry. */
function allow(rel, name, isDir) {
  if (isDir && SKIP_DIRS.has(name)) return false;
  if (SKIP_TOP.has(rel)) return false;
  if (name.startsWith('.env') && name !== '.env.example') return false;
  // Drop any SQLite DB except the safe shipped template.
  if (/\.db(-journal)?$/.test(name) && rel !== path.join('desktop', 'template.db')) return false;
  return true;
}

function copyTree(srcDir, destDir, relBase = '') {
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relBase ? path.join(relBase, ent.name) : ent.name;
    if (!allow(rel, ent.name, ent.isDirectory())) continue;
    const s = path.join(srcDir, ent.name);
    const d = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyTree(s, d, rel);
    else fs.copyFileSync(s, d);
  }
}

// Clean dest of tracked files (keep its .git) then re-copy.
if (fs.existsSync(DEST)) {
  for (const ent of fs.readdirSync(DEST)) {
    if (ent === '.git') continue;
    fs.rmSync(path.join(DEST, ent), { recursive: true, force: true });
  }
}
copyTree(SRC, DEST);
console.log(`synced → ${DEST}`);
console.log(`next: cd "${DEST}" && git add -A && git commit -m "release: vX.Y.Z"`);
