// The phone showcase keeps the full desktop canvas and animates its Sidebar view.
(function mobileSidebarDemo() {
  const plate = document.querySelector('#heroProduct');
  const wrap = document.querySelector('#heroSlides');
  const template = wrap?.querySelector('.hero-meeting .hero-browser-window');
  if (!plate || !wrap || !template || wrap.querySelector('.mobile-sidebar-demo')) return;
  const phone = matchMedia('(max-width: 640px)');
  const sidebarTab = document.querySelector('#heroTabSidebar');
  const darkTab = document.querySelector('#heroTabDark');
  const scene = document.createElement('div');
  scene.className = 'hero-scene mobile-sidebar-demo';
  scene.setAttribute('role', 'img');
  const browser = template.cloneNode(true);
  scene.append(browser);
  const address = browser.querySelector('.hero-address');
  address.innerHTML = '<b>⌑</b> uranus.guide <span>⋮</span>';
  const sidebar = browser.querySelector('.hero-browser-sidebar');
  sidebar.innerHTML = '<div class="hero-favs"><b>◉</b><b>◧</b><b>▶</b><b>F</b></div><div class="hero-sidebar-group">◇ &nbsp; Explore</div><div class="hero-sidebar-tab">Trip ideas</div><div class="hero-sidebar-tab active">◉ &nbsp; Uranus</div><div class="hero-sidebar-tab">Google Flights</div><div class="hero-sidebar-section">Today</div><div class="hero-sidebar-tab">+ New Tab</div><div class="hero-sidebar-spaces">◈ &nbsp; ⌂ &nbsp; +</div>';
  const page = browser.querySelector('.hero-page');
  page.className = 'hero-page uranus-guide';
  page.innerHTML = '<div class="uranus-guide-nav"><strong>URANUS<span> / FIELD GUIDE</span></strong><div><span>The planet</span><span>The journey</span><span>The view ↗</span></div></div><div class="uranus-guide-intro"><p>THE SEVENTH PLANET</p><h2>A little further<br>out there.</h2><p class="uranus-guide-deck">Follow your curiosity.<br>There’s a whole world beyond the feed.</p><span class="uranus-guide-link">Explore Uranus <b>↗</b></span></div><div class="uranus-orbit" aria-hidden="true"><div class="uranus-planet-ring"></div><div class="uranus-planet"></div><span class="uranus-orbit-dot"></span></div><div class="uranus-guide-facts"><span><small>DISTANCE FROM THE SUN</small><b>2.9 billion km</b></span><span><small>ONE TRIP AROUND THE SUN</small><b>84 Earth years</b></span><span><small>YOUR NEXT DESTINATION</small><b>A little perspective.</b></span></div>';
  // Keep the same layout underneath the existing expanding-circle reveal.
  const darkLayer = document.createElement('div');
  darkLayer.className = 'uranus-dark-layer uranus-is-dark shot-iris';
  darkLayer.setAttribute('aria-hidden', 'true');
  darkLayer.append(browser.cloneNode(true));
  scene.append(darkLayer);
  const shortcut = document.createElement('div');
  shortcut.className = 'mobile-sidebar-shortcut';
  shortcut.innerHTML = '<span class="mobile-sidebar-shortcut-label">Hide sidebar</span><kbd>⌘</kbd><kbd>S</kbd>';
  scene.append(shortcut);
  wrap.append(scene);
  wrap.classList.add('mobile-uranus-ready');
  let sidebarActive = false, visible = false, elapsed = 0, last = null;
  const render = () => {
    const closed = sidebarActive && elapsed >= 2100 && elapsed < 4900;
    const flashing = sidebarActive && ((elapsed >= 1350 && elapsed < 3400) || (elapsed >= 4200 && elapsed < 6300));
    scene.classList.toggle('sidebar-is-closed', closed);
    scene.classList.toggle('shortcut-is-visible', flashing);
    shortcut.querySelector('.mobile-sidebar-shortcut-label').textContent = elapsed < 3900 ? 'Hide sidebar' : 'Show sidebar';
  };
  const sync = () => {
    const nextSidebar = phone.matches && sidebarTab?.getAttribute('aria-selected') === 'true';
    const dark = phone.matches && darkTab?.getAttribute('aria-selected') === 'true';
    if (nextSidebar && !sidebarActive) elapsed = 0;
    sidebarActive = nextSidebar;
    const active = sidebarActive || dark;
    scene.classList.toggle('is-on', active);
    darkLayer.classList.toggle('is-on', dark);
    scene.setAttribute('aria-hidden', String(!active));
    scene.setAttribute('aria-label', dark ? 'The same Uranus guide and browser sidebar in dark mode.' : 'Uranus Browser opens a guide to Uranus, hides its sidebar with Command S, then shows it again with the same shortcut.');
    render();
  };
  const tabObserver = new MutationObserver(sync);
  for (const tab of [sidebarTab, darkTab]) {
    if (tab) tabObserver.observe(tab, { attributes: true, attributeFilter: ['aria-selected'] });
  }
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(wrap);
  phone.addEventListener('change', sync);
  sidebarTab?.addEventListener('click', () => { elapsed = 0; render(); });
  const frame = (stamp) => {
    const delta = last === null ? 0 : Math.min(stamp - last, 500);
    last = stamp;
    if (sidebarActive && visible && plate.dataset.motionPaused !== 'true') {
      elapsed = Math.min(elapsed + delta, 6400);
      render();
    }
    requestAnimationFrame(frame);
  };
  sync();
  requestAnimationFrame(frame);
})();
