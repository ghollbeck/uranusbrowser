/**
 * What the page-level theme fades share (pageThemeFade.ts, serverThemedTabs.ts, viewTransitionIn.ts):
 * the one-second slow-fast-slow curve of lib/themeFade.ts, as View Transition CSS, and the key a
 * tab's scroll position travels under between the old page and the new one.
 */

/** Both halves of a View Transition last as long as UrAnus Browser's own pages fade. */
export const THEME_FADE_CSS =
  '::view-transition-old(root),::view-transition-new(root){animation-duration:1s;animation-timing-function:cubic-bezier(0.37,0,0.63,1)}';

/** The same, for a navigation: both the old and the new page opt in to a cross-document transition. */
export const CROSS_DOCUMENT_CSS = `@view-transition{navigation:auto}${THEME_FADE_CSS}`;

/** sessionStorage key (the page's origin, this tab) holding `[scrollX, scrollY]` across the switch. */
export const SCROLL_KEY = 'anus:themeScroll';
