#!/usr/bin/env node
// Builds the studio library (docs/design/embedding.md#package): dist-lib/ with rideo.js, rideo.css, the declarations
// and a package.json, ready for `npm publish packages/web/dist-lib`.
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scopeCss } from './scope-css.mjs';

const web = resolve(import.meta.dirname, '..');
const out = join(web, 'dist-lib');
const types = join(web, 'build', 'types');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: web, stdio: 'inherit' });

run('npx', ['vite', 'build', '--config', 'vite.lib.config.ts']);
// the stylesheet only styles the studio's container, and the host's global styles do not bend it
const css = join(out, 'rideo.css');
await writeFile(css, scopeCss(await readFile(css, 'utf8')));
await rm(types, { recursive: true, force: true });
run('npx', ['tsc', '-p', 'tsconfig.lib.json']);
// The public declarations only: the entry and its self-contained types (src/embed).
const embed = join(types, 'embed');
await copyFile(join(embed, 'index.d.ts'), join(out, 'rideo.d.ts'));
await copyFile(join(embed, 'types.d.ts'), join(out, 'types.d.ts'));
// side-effect imports (the stylesheet) are the bundle's business, not the types'
const entry = (await readFile(join(out, 'rideo.d.ts'), 'utf8')).replace(/^import '[^']+';\n/gm, '');
await writeFile(join(out, 'rideo.d.ts'), entry);
const leaked = [...entry.matchAll(/(?:from|import) '(\.\.?\/[^']+)'/g)]
  .map((m) => m[1])
  .filter((p) => p !== './types');
if (leaked.length) throw new Error(`rideo.d.ts refers to internal modules: ${leaked.join(', ')}`);
await rm(join(web, 'build'), { recursive: true, force: true });

const pkg = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
await writeFile(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: 'Rideo studio as a library: RideoStudio and mountRideo (docs/design/embedding.md)',
      license: 'MIT',
      type: 'module',
      main: './rideo.js',
      types: './rideo.d.ts',
      exports: {
        '.': { types: './rideo.d.ts', import: './rideo.js' },
        './style.css': './rideo.css',
      },
      sideEffects: ['*.css'],
      peerDependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    },
    null,
    2,
  )}\n`,
);
console.log(`studio library built in ${out}`);
