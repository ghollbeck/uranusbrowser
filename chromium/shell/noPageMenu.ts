/**
 * The shell's pages are the browser's UI, not web pages, so a right-click on them must not
 * bring up Chromium's page menu (Back, Reload, Save As…, View Page Source, Inspect).
 * Importing this module turns that menu off for the page, except in text fields, where the
 * native Cut / Copy / Paste menu stays. Elements with a UrAnus Browser menu of their own (tabs,
 * Spaces…) call preventDefault in their handlers, which run first; this one only catches
 * what's left when the event bubbles up to the window.
 *
 * The shell can still be inspected over --remote-debugging-port, or from chrome://inspect.
 */

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'password', 'tel', 'number']);

/** A field that takes typing, where the native edit menu is wanted. */
function editable(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const field = el.closest('input, textarea');
  if (field instanceof HTMLTextAreaElement) return !field.readOnly && !field.disabled;
  if (field instanceof HTMLInputElement) return TEXT_INPUTS.has(field.type) && !field.readOnly && !field.disabled;
  return false;
}

window.addEventListener('contextmenu', (e) => {
  if (!e.defaultPrevented && !editable(e.target)) e.preventDefault();
});
