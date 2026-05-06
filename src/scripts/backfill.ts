// CLI entry: npm run backfill -- --days 90
//
// Pages through Shopify orders since the cutoff date, upserts customers and
// purchases, and seeds due_at on already-fulfilled orders so they enter the
// review-request cadence on the next dispatcher run.

import { backfillRecentOrders } from '../shopify/sync.js';

const parseDays = (): number => {
  const idx = process.argv.indexOf('--days');
  if (idx === -1) return 90;
  const next = process.argv[idx + 1];
  const n = next ? Number(next) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    console.error('--days requires a positive number');
    process.exit(2);
  }
  return n;
};

const main = async (): Promise<void> => {
  const days = parseDays();
  const result = await backfillRecentOrders(days);
  console.log(JSON.stringify(result, null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
