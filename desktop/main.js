'use strict';

/**
 * findtalent-desktop — Electron main process.
 *
 * Wraps the existing Next.js **standalone** server (`node .next/standalone/
 * server.js`) as a local desktop app for a single user (Bob):
 *   1. Store all state under Electron `userData` (per-user, writable): the SQLite
 *      DB + a generated secrets/config file. Nothing secret ships in the app.
 *   2. On first run generate ENCRYPTION_KEY + AUTH_SECRET, run the Prisma
 *      migrations, and bootstrap a local admin account.
 *   3. Spawn the Next server bound to 127.0.0.1 on a free port (never exposed),
 *      wait for /api/health, then open a window to it.
 *   4. Check GitHub Releases for updates (electron-updater) so new versions
 *      install with one click.
 *
 * Bob supplies his OWN 8vance credentials AFTER first launch via the app's
 * existing Admin → add-pool screen (stored encrypted in the local DB).
 */

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

let serverProcess = null;
let mainWindow = null;

// --- Paths: everything the app writes lives under userData -------------------
const USER_DIR = app.getPath('userData');
const DB_PATH = path.join(USER_DIR, 'findtalent.db');
const CONFIG_PATH = path.join(USER_DIR, 'config.json');
const FIRST_RUN_FILE = path.join(USER_DIR, 'FIRST-RUN-LOGIN.txt');
// The packaged app root (unpacked): the Next standalone bundle + prisma live here.
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');
const STANDALONE_SERVER = path.join(APP_ROOT, '.next', 'standalone', 'server.js');
const PRISMA_SCHEMA = path.join(APP_ROOT, 'prisma', 'schema.prisma');
// Pre-migrated template DB shipped in the app; copied to userData on first run.
const TEMPLATE_DB = path.join(APP_ROOT, 'desktop', 'template.db');
// Bundled prisma CLI + schema-engine (for applying NEW migrations on update).
const PRISMA_CLI = path.join(APP_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const SCHEMA_ENGINE_NAME = process.platform === 'win32'
  ? 'schema-engine-windows.exe'
  : process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'schema-engine-darwin-arm64' : 'schema-engine-darwin')
    : 'schema-engine-debian-openssl-3.0.x';
const SCHEMA_ENGINE = path.join(APP_ROOT, 'node_modules', '@prisma', 'engines', SCHEMA_ENGINE_NAME);

/** Load or create the local secrets/config file (never committed anywhere). */
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      /* fall through — regenerate */
    }
  }
  const cfg = {
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    AUTH_SECRET: crypto.randomBytes(32).toString('base64'),
    CRON_SECRET: crypto.randomBytes(16).toString('hex'),
    BRAND_NAME: 'FindTalent',
  };
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

/** Find a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll http://127.0.0.1:port/api/health until green (or time out). */
async function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Build the child-process env: config + local DB + loopback URL. */
function serverEnv(cfg, port) {
  return {
    ...process.env,
    // The packaged app's execPath IS the Electron binary; this flag makes every
    // child spawn (server, prisma migrate, bootstrap) run as plain Node instead
    // of launching a second GUI. Harmless in `desktop:dev` (real node).
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: `file:${DB_PATH}`,
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    ENCRYPTION_KEY: cfg.ENCRYPTION_KEY,
    AUTH_SECRET: cfg.AUTH_SECRET,
    CRON_SECRET: cfg.CRON_SECRET,
    BRAND_NAME: cfg.BRAND_NAME,
    // 8vance creds are NOT set here — Bob adds his pool (creds) via Admin,
    // stored encrypted in the local DB. Billing/mail/cron env stay absent
    // (optional features off by default).
  };
}

/** First run: seed the local DB from the shipped pre-migrated template so a
 *  fresh install needs NO migration engine at all (fast + bulletproof). */
function ensureDatabase() {
  if (fs.existsSync(DB_PATH)) return;
  fs.mkdirSync(USER_DIR, { recursive: true });
  if (fs.existsSync(TEMPLATE_DB)) {
    fs.copyFileSync(TEMPLATE_DB, DB_PATH);
  }
  // If the template is missing (dev), migrate deploy below builds the schema.
}

/** Apply any NEW migrations to an existing DB after an app update. Best-effort:
 *  the shipped template is already current at release time, so a failure here
 *  (e.g. engine missing in dev) must NOT block startup. */
function runMigrations(env) {
  if (!fs.existsSync(PRISMA_CLI)) return; // dev without bundled CLI — template covers it
  const menv = { ...env };
  if (fs.existsSync(SCHEMA_ENGINE)) menv.PRISMA_SCHEMA_ENGINE_BINARY = SCHEMA_ENGINE;
  const res = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', PRISMA_SCHEMA], {
    env: menv,
    cwd: APP_ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    // Fresh installs already have the full schema from the template; log only.
    console.error(`[migrate] deploy exited ${res.status} (continuing — template schema in use)`);
  }
}

/** Bootstrap the local admin on first run (no user yet). Uses the app's own
 *  helper so the hashing + role match the web app exactly. */
function bootstrapAdmin(env) {
  // Runs a tiny node script inside the app bundle so it uses the app's prisma +
  // bcrypt. Idempotent: the helper no-ops when an admin already exists.
  const bootstrap = path.join(APP_ROOT, 'scripts', 'desktop-bootstrap.js');
  if (!fs.existsSync(bootstrap)) return; // built later; skip if absent
  const node = process.execPath;
  // Run inside the standalone bundle so require() resolves the app's prisma +
  // bcryptjs. Pass the one-time-login output path for a fresh install.
  spawnSync(node, [bootstrap], {
    env: { ...env, FT_FIRST_RUN_FILE: FIRST_RUN_FILE },
    cwd: path.join(APP_ROOT, '.next', 'standalone'),
    stdio: 'inherit',
  });
}

/** On a fresh install the bootstrap wrote the one-time admin login — show it
 *  once, then rename it so it isn't shown again (kept on disk for reference). */
function showFirstRunLoginIfAny() {
  if (!fs.existsSync(FIRST_RUN_FILE)) return;
  const text = fs.readFileSync(FIRST_RUN_FILE, 'utf8');
  dialog.showMessageBoxSync({ type: 'info', title: 'FindTalent — first-run login', message: text });
  try {
    fs.renameSync(FIRST_RUN_FILE, path.join(USER_DIR, 'first-run-login.seen.txt'));
  } catch {
    /* leave it */
  }
}

async function startServer() {
  const cfg = loadConfig();
  const port = await freePort();
  const env = serverEnv(cfg, port);

  // First run seeds from the shipped pre-migrated template; updates apply any
  // new migrations best-effort. Then bootstrap the local admin if none exists.
  ensureDatabase();
  runMigrations(env);
  bootstrapAdmin(env);

  serverProcess = spawn(process.execPath, [STANDALONE_SERVER], {
    env,
    cwd: path.join(APP_ROOT, '.next', 'standalone'),
    stdio: 'inherit',
  });
  serverProcess.on('exit', (code) => {
    if (code && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox('FindTalent', `The local server stopped (code ${code}).`);
    }
  });

  const ok = await waitForHealth(port);
  if (!ok) throw new Error('server did not become healthy in time');
  return port;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null); // no dev menu in the shipped app
  mainWindow.loadURL(`http://127.0.0.1:${port}/login`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Open external links in the real browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// electron-updater is required lazily so `npm run desktop:dev` works before it's
// installed; in a packaged build it checks GitHub Releases on launch.
function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-downloaded', async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        title: 'Update ready',
        message: 'A new version of FindTalent has been downloaded. Restart to install?',
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    // Unsigned mac apps can't Squirrel-auto-update — swallow the rejection.
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    /* updater not available — skip */
  }
}

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) serverProcess.kill();
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    showFirstRunLoginIfAny();
    createWindow(port);
    initAutoUpdate();
  } catch (err) {
    dialog.showErrorBox('FindTalent — startup failed', String(err && err.message ? err.message : err));
    app.quit();
  }
});
