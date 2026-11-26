import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // The library: ESM and CJS, with types for both.
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'node18',
    platform: 'node',
    sourcemap: false,
    clean: true,
    splitting: false,
    treeshake: true,
  },
  {
    // The `lobstr` command: ESM only, its shebang kept.
    entry: { cli: 'src/bin.ts' },
    format: ['esm'],
    dts: false,
    target: 'node18',
    platform: 'node',
    sourcemap: false,
    clean: false,
    splitting: false,
  },
]);
