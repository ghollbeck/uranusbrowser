// Builds the shell extension into chromium/shell/dist. `node build.mjs --watch` rebuilds on
// save; reload the extension (or the sidebar) to see the change. No Chromium build involved.
import { build, context } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { featureEntries, copyFeatureStatic } from './build-features.mjs';
import { buildAdblock } from './build-adblock.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const out = path.join(here, 'dist');
const ui = path.join(here, 'ui');

function copyStatic() {
  fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(ui)) if (f.endsWith('.css')) fs.copyFileSync(path.join(ui, f), path.join(out, f));
  fs.copyFileSync(
    path.join(root, 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'),
    path.join(out, 'fonts/jetbrains-mono.woff2'),
  );
  // The sidebar page (ui/index.html), pointed at the shell's bundle, once per surface.
  const html = fs
    .readFileSync(path.join(ui, 'index.html'), 'utf8')
    .replace('src="app.js"', 'src="sidebar.js"')
    .replace('<link rel="stylesheet" href="onboarding.css" />', '$&\n    <link rel="stylesheet" href="shell.css" />');
  const pages = { window: 'window.html', panel: 'sidebar.html', newtab: 'newtab.html' };
  for (const [surface, page] of Object.entries(pages)) {
    let pageHtml = html.replace('<html>', `<html data-surface="${surface}">`);
    if (surface === 'window') pageHtml = pageHtml.replace('<title>', '<script src="kind.js"></script>\n    <title>');
    fs.writeFileSync(path.join(out, page), pageHtml);
  }
  fs.copyFileSync(path.join(here, 'shell.css'), path.join(out, 'shell.css'));
  // A AnusMini's frame page is window.html?kind=anusmini; this sends it on to the
  // AnusMini toolbar before the sidebar's code runs.
  fs.writeFileSync(
    path.join(out, 'kind.js'),
    "if (new URLSearchParams(location.search).get('kind') === 'anusmini') location.replace('anusmini.html' + location.search);\n",
  );
  fs.writeFileSync(path.join(out, 'anusmini.html'), fs.readFileSync(path.join(ui, 'anusmini.html'), 'utf8'));
  // The Agent panel, which the browser shows beside the page (patch 0042).
  fs.copyFileSync(path.join(ui, 'agent.html'), path.join(out, 'agent.html'));
  // The Algorithm Diet's page (ui/diet.ts), opened in a tab from the sidebar's Diet button.
  fs.copyFileSync(path.join(ui, 'diet.html'), path.join(out, 'diet.html'));
  for (const f of ['settings.html', 'settings-shell.css']) fs.copyFileSync(path.join(here, f), path.join(out, f));
  // The icon on the meeting reminders' notifications (calendar.ts).
  fs.copyFileSync(path.join(here, '../branding/logo/product_logo_128.png'), path.join(out, 'icon128.png'));
  copyFeatureStatic(out);
  writeManifest();
}

/**
 * The manifest, with a version that changes whenever the built shell does. Chromium keeps an
 * extension's service worker registered until the extension's version changes (it compares
 * them for equality, ServiceWorkerTaskQueue), so with a fixed version a profile that had run
 * an older shell kept running that older background.js beside the new pages. Chromium
 * versions are up to four numbers of 0 to 65535; the fourth comes from the built files.
 */
function writeManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256');
  const files = fs.readdirSync(out, { recursive: true }).filter((f) => f !== 'manifest.json' && fs.statSync(path.join(out, f)).isFile());
  for (const f of files.sort()) hash.update(`${f}\0`).update(fs.readFileSync(path.join(out, f)));
  manifest.version = `${manifest.version}.${hash.digest().readUInt16BE(0)}`;
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const options = {
  entryPoints: { background: path.join(here, 'background.ts'), sidebar: path.join(here, 'sidebar.ts'), settings: path.join(here, 'settings.ts'), anusmini: path.join(here, 'anusmini.ts'), agent: path.join(ui, 'agent.ts'), diet: path.join(ui, 'diet.ts'), viewTransitionIn: path.join(here, 'viewTransitionIn.ts'), ...featureEntries },
  bundle: true,
  format: 'esm',
  target: 'chrome140',
  outdir: out,
  logLevel: 'warning',
  plugins: [{ name: 'static', setup: (b) => b.onEnd(copyStatic) }],
};

await buildAdblock(out);

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('shell: watching');
} else {
  await build(options);
}
