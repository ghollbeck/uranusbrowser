// The logo in the shell UI (shell/ui/logo.ts, generated) must still be the SVG masters in
// branding/logo: same tile and arrow geometry, the ScienceOS black-on-white look, one-colour mark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { LOGO_MARK, LOGO_TILE } from '../shell/ui/logo';

const master = fs.readFileSync(new URL('../../branding/logo/anus-logo.svg', import.meta.url), 'utf8');
const mono = fs.readFileSync(new URL('../../branding/logo/anus-mark.svg', import.meta.url), 'utf8');
const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);

test('the master is the ScienceOS-style Arrow: flat white tile, pure black arrow, no gradient or shadow', () => {
  assert.match(master, /viewBox="0 0 1024 1024" width="1024" height="1024"/, 'build-logo.sh expects this header');
  assert.match(master, /<rect x="46" y="50" width="932" height="924" rx="185" fill="#ffffff"\/>/);
  const markup = master.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/Gradient|filter|opacity/i.test(markup), 'flat: no gradient, filter or transparency');
  const colours = new Set([...markup.matchAll(/#[0-9a-f]{3,6}\b/gi)].map((m) => m[0]!.toLowerCase()));
  assert.deepEqual([...colours].sort(), ['#000000', '#ffffff']);
});

test('the inline tile carries the master geometry, cropped to the tile', () => {
  assert.match(LOGO_TILE, /^<svg [^>]*viewBox="46 50 932 924"/);
  assert.ok(!LOGO_TILE.includes('<title>'));
  assert.ok(LOGO_TILE.includes('<rect x="46" y="50" width="932" height="924" rx="185"'));
  for (const d of paths(master)) assert.ok(LOGO_TILE.includes(d));
});

test('the inline mark is the mono svg, in currentColor', () => {
  assert.match(LOGO_MARK, /fill="currentColor"/);
  assert.ok(!/#[0-9a-f]{3,6}/i.test(LOGO_MARK), 'no fixed colour in the mark');
  for (const d of paths(mono)) assert.ok(LOGO_MARK.includes(d));
  assert.deepEqual(paths(mono), paths(master), 'the mark is the same arrow as the logo');
});
