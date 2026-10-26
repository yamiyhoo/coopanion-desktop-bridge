/**
 * Builds the Host half as one CommonJS file that DSH can load from a profile.
 *
 * CommonJS, not ESM, for the reason the web bridge learned the hard way: the Host loads a profile
 * plugin through its own module table, a `.js` file under a profile with no `"type"` is CommonJS to
 * Node, and an ESM artifact with `export default` fails there before `apply` ever runs — silently.
 * `.cjs` is unambiguous in both directions.
 *
 * `ws` is **bundled in**, not left external: a profile-local copy of this package has no
 * `node_modules` beside it (the desktop profile installs by copy or by pnpm pack, not by a full
 * dependency tree), so a bare `require('ws')` would fail at import time and the bridge would never
 * activate. Node builtins stay external.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));

// JSON.parse rejects a byte-order mark, which is how a manifest saved by PowerShell round-trips
// breaks an install with "Cannot validate installed package ... Unexpected token".
if (manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) {
  throw new Error(`${manifestPath} starts with a UTF-8 byte-order mark; DSH would refuse the package`);
}

const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
const { build } = await import('esbuild');

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: [...builtins],
  sourcemap: false,
  logLevel: 'info',
  define: {
    __PKG_VERSION__: JSON.stringify(manifest.version ?? '0.0.0-unknown'),
  },
});
