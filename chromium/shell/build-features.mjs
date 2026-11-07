// What build.mjs adds for the developer features (features.ts): their pages and content
// scripts as entry points, and their static files.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);

export const featureEntries = {
  boostsPage: path.join(here, 'boostsPage.ts'),
  consoleHook: path.join(here, 'features/consoleHook.ts'),
  consoleBridge: path.join(here, 'features/consoleBridge.ts'),
  // Meeting notes: the offscreen recorder page and its audio worklet.
  meetingsCapture: path.join(here, 'ui/meetingsCapture.ts'),
  meetingsWorklet: path.join(here, 'ui/meetingsWorklet.ts'),
};

export function copyFeatureStatic(out) {
  for (const f of ['boosts.html', 'boosts.css']) fs.copyFileSync(path.join(here, f), path.join(out, f));
  fs.copyFileSync(path.join(here, 'ui/meetingsCapture.html'), path.join(out, 'meetingsCapture.html'));
}
