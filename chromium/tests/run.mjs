// Runs chromium/tests/*.test.ts with Node's test runner. The shell and host use bundler-style
// imports (no extensions), so each test is bundled with esbuild first, into tests/.cache.
//   node chromium/tests/run.mjs            # every test
//   node chromium/tests/run.mjs browserAgent  # tests whose file name contains that
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, '.cache');
const filter = process.argv[2] ?? '';
const tests = fs.readdirSync(here).filter((f) => f.endsWith('.test.ts') && f.includes(filter));
if (!tests.length) {
  console.error('no tests match', filter);
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: tests.map((f) => path.join(here, f)),
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  // Bundled CommonJS dependencies (the MCP SDK) need require in an ES module.
  banner: { js: "import { createRequire as __anusRequire } from 'node:module'; const require = __anusRequire(import.meta.url);" },
});
const files = tests.map((f) => path.join(out, f.replace(/\.ts$/, '.mjs')));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
