#!/usr/bin/env tsx
/**
 * Cron entrypoint: run all saved searches that haven't been refreshed in
 * the past week. Wire to a host scheduler (e.g. Vercel Cron, systemd
 * timer, GitHub Actions on schedule).
 *
 * Usage:
 *   npx tsx scripts/saved-search-tick.ts
 *   npx tsx scripts/saved-search-tick.ts --hours=24
 */
import { runAllDueSavedSearches } from '../src/lib/saved-search/runner';

function readHoursArg(): number {
  const arg = process.argv.find((a) => a.startsWith('--hours='));
  if (!arg) return 168;
  const v = Number.parseInt(arg.split('=')[1] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 168;
}

async function main() {
  const hours = readHoursArg();
  // eslint-disable-next-line no-console
  console.log(`[saved-search-tick] running due searches (>= ${hours}h old)`);
  const results = await runAllDueSavedSearches(hours);
  // eslint-disable-next-line no-console
  console.log(
    `[saved-search-tick] ran ${results.length} searches, ${results.filter((r) => r.notified).length} notifications sent`,
  );
  if (results.length > 0) {
    // eslint-disable-next-line no-console
    console.table(results);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
