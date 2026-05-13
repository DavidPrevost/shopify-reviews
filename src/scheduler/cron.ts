import cron, { type ScheduledTask } from 'node-cron';
import { runDispatcher } from './dispatcher.js';
import { getSettingNumber } from '../db/queries.js';
import { log } from '../lib/logger.js';

let _task: ScheduledTask | null = null;

const buildExpression = (): string => {
  const hour = getSettingNumber('dispatcher_hour', 20);
  const minute = getSettingNumber('dispatcher_minute', 17);
  // Clamp to valid ranges in case settings get corrupted.
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  const m = Math.max(0, Math.min(59, Math.floor(minute)));
  return `${m} ${h} * * *`;
};

const startTask = (expr: string): void => {
  if (!cron.validate(expr)) {
    log('error', 'invalid dispatcher schedule; not started', { expr });
    return;
  }
  _task = cron.schedule(
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
  log('info', 'dispatcher scheduler registered', { schedule: expr, timezone: 'UTC' });
};

export const startScheduler = (): void => {
  if (_task) return;
  // DISPATCHER_CRON env var still overrides the DB setting; useful for tests
  // or for forcing a temporary schedule without touching the settings table.
  const expr = process.env.DISPATCHER_CRON ?? buildExpression();
  startTask(expr);
};

// Called by admin settings POST after dispatcher_hour / dispatcher_minute
// are updated. Stops the current task and re-registers with the new schedule
// so changes take effect without a container restart.
export const restartScheduler = (): void => {
  if (_task) {
    _task.stop();
    _task = null;
  }
  startScheduler();
};
