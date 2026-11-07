/**
 * Content script in the page's own world, from document_start: counts console errors and
 * uncaught exceptions for the sidebar's error badge, like Electron's `console-message`
 * events did. It only counts; consoleBridge.ts (the isolated world) tells the background.
 *
 * DevTools leaves content scripts out of stack traces, so errors still point at the page's
 * own code.
 */
(() => {
  const EVENT = 'anus:console-error';
  const tell = () => document.dispatchEvent(new CustomEvent(EVENT));

  const original = console.error;
  console.error = function (...args: unknown[]) {
    tell();
    return original.apply(this, args);
  };
  // Uncaught exceptions, and resources that failed to load (capture: those events don't bubble).
  window.addEventListener('error', tell, true);
  window.addEventListener('unhandledrejection', tell);
})();
