// Fit the lower flight replay to a phone without rearranging its page or chat.
(function mobileFlightCanvas() {
  const demo = document.querySelector('#agentDemo');
  if (!demo) return;
  const mobile = matchMedia('(max-width: 640px)');
  const cursor = demo.querySelector('.demo-cursor');
  let viewport, scale = 1, lastCursorSignature = '';

  const fitCursor = () => {
    if (!cursor || !mobile.matches) return;
    const x = cursor.style.getPropertyValue('--cx').trim();
    const y = cursor.style.getPropertyValue('--cy').trim();
    const signature = `${x}|${y}|${scale}`;
    if (signature === lastCursorSignature) return;
    lastCursorSignature = signature;
    // The replay measures targets in screen pixels; undo the canvas scale once.
    cursor.style.setProperty('--mobile-cursor-x', x.endsWith('px') ? `${parseFloat(x) / scale}px` : x || '60%');
    cursor.style.setProperty('--mobile-cursor-y', y.endsWith('px') ? `${parseFloat(y) / scale}px` : y || '60%');
  };
  const fit = () => {
    if (!mobile.matches || !viewport) return;
    scale = viewport.clientWidth / 1080;
    if (!scale) return;
    demo.style.setProperty('--mobile-flight-scale', scale);
    fitCursor();
  };
  const activate = () => {
    if (!mobile.matches) return;
    if (!viewport) {
      viewport = document.createElement('div');
      viewport.className = 'mobile-flight-viewport';
      demo.before(viewport);
      viewport.append(demo);
      new ResizeObserver(fit).observe(viewport);
    }
    fit();
  };
  if (cursor) new MutationObserver(fitCursor).observe(cursor, { attributes: true, attributeFilter: ['style'] });
  mobile.addEventListener('change', activate);
  activate();
})();
