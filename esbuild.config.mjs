import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

// The widget detects its API base at runtime from its own script src, so the
// bundle is environment-agnostic — the same artifact works on dev and prod
// stacks without needing PUBLIC_URL at build time. Styles are now inlined
// inside widget.ts and injected via a <style> tag at init time, so there's no
// separate widget.css to ship or link.

await mkdir(path.join(root, 'public'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/widget/widget.ts')],
  outfile: path.join(root, 'public/widget.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  logLevel: 'info',
});

console.log('widget bundle built (API base detected at runtime from script src; styles inlined)');
