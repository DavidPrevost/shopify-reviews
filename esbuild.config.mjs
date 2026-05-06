import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

// API base URL is baked into the widget bundle at build time. Override via
// REVIEWS_API_BASE env var; defaults to PUBLIC_URL for production builds.
const apiBase =
  process.env.REVIEWS_API_BASE
  ?? process.env.PUBLIC_URL
  ?? 'https://reviews.brandname.com';

await mkdir(path.join(root, 'public'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/widget/widget.ts')],
  outfile: path.join(root, 'public/widget.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  define: {
    __REVIEWS_API_BASE__: JSON.stringify(apiBase.replace(/\/+$/, '')),
  },
  logLevel: 'info',
});

await cp(
  path.join(root, 'src/widget/widget.css'),
  path.join(root, 'public/widget.css'),
);

console.log(`widget bundle built (api base: ${apiBase})`);
