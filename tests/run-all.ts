// Orchestrator: runs every NN-*.ts test file in this directory in order,
// captures stdout/stderr/exit-code, and prints a final summary.
//
// Each test file is its own subprocess. Failures in one file don't stop the
// next file from running — we want the full picture in one shot.

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const testFiles = fs.readdirSync(__dirname)
  .filter((f) => /^\d{2}-.+\.ts$/.test(f))
  .sort();

interface Result {
  file: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const results: Result[] = [];

console.log(`\nRunning ${testFiles.length} test files...\n`);

for (const file of testFiles) {
  const fullPath = path.join(__dirname, file);
  const start = Date.now();
  const r = spawnSync('npx', ['tsx', fullPath], {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    timeout: 300_000,
  });
  const durationMs = Date.now() - start;
  // Pipe stdout/stderr through to our own so the user sees per-test results live-ish.
  // (spawnSync collects then returns; for streaming we'd use spawn. Acceptable here.)
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  results.push({
    file,
    exitCode: r.status ?? -1,
    durationMs,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  });
}

// --- Final summary ---
console.log('\n');
console.log('='.repeat(64));
console.log('SUMMARY');
console.log('='.repeat(64));

let totalFailed = 0;
for (const r of results) {
  const ok = r.exitCode === 0;
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) totalFailed++;
  console.log(`${tag.padEnd(6)} ${r.file.padEnd(36)} ${r.durationMs.toString().padStart(6)}ms  exit=${r.exitCode}`);
}

console.log('='.repeat(64));
if (totalFailed === 0) {
  console.log(`ALL ${results.length} test files passed.`);
  process.exit(0);
} else {
  console.log(`${totalFailed} of ${results.length} test files FAILED.`);
  process.exit(1);
}
