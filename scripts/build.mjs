// Build library ESM + declarations with tsc, then overwrite the Node CLI
// entry with a bundled executable. The Worker target can still be built by
// wrangler directly from src/worker.ts, but dist/worker.js is also emitted for
// package consumers via tsc.
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const OUT = 'dist';
if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
  shell: false,
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
console.log('✓ emitted dist/ library modules + declarations');

await build({
  entryPoints: ['src/node.ts'],
  outfile: 'dist/node.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  // Atlas is inlined as a base64 string in src/core/atlas.ts, so no external assets.
  external: [],
  banner: { js: '#!/usr/bin/env node' },
});

console.log('✓ built dist/node.js');
