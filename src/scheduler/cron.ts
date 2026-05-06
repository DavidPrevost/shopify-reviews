import cron from 'node-cron';
import { runDispatcher } from './dispatcher.js';
import { log } from '../lib/logger.js';

let _registered = false;

// Default: 14:00 UTC daily — gives the morning fulfillment uploads time to
// land before we ask anyone. Overridable via DISPATCHER_CRON env var.
const DEFAULT_SCHEDULE = '0 14 * * *';

export const startScheduler = (): void => {
  if (_registered) return;
  const expr = process.env.DISPATCHER_CRON ?? DEFAULT_SCHEDULE;

  if (!cron.validate(expr)) {
    log('error', 'invalid DISPATCHER_CRON expression; scheduler not started', { expr });
    return;
  }

  cron.schedule(
    expr,
    () => {
      runDispatcher().catch((err) => {
        log('error', 'scheduled dispatcher run threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    { timezone: 'UTC' },
  );

  _registered = true;
  log('info', 'dispatcher scheduler registered', { schedule: expr, timezone: 'UTC' });
};
