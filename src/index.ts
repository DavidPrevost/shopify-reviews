import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { closeDb, migrate } from './db/client.js';
import { log } from './lib/logger.js';

migrate();

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/', (c) => c.text('shopify-reviews'));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log('info', 'reviews-app listening', { port: info.port });
});

const shutdown = (signal: string) => {
  log('info', 'shutting down', { signal });
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force-exit after 5s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
