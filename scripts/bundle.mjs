#!/usr/bin/env node
// Bundles a package entry point for production: workspace packages (@rideo/*, shipped as TypeScript
// source) are inlined; every other dependency stays external and is resolved from node_modules.
// Usage (from a package directory): node ../../scripts/bundle.mjs src/main.ts dist/main.js
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: bundle.mjs <entry.ts> <outfile.js>');
  process.exit(2);
}

const externalDependencies = {
  name: 'external-dependencies',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@rideo/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  plugins: [externalDependencies],
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`bundled ${entry} → ${outfile} (${(bytes / 1024).toFixed(0)} KiB)`);
