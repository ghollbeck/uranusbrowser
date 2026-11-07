// Bundles the native messaging host into one file, chromium/native-host/dist/anus-host.cjs,
// which install-native-host.sh points Chromium at. Needs Node 22.5+ to run (node:sqlite).
import { build } from 'esbuild';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);

await build({
  entryPoints: [path.join(here, 'host.ts')],
  outfile: path.join(here, 'dist/anus-host.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});
