/**
 * The Algorithm Diet's button in the sidebar's toolbar, next to the Agent button. A click opens
 * the Diet (diet.html) in a tab; hovering shows today in brief: the grade, time, health, an
 * hour-by-hour strip coloured by grade and a scrollable breakdown by category. Today's visits
 * come straight from the Diet's store (lib/dietDb.ts) and update live while it is shown.
 * Windows only, never incognito (nothing is recorded there).
 */
import { cmd, on } from './client';
import { incognito } from './incognito';
import { classify } from './lib/dietClassifier';
import * as db from './lib/dietDb';
import { add, CATEGORY, duration, grade, GRADE_COLOR, scale, VERDICT, ZERO, type DietVisit, type Nutrients } from './lib/dietModel';
import { computeStats, startOfDay, type Labeled } from './lib/dietStats';
import { gradeChip, h } from './ui/dietParts';
import { icon } from './ui/dietIcons';

const button = document.getElementById('btn-diet') as HTMLButtonElement | null;
const surface = document.documentElement.dataset.surface;

if (button && surface === 'window' && !incognito) {
  button.hidden = false;
  const pop = h('div', { id: 'diet-pop', role: 'dialog', 'aria-label': 'Algorithm Diet today' });
  document.body.append(pop);

  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  let shown = false;
  let today: DietVisit[] = [];

  async function load() {
    const start = startOfDay(Date.now());
    const [visits, hints] = await Promise.all([db.visitsBetween(start, Date.now() + 1000), db.hints()]);
    today = visits;
    draw(visits.map((v) => [v, classify(v, hints)] as Labeled));
  }

  function draw(items: Labeled[]) {
    const start = startOfDay(Date.now());
    const s = computeStats(items, start, Date.now() + 1000);
    if (!s.seconds) {
      pop.replaceChildren(
        h('div', { class: 'dp-head' }, h('span', { class: 'dp-title' }, h('strong', {}, 'Algorithm Diet'), h('span', { class: 'muted' }, 'Today'))),
        h('p', { class: 'dp-empty' }, 'Nothing on your plate yet today. Pages you read here are scored A to E as you browse.'),
        h('div', { class: 'dp-foot' }, h('span', {}, 'Click for your whole diet')),
      );
      return;
    }
    // Hour by hour: bar height is time, colour the hour's grade.
    const hours = Array.from({ length: 24 }, () => ({ seconds: 0, n: { ...ZERO } as Nutrients }));
    for (const [v, l] of items) {
      if (l.category === 'plumbing' || !(v.seconds > 0)) continue;
      const hour = hours[new Date(v.at).getHours()];
      hour.seconds += v.seconds;
      hour.n = add(hour.n, scale(l.nutrients, v.seconds));
    }
    const now = new Date().getHours();
    // At least the last six hours, so one busy hour doesn't fill the strip.
    const first = Math.min(hours.findIndex((x) => x.seconds > 0), now - 5);
    const shownHours = hours.slice(Math.max(0, first), now + 1);
    const peak = Math.max(...shownHours.map((x) => x.seconds), 1);
    pop.replaceChildren(
      h(
        'div',
        { class: 'dp-head' },
        gradeChip(s.grade, 34),
        h('span', { class: 'dp-title' }, h('strong', {}, VERDICT[s.grade]), h('span', { class: 'muted' }, `Today · ${duration(s.seconds)} · ${s.visits} pages`)),
        h('span', { class: 'dp-health' }, h('strong', {}, String(Math.round(s.health))), h('span', { class: 'muted' }, 'health')),
      ),
      h('div', { class: 'dp-stack', 'aria-hidden': 'true' }, ...s.slices.map((sl) => h('span', { style: `width:${sl.share * 100}%;background:${CATEGORY[sl.category].color}` }))),
      h(
        'div',
        { class: 'dp-hours', 'aria-label': 'Hour by hour' },
        ...shownHours.map((x, i) =>
          h('span', {
            title: `${String(Math.max(0, first) + i).padStart(2, '0')}:00 · ${duration(x.seconds)}`,
            style: `--h:${(x.seconds / peak) * 100}%;background:${x.seconds ? GRADE_COLOR[grade(scale(x.n, 1 / x.seconds))] : 'transparent'}`,
          }),
        ),
      ),
      h('div', { class: 'dp-hours-axis' }, h('span', {}, `${String(Math.max(0, first)).padStart(2, '0')}:00`), h('span', {}, 'now')),
      h(
        'div',
        { class: 'dp-list' },
        ...s.slices.map((sl) => {
          const c = CATEGORY[sl.category];
          return h(
            'div',
            { class: 'dp-row', style: `--tint:${c.color}` },
            icon(c.icon, 14),
            h('span', { class: 'dp-name' }, c.title),
            h('span', { class: 'dp-time' }, duration(sl.seconds)),
            h('span', { class: 'dp-bar', style: `--w:${Math.max(2, sl.share * 100)}%` }),
          );
        }),
      ),
      h('div', { class: 'dp-foot' }, h('span', {}, s.sites[0] ? `Top: ${s.sites[0].host}` : ''), h('span', {}, 'Click for more')),
    );
  }

  function show() {
    clearTimeout(hideTimer);
    if (shown) return;
    clearTimeout(showTimer);
    showTimer = window.setTimeout(async () => {
      const r = button!.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      await load().catch(() => undefined);
      shown = true;
      pop.classList.add('shown');
    }, 220);
  }

  function hide(now = false) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(
      () => {
        shown = false;
        pop.classList.remove('shown');
      },
      now ? 0 : 160,
    );
  }

  button.addEventListener('mouseenter', show);
  button.addEventListener('mouseleave', () => hide());
  button.addEventListener('focus', show);
  button.addEventListener('blur', () => hide());
  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', () => hide());
  const open = () => {
    hide(true);
    cmd('diet:open')();
  };
  button.addEventListener('click', open);
  pop.addEventListener('click', open);

  // While shown, today's numbers follow the tracker.
  on('diet:visit', (v: DietVisit) => {
    if (!shown || v.at < startOfDay(Date.now())) return;
    const i = today.findIndex((x) => x.id === v.id);
    if (i >= 0) today[i] = v;
    else today.push(v);
    void db.hints().then((hints) => draw(today.map((x) => [x, classify(x, hints)] as Labeled)));
  });
  on('diet:hints', () => shown && void load());
}
