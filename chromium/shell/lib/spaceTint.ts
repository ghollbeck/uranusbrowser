/**
 * Space colours are pastels. The window shows them as a whisper over the neutral frame grey
 * (ScienceOS design system), so a Space stays recognisable while the chrome stays quiet; dark mode
 * does the same over the dark frame.
 */
export function spaceTint(color: string, dark: boolean) {
  const base = dark ? [25, 25, 25] : [244, 244, 245];
  const amount = dark ? 0.06 : 0.22;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mixed = rgb.map((c, i) => Math.round(c * amount + base[i] * (1 - amount)));
  return '#' + mixed.map((c) => c.toString(16).padStart(2, '0')).join('');
}
