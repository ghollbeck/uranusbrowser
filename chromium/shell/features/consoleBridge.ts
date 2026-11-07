/**
 * Content script in the isolated world: passes the page world's error count (consoleHook.ts)
 * to the background, a burst at a time.
 */
let pending = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

document.addEventListener('anus:console-error', () => {
  pending++;
  timer ??= setTimeout(() => {
    timer = undefined;
    const count = pending;
    pending = 0;
    chrome.runtime.sendMessage({ anus: 'console-errors', count }).catch(() => undefined);
  }, 250);
});
