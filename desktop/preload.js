'use strict';

/**
 * Minimal preload. The renderer is just the findtalent web app loaded over
 * localhost, so it needs no privileged bridge. contextIsolation stays on and
 * nodeIntegration off (set in main.js) — we deliberately expose nothing.
 */
