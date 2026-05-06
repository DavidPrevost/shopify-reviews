import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const copies = [
  ['src/db/migrations',    'dist/db/migrations'],
  ['src/email/templates',  'dist/email/templates'],
];

for (const [from, to] of copies) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  try {
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst, { recursive: true });
    console.log(`copied ${from} -> ${to}`);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      console.log(`skip ${from} (not present yet)`);
      continue;
    }
    throw err;
  }
}
