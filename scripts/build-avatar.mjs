import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../.runtime/avatar/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/app/console/avatar-browser.ts'],
  outfile: '.runtime/avatar/avatar.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
