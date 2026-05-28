import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { closeDb, migrate } from './db/client.js';
import { seedDefaultEmailTemplates } from './email/email-config.js';
import { seedDefaultProfanityWordlist } from './lib/profanity.js';
import { ensureCurrentShop } from './lib/tenant.js';
import { log } from './lib/logger.js';
import admin from './routes/admin.js';
import api from './routes/api.js';
import auth from './routes/auth.js';
import proxy from './routes/proxy.js';
import webhooks from './routes/webhooks.js';
import widget from './routes/widget.js';
import { startScheduler } from './scheduler/cron.js';

migrate();
ensureCurrentShop();
seedDefaultEmailTemplates();
seedDefaultProfanityWordlist();
startScheduler();

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/', (c) => c.text('shopify-reviews'));

app.route('/webhooks', webhooks);
app.route('/auth', auth);
app.route('/api', api);
app.route('/admin', admin);
app.route('/proxy', proxy);
app.route('/', widget);

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
