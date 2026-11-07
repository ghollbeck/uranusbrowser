// UrAnus Browser — marketing site interactions.
// The mobile product tour autoplays; desktop keeps its system motion preference.
const reduceMotion = !matchMedia('(max-width: 640px)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- Visibility helper: run loops only while on screen ---------- */
function watchVisible(el, onChange, margin = '0px') {
  const state = { visible: false, waiters: [] };
  new IntersectionObserver(([e]) => {
    state.visible = e.isIntersecting;
    if (state.visible) { state.waiters.splice(0).forEach((r) => r()); }
    onChange && onChange(state.visible);
  }, { rootMargin: margin }).observe(el);
  state.wait = () => (state.visible ? Promise.resolve() : new Promise((r) => state.waiters.push(r)));
  return state;
}
// a sleep that also pauses while the element is off screen
const pausable = (vis) => async (ms) => { await sleep(ms); await vis.wait(); };

/* ---------- Header ---------- */
const header = $('.nav-wrap');
const onScrollHeader = () => header.classList.toggle('scrolled', scrollY > 40);
addEventListener('scroll', onScrollHeader, { passive: true });
onScrollHeader();

/* ---------- Theme toggle, revealed as a circle from the button ---------- */
const root = document.documentElement;
const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
$('.theme-toggle').addEventListener('click', (ev) => {
  const next = isDark() ? 'light' : 'dark';
  const apply = () => {
    root.dataset.theme = next;
  };
  if (!document.startViewTransition || reduceMotion) return apply();
  const r = ev.currentTarget.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.startViewTransition(apply).ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { duration: 900, easing: 'cubic-bezier(.37, 0, .63, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
});

/* ---------- Hero title: letters rise one after another ---------- */
(function splitLetters() {
  const title = $('[data-letters]');
  if (!title) return;
  let i = 0;
  const walk = (node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach((chunk) => {
          if (!chunk) return;
          if (/^\s+$/.test(chunk)) { frag.append(' '); return; }
          const w = document.createElement('span');
          w.className = 'word';
          [...chunk].forEach((ch) => {
            const l = document.createElement('span');
            l.className = 'letter';
            l.style.setProperty('--i', i++);
            l.textContent = ch;
            w.append(l);
          });
          frag.append(w);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1) walk(n);
    });
  };
  title.setAttribute('aria-label', title.textContent.replace(/\s+/g, ' ').trim());
  walk(title);
  $$('.word, .letter', title).forEach((s) => s.setAttribute('aria-hidden', 'true'));
})();

/* ---------- Scroll reveal ---------- */
const revealIO = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); } });
}, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });
$$('[data-reveal]').forEach((el) => revealIO.observe(el));

/* ---------- Scroll-linked: layer spread ---------- */
const layers = $('#layersStack');
function onScrollFx() {
  if (!layers) return;
  const vh = innerHeight;
  const r = layers.getBoundingClientRect();
  const c = r.top + r.height / 2;
  const p = clamp(1 - Math.abs(c - vh / 2) / (vh * 0.55), 0, 1);
  layers.style.setProperty('--p', (p * p * (3 - 2 * p)).toFixed(3));
}
addEventListener('scroll', () => requestAnimationFrame(onScrollFx), { passive: true });
addEventListener('resize', onScrollFx);
onScrollFx();

/* ---------- Hero: desktop browser canvas and visible-time demo sequence ---------- */
(function heroTabs() {
  const plate = $('#heroProduct');
  if (!plate) return;
  const tabs = $$('#heroTabs button');
  const thumb = $('#heroTabs .seg-thumb');
  const slides = $$('.shot, .hero-scene', plate);
  const wrap = $('.shot-wrap', plate);
  const cursor = $('.agent-cursor', plate);
  const motionToggle = $('#heroMotionToggle');
  const meet = $('.hero-meeting', plate);
  const flight = $('.hero-flight', plate);
  // Use the same page and chat components as the larger demo below.
  $('.hero-flights-page', flight).append($('.gf', $('#agentDemo')).cloneNode(true));
  const panel = $('.hero-flight-panel', flight);
  [...$('.demo-panel', $('#agentDemo')).children].forEach((el) => {
    const clone = el.cloneNode(true);
    clone.removeAttribute('id');
    panel.append(clone);
  });
  const glow = document.createElement('div');
  glow.className = 'glow-corners';
  $('.hero-flights-page', flight).prepend(glow);
  const log = $('.panel-log', panel);
  log.innerHTML = '<div class="msg user">Find me the smoothest flight to UrAnus. Rear seat, as close to the loo as possible.</div><div class="msg step done"><span class="st">✓</span><span>Read the page</span></div><div class="msg step done"><span class="st">✓</span><span>Type “UrAnus” into To</span></div><div class="msg step run"><span class="st"></span><span>Pick 14 March</span></div><div class="msg answer">Cheeky Airways · 10:40 AM · €84. Rear seat, right by the loo. Booking waits for your Allow.</div>';
  let current = 0, elapsed = 0, paused = reduceMotion, visible = false, lastStamp = null;
  const durations = [10500, 15000, 6500, 6500, 6500, 6500, 6500];
  const placeThumb = () => {
    const t = tabs[current];
    thumb.style.setProperty('--tx', t.offsetLeft + 'px');
    thumb.style.setProperty('--tw', t.offsetWidth + 'px');
  };
  const fitCanvas = () => {
    wrap.style.setProperty('--hero-scale', wrap.clientWidth / 1120);
    placeThumb();
  };
  new ResizeObserver(fitCanvas).observe(wrap);
  const renderDemo = () => {
    const t = elapsed;
    if (current === 0) {
      const joining = t >= 2000;
      const joined = t >= 5200;
      meet.dataset.joinPhase = joined ? 'joined' : joining ? 'joining' : 'ready';
      $('.hero-join-label', meet).textContent = joined ? 'Taking notes' : 'Joining';
      $('.hero-join-status', meet).textContent = joined ? 'Assistant joined · recording meeting notes' : joining ? 'UrAnus Browser assistant is joining the call…' : 'Your assistant will join in a moment.';
      $('.hero-meet-count', meet).textContent = joining ? '◉  4' : '◉  3';
    }
    if (current === 1) {
      const to = $('[data-type="to"]', flight), date = $('[data-type="date"]', flight);
      to.textContent = 'UrAnus'.slice(0, Math.max(0, Math.floor((t - 1800) / 160)));
      date.textContent = 'Fri, Mar 14'.slice(0, Math.max(0, Math.floor((t - 4000) / 160)));
      $('[data-target="to"]', flight).classList.toggle('focus', t >= 1800 && t < 3500);
      $('[data-target="date"]', flight).classList.toggle('focus', t >= 4000 && t < 6500);
      $('.fl-results', flight).classList.toggle('show', t >= 8500);
      $('.cheapest', flight).classList.toggle('hl', t >= 10500);
      $('.panel-state span', panel).textContent = t >= 11500 ? 'Done' : 'Working';
      $('.panel-state i', panel).style.background = t >= 11500 ? 'var(--success)' : 'var(--brand)';
      [...log.children].forEach((item, i) => { item.hidden = t < [0, 1000, 3500, 4000, 11500][i]; });
      const step = log.children[3];
      step.classList.toggle('run', t < 6500);
      step.classList.toggle('done', t >= 6500);
      $('.st', step).textContent = t >= 6500 ? '✓' : '';
    }
  };
  const show = (v) => {
    current = v; elapsed = 0;
    tabs.forEach((t, i) => { t.setAttribute('aria-selected', String(i === v)); t.tabIndex = i === v ? 0 : -1; });
    placeThumb();
    wrap.setAttribute('aria-labelledby', tabs[v].id);
    slides.forEach((s) => {
      const i = Number(s.dataset.shot);
      s.classList.toggle('is-on', i === v || (v === 3 && i === 2));
      s.setAttribute('aria-hidden', String(i !== v));
    });
    renderDemo();
  };
  const setPaused = (value) => {
    paused = value;
    plate.dataset.motionPaused = String(paused);
    motionToggle.setAttribute('aria-pressed', String(paused));
    motionToggle.textContent = paused ? 'Resume motion' : 'Pause motion';
    cursor.classList.toggle('on', !paused);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { show(i); setPaused(false); });
    t.addEventListener('keydown', (e) => {
      const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault(); tabs[next].focus(); show(next); setPaused(false);
    });
  });
  motionToggle.addEventListener('click', () => setPaused(!paused));
  watchVisible(wrap, (value) => { visible = value; });
  document.fonts?.ready.then(fitCanvas);
  show(0); fitCanvas(); setPaused(reduceMotion);
  const tick = (stamp) => {
    const delta = lastStamp === null ? 0 : Math.min(stamp - lastStamp, 100);
    lastStamp = stamp;
    if (visible && !paused) {
      elapsed += delta;
      renderDemo();
      if (elapsed >= durations[current]) show((current + 1) % tabs.length);
      const target = elapsed > durations[current] - 1200 ? tabs[(current + 1) % tabs.length] : wrap;
      const p = plate.getBoundingClientRect(), r = target.getBoundingClientRect();
      cursor.style.setProperty('--cx', `${r.left - p.left + r.width * .57}px`);
      cursor.style.setProperty('--cy', `${r.top - p.top + r.height * .64}px`);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();

/* ---------- Agent demo: a replayed run ---------- */
(async function agentDemo() {
  const demo = $('#agentDemo');
  if (!demo) return;
  const body = $('.demo-body', demo);
  const log = $('#panelLog');
  const cursor = $('.demo-cursor', demo);
  const ripple = $('.ripple', cursor);
  const results = $('.fl-results', demo);
  const state = $('.panel-state span', demo);
  const fields = { to: $('[data-type="to"]', demo), date: $('[data-type="date"]', demo) };
  const vis = watchVisible(demo, null, '-15% 0px');
  const wait = pausable(vis);

  const add = (html, cls) => {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.innerHTML = html;
    log.append(el);
    while (log.children.length > 9) log.firstElementChild.remove();
    return el;
  };
  const step = (text) => {
    const el = add(`<span class="st"></span><span>${text}</span>`, 'step run');
    return { done() { el.className = 'msg step done'; el.firstElementChild.innerHTML = '<svg width="10" height="10"><use href="#i-check"/></svg>'; } };
  };
  const target = (name) => $(`[data-target="${name}"]`, demo);
  const moveTo = async (el, dx = 0.3, dy = 0.55) => {
    const b = body.getBoundingClientRect(), r = el.getBoundingClientRect();
    cursor.style.setProperty('--cx', `${r.left - b.left + r.width * dx}px`);
    cursor.style.setProperty('--cy', `${r.top - b.top + r.height * dy}px`);
    await wait(1050);
  };
  const click = () => { ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go'); };
  const type = async (el, text) => { for (const ch of text) { el.textContent += ch; await wait(65 + Math.random() * 50); } };

  if (reduceMotion) {
    fields.to.textContent = 'UrAnus'; fields.date.textContent = 'Fri, Mar 14';
    results.classList.add('show'); $('.cheapest', demo).classList.add('hl');
    add('Find me the smoothest flight to UrAnus. Rear seat, as close to the loo as possible.', 'user');
    add('Cheapest nonstop is <b>Cheeky Airways at 10:40 AM, €84</b>. Rear seat, right by the loo. Booking waits for your Allow.', 'answer');
    return;
  }

  await vis.wait();
  for (;;) {
    log.innerHTML = ''; state.textContent = 'Idle';
    fields.to.textContent = ''; fields.date.textContent = '';
    results.classList.remove('show');
    $$('.fl-row', demo).forEach((r) => r.classList.remove('hl'));
    cursor.style.setProperty('--cx', '70%'); cursor.style.setProperty('--cy', '85%');
    await wait(700);

    add('Find me the smoothest flight to UrAnus. Rear seat, as close to the loo as possible.', 'user');
    await wait(800);
    const think = add('<i></i><i></i><i></i>', 'thinking');
    await wait(1100);
    think.remove();
    demo.classList.add('working'); state.textContent = 'Working';
    cursor.classList.add('on');

    let s = step('Read the page');
    await wait(900); s.done();

    s = step('Type “UrAnus” into To');
    await moveTo(target('to'));
    click(); target('to').classList.add('focus');
    await wait(250);
    await type(fields.to, 'UrAnus');
    target('to').classList.remove('focus'); s.done();

    s = step('Pick 14 March');
    await moveTo(target('date'));
    click(); target('date').classList.add('focus');
    await wait(250);
    await type(fields.date, 'Fri, Mar 14');
    target('date').classList.remove('focus'); s.done();

    await moveTo(target('search'), 0.5, 0.5);
    const ask = add('<p>Run the search on <b>google.com</b>?</p><div class="approve-row"><span class="allow">Allow</span><span>Deny</span></div>', 'approve');
    await wait(1700);
    const allow = $('.allow', ask);
    allow.classList.add('press');
    await wait(180);
    allow.classList.remove('press');
    ask.classList.add('resolved');
    click(); target('search').classList.add('press');
    await wait(200);
    target('search').classList.remove('press');
    s = step('Run the search');
    await wait(600); s.done();
    results.classList.add('show');

    s = step('Compare 4 results');
    await wait(900);
    await moveTo($('.cheapest', demo), 0.92, 0.5);
    $('.cheapest', demo).classList.add('hl');
    s.done();
    await wait(500);

    demo.classList.remove('working'); state.textContent = 'Done';
    cursor.classList.remove('on');
    add('Cheapest nonstop is <b>Cheeky Airways at 10:40 AM</b>. Rear seat, right by the loo. One-way to UrAnus.<div class="result"><span>Cheeky Airways · ZRH → URA · Fri, Mar 14</span><em>€84</em></div>', 'answer');
    await wait(6500);
  }
})();

/* ---------- Command bar typing loop ---------- */
(async function commandBar() {
  const typed = $('#cmdTyped'), list = $('#cmdList');
  if (!typed) return;
  const ts = 1761734400;
  const scripts = [
    { q: 'gh chromium/chromium', items: [['GH', 'chromium/chromium', 'github.com'], ['GH', 'chromium/chromium · Pull requests', 'github.com'], ['⌕', 'Search GitHub for “chromium/chromium”', '↵']] },
    { q: 'mdn grid', items: [['M', 'grid — CSS | MDN', 'developer.mozilla.org'], ['M', 'CSS grid layout guide', 'developer.mozilla.org'], ['⌕', 'Search MDN for “grid”', '↵']] },
    { q: String(ts), items: [['⏱', new Date(ts * 1000).toUTCString().replace(' GMT', ' UTC'), 'Unix time'], ['⧉', 'Copy as ISO 8601', '↵']] },
    { q: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9', items: [['🔑', 'JWT · alg HS256 · sub "42"', 'decoded'], ['⧉', 'Copy payload', '↵']] },
  ];
  const vis = watchVisible(typed.closest('.card'));
  const wait = pausable(vis);
  if (reduceMotion) { typed.textContent = scripts[0].q; render(scripts[0].items); return; }
  function render(items) {
    list.innerHTML = '';
    items.forEach(([ic, label, k], n) => {
      const li = document.createElement('li');
      li.style.animationDelay = n * 70 + 'ms';
      li.innerHTML = `<i>${ic}</i><span>${label}</span><span class="k">${k}</span>`;
      list.append(li);
    });
  }
  for (let n = 0; ; n = (n + 1) % scripts.length) {
    const { q, items } = scripts[n];
    for (const ch of q) { typed.textContent += ch; await wait(q.length > 24 ? 22 : 70); }
    await wait(250);
    render(items);
    await wait(2400);
    list.innerHTML = '';
    while (typed.textContent) { typed.textContent = typed.textContent.slice(0, -2); await wait(14); }
    await wait(300);
  }
})();

/* ---------- Developers visual ---------- */
(async function devLoop() {
  const lines = $$('.term-line');
  const badge = $('#errBadge'), env = $('#envBadge'), url = $('#envUrl');
  if (!badge) return;
  const vis = watchVisible(badge.closest('.dev-visual'));
  const wait = pausable(vis);
  const envs = [['LOCAL', '', 'localhost:5173/pricing'], ['STAGING', 'staging', 'staging.my-app.dev/pricing'], ['PROD', 'prod', 'my-app.com/pricing']];
  const setEnv = (k) => {
    const [label, cls, u] = envs[k];
    env.textContent = label; env.className = 'env-badge flip ' + cls; url.textContent = u;
    url.classList.remove('flip'); void url.offsetWidth; url.classList.add('flip');
  };
  if (reduceMotion) { lines.forEach((l) => l.classList.add('show')); return; }
  for (;;) {
    lines.forEach((l) => l.classList.remove('show'));
    badge.textContent = '3'; badge.classList.remove('zero');
    setEnv(0);
    await wait(900);
    badge.classList.add('bump'); await wait(250); badge.classList.remove('bump');
    for (const l of lines.slice(0, 3)) { await wait(800); l.classList.add('show'); }
    await wait(1100);
    lines[3].classList.add('show');
    badge.textContent = '0'; badge.classList.add('zero', 'bump'); await wait(250); badge.classList.remove('bump');
    await wait(1600);
    setEnv(1); await wait(1600);
    setEnv(2); await wait(2200);
  }
})();

/* ---------- Keycaps press in turn ---------- */
(async function keys() {
  const combos = $$('.combo');
  if (!combos.length || reduceMotion) return;
  const vis = watchVisible($('#keys'));
  const wait = pausable(vis);
  combos.forEach((c) => {
    c.addEventListener('pointerenter', () => c.classList.add('down'));
    c.addEventListener('pointerleave', () => c.classList.remove('down'));
  });
  for (let n = 0; ; n = (n + 1) % combos.length) {
    combos[n].classList.add('down');
    await wait(520);
    combos[n].classList.remove('down');
    await wait(480);
  }
})();

/* ---------- Approval gates light up one by one ---------- */
(async function gates() {
  const chips = $$('.gates span');
  if (!chips.length) return;
  if (reduceMotion) { chips.forEach((c) => c.classList.add('lit')); return; }
  const vis = watchVisible($('.gates'));
  const wait = pausable(vis);
  for (;;) {
    for (const c of chips) { c.classList.add('lit'); await wait(260); }
    await wait(2200);
    chips.forEach((c) => c.classList.remove('lit'));
    await wait(700);
  }
})();

/* ---------- FAQ: animate open and close ---------- */
$$('.qa').forEach((d) => {
  d.querySelector('summary').addEventListener('click', async (e) => {
    e.preventDefault();
    if (d.open) {
      d.classList.remove('open');
      await sleep(reduceMotion ? 0 : 420);
      if (!d.classList.contains('open')) d.open = false;
    } else {
      d.open = true;
      requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add('open')));
    }
  });
});

/* ---------- Algorithm Diet: a local, app-inspired interactive illustration ---------- */
(function algorithmDiet() {
  const demo = $('#dietDemo');
  if (!demo) return;
  // Sample periods only. No history, tracking, model calls or network requests.
  const periods = {
    today: { label: 'Example day', short: 'today', minutes: [34, 26, 16, 8], nutrients: [6.2, 5.6, 4.4, 2.8, 1.4, 2.2] },
    week: { label: 'Example week', short: 'this week', minutes: [170, 150, 110, 80], nutrients: [7, 6, 4, 2, 1, 1.5] },
    month: { label: 'Example month', short: 'this month', minutes: [600, 500, 380, 320], nutrients: [5.6, 4.9, 4.2, 3.8, 2.1, 3.2] },
  };
  const verdicts = { A: 'Superfood', B: 'Wholesome', C: 'Balanced', D: 'Snacky', E: 'Junk food' };
  const duration = (minutes) => minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
  const ranges = $$('[data-diet-range]', demo);
  const questions = $$('[data-diet-question]', demo);
  const score = $('#dietScore');
  const phone = $('#dietPhoneScreen');
  const phoneScore = $('[data-diet-phone-score]');
  if (phone) {
    const fitPhone = () => phone.style.setProperty('--diet-phone-scale', String(phone.clientWidth / 204));
    fitPhone();
    new ResizeObserver(fitPhone).observe(phone);
  }
  const setScore = value => { score.textContent = String(value); if (phoneScore) phoneScore.textContent = String(value); };
  let current = 'week', question = 'learn', frame = 0, started = false;
  function answer(animate) {
    const period = periods[current];
    const total = period.minutes.reduce((a, b) => a + b, 0);
    const text = question === 'learn'
      ? `Learning and building took the largest share of this sample ${current === 'today' ? 'day' : current}. Long reads made a little room for deeper thinking, too.`
      : `In this sample, ${duration(period.minutes[0] + period.minutes[1])} went to learning and building, out of ${duration(total)} ${period.short}. Social feeds accounted for ${duration(period.minutes[3])}.`;
    const el = $('#dietAnswer');
    el.classList.remove('diet-answer-enter');
    el.textContent = text;
    if (animate && !reduceMotion) { void el.offsetWidth; el.classList.add('diet-answer-enter'); }
  }
  function render(animate = true) {
    cancelAnimationFrame(frame);
    const period = periods[current];
    const total = period.minutes.reduce((a, b) => a + b, 0);
    const n = period.nutrients;
    // Same time-weighted nutrition-to-score mapping used by the native apps.
    const points = n[3] + n[4] + n[5] - n[0] - n[1] - n[2];
    const health = Math.round(clamp((30 - points) / 60 * 100, 0, 100));
    const grade = points <= -12 ? 'A' : points <= -4 ? 'B' : points <= 4 ? 'C' : points <= 12 ? 'D' : 'E';
    $('#dietVerdict').textContent = verdicts[grade];
    $('#dietTotal').textContent = `${duration(total)} · ${period.label.toLowerCase()}`;
    $('#dietRangeLabel').textContent = period.label;
    $('#dietRing').setAttribute('aria-label', `Sample browsing score ${health} out of 100`);
    $('#dietGrade').setAttribute('aria-label', `Sample browsing grade ${grade}`);
    if (phone) {
      $('.diet-phone-ring', phone).setAttribute('aria-label', `Sample browsing score ${health} out of 100`);
      $('.diet-phone-grades', phone).setAttribute('aria-label', `Sample browsing grade ${grade}`);
      $('[data-diet-phone-verdict]', phone).textContent = verdicts[grade];
      $$('[data-diet-phone-total]', phone).forEach(el => { el.textContent = duration(total); });
      $$('[data-diet-phone-grade]', phone).forEach(el => el.classList.toggle('is-grade', el.dataset.dietPhoneGrade === grade));
      $$('[data-diet-phone-range]', phone).forEach(el => el.classList.toggle('is-period', el.dataset.dietPhoneRange === current));
    }
    $$('[data-diet-grade]', demo).forEach(el => el.classList.toggle('is-grade', el.dataset.dietGrade === grade));
    ranges.forEach(el => el.setAttribute('aria-pressed', String(el.dataset.dietRange === current)));
    let offset = 0;
    period.minutes.forEach((minutes, i) => {
      const share = minutes / total * 100;
      const arc = $(`[data-diet-arc="${i}"]`, demo);
      arc.style.strokeDasharray = `${Math.max(0, share - .9)} 100`;
      arc.style.strokeDashoffset = String(-offset);
      const phoneArc = $(`[data-diet-phone-arc="${i}"]`);
      if (phoneArc) { phoneArc.style.strokeDasharray = arc.style.strokeDasharray; phoneArc.style.strokeDashoffset = arc.style.strokeDashoffset; }
      offset += share;
      $(`[data-diet-time="${i}"]`, demo).textContent = duration(minutes);
      $(`[data-diet-bar="${i}"]`, demo).style.width = `${share}%`;
    });
    n.forEach((value, i) => {
      const row = $(`[data-diet-fact="${i}"]`, demo);
      $('b', row).textContent = value.toFixed(1);
      $('.diet-fact-bar > i', row).style.width = `${value * 10}%`;
      const phoneRow = $(`[data-diet-phone-fact="${i}"]`);
      if (phoneRow) { $('b', phoneRow).textContent = value.toFixed(1); $('i > span', phoneRow).style.width = `${value * 10}%`; }
    });
    const from = Number(score.textContent) || 0;
    if (!animate || reduceMotion) setScore(health);
    else {
      const start = performance.now();
      const tick = now => {
        const progress = clamp((now - start) / 1100, 0, 1);
        setScore(Math.round(from + (health - from) * (1 - (1 - progress) ** 3)));
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    answer(false);
  }
  function replay() {
    started = true;
    cancelAnimationFrame(frame);
    demo.classList.add('diet-reset');
    $$('[data-diet-arc]', demo).forEach(el => { el.style.strokeDasharray = '0 100'; el.style.strokeDashoffset = '0'; });
    $$('[data-diet-bar], .diet-fact-bar > i', demo).forEach(el => { el.style.width = '0%'; });
    if (phone) {
      phone.classList.add('diet-phone-reset');
      $$('[data-diet-phone-arc]', phone).forEach(el => { el.style.strokeDasharray = '0 100'; el.style.strokeDashoffset = '0'; });
      $$('.diet-phone-facts i > span', phone).forEach(el => { el.style.width = '0%'; });
      void phone.offsetWidth;
      phone.classList.remove('diet-phone-reset');
    }
    setScore(0);
    void demo.offsetWidth;
    demo.classList.remove('diet-reset');
    render(!reduceMotion);
  }
  ranges.forEach(el => el.addEventListener('click', () => { started = true; current = el.dataset.dietRange; render(); }));
  questions.forEach(el => el.addEventListener('click', () => {
    question = el.dataset.dietQuestion;
    questions.forEach(other => other.setAttribute('aria-pressed', String(other === el)));
    answer(true);
  }));
  $('#dietReplay').addEventListener('click', replay);
  if (reduceMotion) { started = true; render(false); }
  else {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        if (!started) replay();
      }
    }, { threshold: .15 });
    observer.observe(demo);
    if (phone) observer.observe(phone);
  }
})();

/* ---------- Meeting illustrations: finite timelines, paused offscreen, with manual controls ---------- */
(function meetingAnimations() {
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const wave = $('.meeting-recording-wave');
  if (wave) for (let i = 0; i < 38; i++) {
    const bar = document.createElement('i');
    bar.style.setProperty('--wave-height', `${10 + Math.round((Math.sin(i * 1.7) + 1) * 9)}px`);
    bar.style.setProperty('--wave-delay', `${-i * .09}s`);
    wave.append(bar);
  }
  $$('[data-meeting-animation]').forEach(root => {
    const isJoin = root.dataset.meetingAnimation === 'join';
    const windowEl = $('.meeting-browser', root);
    const pause = $('[data-meeting-pause]', root);
    const replay = $('[data-meeting-replay]', root);
    const duration = isJoin ? 7800 : 9300;
    const name = isJoin ? 'assistant joining' : 'meeting recording';
    let elapsed = 0, last = 0, frame = 0, playing = false, visible = false, seen = false, phase = '';
    function render(ms) {
      root.style.setProperty('--meeting-progress', String(clamp(ms / duration, 0, 1)));
      if (isJoin) {
        const next = ms < 1400 ? 'ready' : ms < 3400 ? 'joining' : ms < 5100 ? 'joined' : 'helping';
        if (next === phase) return;
        phase = next; windowEl.dataset.phase = next;
        const joined = next === 'joined' || next === 'helping';
        setText($('#joinParticipantCount'), joined ? '4 people' : '3 people');
        setText($('#joinStatus'), { ready: 'Your assistant is ready when you are.', joining: 'UrAnus Browser assistant is joining…', joined: 'Your assistant joined the meeting.', helping: 'Following the conversation, alongside you.' }[next]);
        setText($('#joinInviteAction'), { ready: 'Invite to call →', joining: 'Joining…', joined: 'In the meeting ✓', helping: 'In the meeting ✓' }[next]);
        setText($('#joinInviteDetail'), joined ? 'Everyone can see it’s here' : 'Visible to everyone in the call');
        setText($('#joinAnimationCaption'), joined ? 'A visible participant. Invited by you.' : 'You choose when it joins.');
        $('.meeting-agent-tile', root).setAttribute('aria-hidden', String(!joined));
        $('.meeting-agent-placeholder', root).setAttribute('aria-hidden', String(joined));
        $('.meeting-assistant-bubble', root).setAttribute('aria-hidden', String(next !== 'helping'));
      } else {
        const next = ms < 1200 ? 'ready' : ms < 7500 ? 'recording' : ms < 8400 ? 'summarizing' : 'notes';
        const seconds = Math.floor(clamp((ms - 1200) / 1000, 0, 6));
        setText($('#meetingRecordingClock'), `00:${String(seconds).padStart(2, '0')}`);
        $$('[data-transcript-line]', root).forEach((el, i) => {
          const shown = ms >= [2400, 4000, 5700][i];
          el.classList.toggle('is-visible', shown); el.setAttribute('aria-hidden', String(!shown));
        });
        $('.meeting-transcript-waiting', root).hidden = ms >= 2400;
        if (next === phase) return;
        phase = next; windowEl.dataset.phase = next;
        setText($('#recordingStateLabel'), { ready: 'Ready to record', recording: 'Recording', summarizing: 'Summarising…', notes: 'Notes ready' }[next]);
        setText($('#recordingAction'), { ready: 'Start recording', recording: 'Stop recording', summarizing: 'Preparing notes…', notes: 'Saved ✓' }[next]);
        setText($('#recordingFooterLabel'), { ready: 'You decide when recording starts.', recording: 'Transcript appears as you talk.', summarizing: 'Finding the decisions and next steps.', notes: 'Summary, decisions and action items.' }[next]);
        setText($('#recordingAnimationCaption'), next === 'notes' ? 'A clear plan, without the frantic typing.' : 'From conversation to something you can use.');
        $('.meeting-live-transcript', root).hidden = next === 'notes';
        $('.meeting-ready-notes', root).hidden = next !== 'notes';
        $$('[data-recording-tab]', root).forEach(el => el.classList.toggle('is-active', el.dataset.recordingTab === (next === 'notes' ? 'notes' : 'transcript')));
      }
    }
    function syncControls() {
      const finished = elapsed >= duration;
      root.classList.toggle('is-playing', playing && visible && !document.hidden);
      pause.disabled = finished;
      pause.textContent = finished ? 'Done' : playing ? 'Pause' : 'Resume';
      pause.setAttribute('aria-label', finished ? `${name} animation finished` : `${playing ? 'Pause' : 'Resume'} ${name} animation`);
    }
    function tick(now) {
      frame = 0;
      if (!playing || !visible || document.hidden) { last = 0; syncControls(); return; }
      if (last) elapsed = Math.min(duration, elapsed + now - last);
      last = now; render(elapsed);
      if (elapsed >= duration) playing = false;
      syncControls(); schedule();
    }
    function schedule() { if (!frame && playing && visible && !document.hidden) frame = requestAnimationFrame(tick); }
    function start() {
      cancelAnimationFrame(frame); frame = 0; elapsed = reduceMotion ? duration : 0; last = 0; phase = ''; seen = true;
      playing = !reduceMotion; render(elapsed); syncControls(); schedule();
    }
    pause.addEventListener('click', () => {
      playing = !playing; last = 0;
      if (!playing) { cancelAnimationFrame(frame); frame = 0; }
      syncControls(); schedule();
    });
    replay.addEventListener('click', start);
    if (reduceMotion) { start(); pause.hidden = true; return; }
    render(0); syncControls();
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !seen) { start(); return; }
      last = 0;
      if (!visible) { cancelAnimationFrame(frame); frame = 0; }
      syncControls(); schedule();
    }, { threshold: .15 }).observe(root);
    document.addEventListener('visibilitychange', () => {
      last = 0;
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      syncControls(); schedule();
    });
  });
})();
