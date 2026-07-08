'use strict';

/**
 * electron-builder afterPack hook.
 *
 * electron-builder manages `node_modules` itself and STRIPS nested node_modules
 * out of `extraResources` copies — which would drop the Next standalone's traced
 * runtime deps (@prisma/client + query engine) and break the app. So instead of
 * relying on extraResources for the app payload, we copy it verbatim here, after
 * packaging, straight into resources/app.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Recursive copy that preserves nested node_modules (fs.cpSync, Node 16+). */
function copy(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[after-pack] skip missing ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

exports.default = async function afterPack(context) {
  const projectRoot = path.resolve(__dirname, '..');
  const appOut = context.appOutDir; // e.g. dist-desktop/win-unpacked
  const appRoot = path.join(appOut, 'resources', 'app');

  const items = [
    ['.next/standalone', '.next/standalone'], // includes its node_modules (prisma runtime)
    ['.next/static', '.next/standalone/.next/static'],
    ['public', '.next/standalone/public'],
    ['prisma', 'prisma'],
    ['scripts/desktop-bootstrap.js', 'scripts/desktop-bootstrap.js'],
    ['desktop/template.db', 'desktop/template.db'],
    ['desktop/main.js', 'desktop/main.js'],
    ['desktop/preload.js', 'desktop/preload.js'],
    ['node_modules/prisma', 'node_modules/prisma'],
    ['node_modules/@prisma/engines', 'node_modules/@prisma/engines'],
  ];
  for (const [from, to] of items) {
    copy(path.join(projectRoot, from), path.join(appRoot, to));
  }

  // Sanity: the two things that MUST be present for the app to run.
  const mustExist = [
    path.join(appRoot, '.next/standalone/server.js'),
    path.join(appRoot, '.next/standalone/node_modules/@prisma/client'),
    path.join(appRoot, '.next/standalone/node_modules/.prisma/client/query_engine-windows.dll.node'),
    path.join(appRoot, 'desktop/template.db'),
  ];
  const missing = mustExist.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new Error(`[after-pack] payload incomplete:\n  ${missing.join('\n  ')}`);
  }
  console.log('[after-pack] app payload assembled OK');
};
