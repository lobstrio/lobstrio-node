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
    // `lobstrio/ai-sdk`: the tools for the Vercel AI SDK. It loads `ai` (an optional peer dependency) and the main
    // entry by the package's own name, so both entries share one client and one set of error classes.
    entry: { 'ai-sdk': 'src/ai-sdk.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'node18',
    platform: 'node',
    sourcemap: false,
    clean: false,
    splitting: false,
    treeshake: true,
    external: ['ai', 'lobstrio'],
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
