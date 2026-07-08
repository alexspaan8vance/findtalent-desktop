'use strict';

/**
 * First-run admin bootstrap for findtalent-desktop.
 *
 * Runs once (idempotent) inside the app bundle with the desktop env
 * (DATABASE_URL → local SQLite). If NO user exists yet, it creates a local admin
 * with a RANDOM password and writes the one-time login to
 * `<userData>/FIRST-RUN-LOGIN.txt` (Electron passes FT_FIRST_RUN_FILE). Bob logs
 * in with it once and changes it in Settings. No-ops when a user already exists.
 *
 * Uses the app's own `bcryptjs` (cost 12) so the hash matches web-app login
 * (src/lib/auth-helpers.ts).
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const ADMIN_EMAIL = process.env.FT_ADMIN_EMAIL || 'admin@findtalent.local';
const OUT_FILE = process.env.FT_FIRST_RUN_FILE || null;

(async () => {
  const prisma = new PrismaClient();
  try {
    const count = await prisma.user.count();
    if (count > 0) {
      console.log('[desktop-bootstrap] users exist — skipping admin bootstrap');
      return;
    }
    // Random, human-typable one-time password.
    const password = crypto.randomBytes(9).toString('base64url'); // ~12 chars
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash,
        role: 'ADMIN',
        emailVerifiedAt: new Date(),
      },
    });
    const note =
      `FindTalent — first-run login\n\n` +
      `Email:    ${ADMIN_EMAIL}\n` +
      `Password: ${password}\n\n` +
      `Log in with these, then change your password in Settings.\n` +
      `Next: Admin → Talent pools → Add pool → paste your 8vance client id / secret / company id.\n`;
    if (OUT_FILE) {
      fs.writeFileSync(OUT_FILE, note, { mode: 0o600 });
    }
    console.log(`[desktop-bootstrap] created admin ${ADMIN_EMAIL} (one-time password written)`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('[desktop-bootstrap] failed:', e && e.message ? e.message : e);
  process.exit(1);
});
