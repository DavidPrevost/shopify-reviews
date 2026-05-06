// Manual dispatcher trigger — for testing. Runs one pass and exits.
// Usage: npm run dispatch -- --once

import { migrate, closeDb } from '../db/client.js';
import { runDispatcher } from '../scheduler/dispatcher.js';

const main = async (): Promise<void> => {
  migrate();
  const result = await runDispatcher();
  console.log(JSON.stringify(result, null, 2));
  closeDb();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
