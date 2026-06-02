// Build & typecheck integrity. The build pipeline is `tsc` (type-only check
// with --noEmit gating) followed by esbuild (single-bundle for the widget) +
// asset copy. If either fails, every other test is suspect — and any deploy
// would also fail. We run both and report stdout/stderr verbatim on failure.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRun, assert } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const run = new TestRun('01-typecheck-build');

// On Windows, npm/npx are .cmd shims. spawnSync with shell:true handles that.
const npx = (args: string[]) => spawnSync('npx', args, {
  cwd: repoRoot,
  shell: true,
  encoding: 'utf8',
  // Allow up to 60s for the slower of the two (tsc on a clean cache).
  timeout: 120_000,
});

const npm = (args: string[]) => spawnSync('npm', args, {
  cwd: repoRoot,
  shell: true,
  encoding: 'utf8',
  timeout: 180_000,
});

await run.test('tsc --noEmit produces no type errors', () => {
  const result = npx(['tsc', '--noEmit']);
  assert(
    result.status === 0,
    `tsc --noEmit exited with status ${result.status}. The first error usually points at the underlying issue.`,
    {
      stdout: result.stdout.slice(0, 3000),
      stderr: result.stderr.slice(0, 3000),
      signal: result.signal,
    },
  );
});

await run.test('npm run build completes (tsc + esbuild + copy-assets)', () => {
  const result = npm(['run', 'build']);
  assert(
    result.status === 0,
    `npm run build exited with status ${result.status}. Check the failing step (tsc / esbuild / copy-assets).`,
    {
      stdout: result.stdout.slice(0, 3000),
      stderr: result.stderr.slice(0, 3000),
      signal: result.signal,
    },
  );
});

await run.test('dist/index.js exists after build', async () => {
  const fs = await import('node:fs');
  const distEntry = path.join(repoRoot, 'dist', 'index.js');
  assert(
    fs.existsSync(distEntry),
    `Expected dist/index.js to exist after build, but it doesn't. Build may have silently skipped emit.`,
    { distEntry },
  );
});

await run.test('public/widget.js exists after build (esbuild output)', async () => {
  const fs = await import('node:fs');
  const widget = path.join(repoRoot, 'public', 'widget.js');
  assert(
    fs.existsSync(widget),
    `Expected public/widget.js to exist after build. The widget storefront integration relies on this file.`,
    { widget },
  );
});

process.exit(run.finish() ? 0 : 1);
