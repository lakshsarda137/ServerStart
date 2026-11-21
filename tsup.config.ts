import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    // ink pulls in optional devtools; keep runtime deps external
    external: ['react-devtools-core'],
  },
  {
    entry: { app: 'src/web/app/main.tsx' },
    outDir: 'dist/web',
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    minify: true,
    outExtension: () => ({ js: '.js' }),
    noExternal: [/.*/],
    define: { 'process.env.NODE_ENV': '"production"' },
    onSuccess: async () => {
      mkdirSync('dist/web', { recursive: true });
      cpSync('src/web/app/index.html', 'dist/web/index.html');
      cpSync('src/web/app/styles.css', 'dist/web/styles.css');
    },
  },
]);
