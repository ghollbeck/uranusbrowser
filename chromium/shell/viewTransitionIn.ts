/**
 * Content script, registered for one origin just before serverThemedTabs.ts swaps a tab's page
 * for one made for the other colour scheme. It makes the new page's arrival a cross-document View
 * Transition: the old page's picture crossfades into the new page on the theme-fade curve. The
 * old page opts in too (serverThemedTabs.ts), since both sides have to. It also puts the tab back
 * where it was scrolled to, as a reload would (the navigation is a replace, which doesn't), and
 * gives the address back the #fragment the old page left off.
 *
 * Runs at document_start, so the rule is there before the page's first frame. The rule is dropped
 * once the transition is over, so the page's own later navigations don't fade.
 */
import { CROSS_DOCUMENT_CSS, SCROLL_KEY } from './themeFadeCss';

const sheet = new CSSStyleSheet();
sheet.replaceSync(CROSS_DOCUMENT_CSS);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
const drop = () => {
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
};
addEventListener('pagereveal', (event) => {
  const transition = (event as Event & { viewTransition?: { finished: Promise<void> } | null }).viewTransition;
  if (transition) void transition.finished.then(drop, drop);
  else drop();
});
// If the page is never revealed (a background tab), don't leave the rule behind.
setTimeout(drop, 5000);

try {
  const saved = sessionStorage.getItem(SCROLL_KEY);
  if (saved) {
    sessionStorage.removeItem(SCROLL_KEY);
    const [x, y, hash] = JSON.parse(saved) as [number, number, string?];
    if (hash) history.replaceState(history.state, '', hash);
    const restore = () => scrollTo(x, y);
    addEventListener('DOMContentLoaded', restore, { once: true });
    addEventListener('load', restore, { once: true });
  }
} catch {
  // No sessionStorage (a sandboxed frame): the page opens at the top.
}
