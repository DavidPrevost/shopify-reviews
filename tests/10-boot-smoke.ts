// Boot smoke test: spawn the app with a fresh DB, hit /health, kill it.
// Catches any error during the migrate → ensureCurrentShop → seedDefaults →
// startScheduler boot chain that would prevent the app from coming up.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TestRun, assert, assertEqual } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const run = new TestRun('10-boot-smoke');

// Use a random high port to avoid colliding with anything already running.
const port = 19000 + Math.floor(Math.random() * 1000);
const tmpDir = path.join(os.tmpdir(), `reviews-boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(tmpDir, { recursive: true });

// Hold a reference to the child so we can clean up even if the test throws.
let child: ReturnType<typeof spawn> | null = null;

const cleanup = () => {
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
};

process.on('exit', cleanup);
process.on('uncaughtException', (e) => {
  cleanup();
  throw e;
});

await run.test('App boots, applies migrations, responds to /health within 15s', async () => {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: tmpDir,
    EMAIL_TOKEN_SECRET: '0'.repeat(64),
    PUBLIC_URL: `http://localhost:${port}`,
    STOREFRONT_ORIGIN: 'http://localhost',
    BRAND_NAME: 'boot-test',
    SHOPIFY_SHOP_DOMAIN: 'boot-test.myshopify.com',
    SHOPIFY_CLIENT_ID: 'test_client_id',
    SHOPIFY_WEBHOOK_SECRET: 'test_secret',
    SHOPIFY_ADMIN_TOKEN: '',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'test@example.com',
    SMTP_PASS: 'unused-for-boot',
    SMTP_FROM: 'reviews@example.com',
  };

  // Run the built dist (assumes tests/01 has already built). This avoids the
  // Windows-shell-wrapper-exits-prematurely behavior of spawn-with-shell on
  // npx commands, where `child.on('exit')` fires for the cmd shell while the
  // underlying tsx process keeps running.
  const distEntry = path.join(repoRoot, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    throw new Error(`dist/index.js missing — run \`npm run build\` first (test 01 normally does this).`);
  }
  child = spawn(process.execPath, [distEntry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (b) => { stdout += b.toString(); });
  child.stderr?.on('data', (b) => { stderr += b.toString(); });

  // Wait for the "listening" log line to confirm the server reached its
  // listen step. Then attempt /health.
  const deadline = Date.now() + 20_000;
  let listeningSeen = false;
  let healthOk = false;
  let lastError = '';
  let attempts = 0;
  while (Date.now() < deadline) {
    if (!listeningSeen && stdout.includes('"reviews-app listening"')) {
      listeningSeen = true;
    }
    if (listeningSeen) {
      attempts++;
      for (const host of ['127.0.0.1', 'localhost']) {
        try {
          const res = await fetch(`http://${host}:${port}/health`);
          if (res.ok) {
            const body = await res.json() as { status?: string };
            if (body.status === 'ok') {
              healthOk = true;
              break;
            }
            lastError = `(${host}) health returned ${res.status} with body ${JSON.stringify(body)}`;
          } else {
            lastError = `(${host}) health returned ${res.status}`;
          }
        } catch (e) {
          lastError = `(${host}) ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (healthOk) break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const stdoutSnapshot = stdout.slice(-4000);
  const stderrSnapshot = stderr.slice(-4000);

  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  }

  assert(
    listeningSeen,
    `App never logged "reviews-app listening" within 20s — boot hung before reaching the HTTP server.`,
    { stdoutTail: stdoutSnapshot, stderrTail: stderrSnapshot },
  );

  assert(
    healthOk,
    `App logged that it was listening on port ${port}, but /health didn't return {"status":"ok"} after ${attempts} attempt(s).`,
    { lastError, attempts, port, stdoutTail: stdoutSnapshot, stderrTail: stderrSnapshot },
  );
});

cleanup();
process.exit(run.finish() ? 0 : 1);
