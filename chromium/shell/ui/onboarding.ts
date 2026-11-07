import type { IconName } from './icons.js';
import type { AnusApi, UiState } from '../../shared/types';
import { browserDetail, importSummary, ARC_MAPPING, ARC_LIMITS, ARC_PASSWORDS } from './browserImport.js';
import { LOGO_TILE } from './logo.js';

/**
 * The first-run tour, full window: steps on the left, a live miniature UrAnus Browser on the right
 * that reacts to what you choose and to the real shortcuts you press. Your first Space is
 * set up for real as you go. It comes back from Help → Welcome to UrAnus Browser.
 */

type H = (tag: string, props?: Record<string, unknown>, ...children: Array<Node | string | null | undefined>) => HTMLElement;
type DetectedBrowser = Awaited<ReturnType<AnusApi['detectBrowsers']>>[number];

const STEPS = ['welcome', 'space', 'import', 'try', 'dev', 'permissions', 'done'] as const;
type Step = (typeof STEPS)[number];

const EMOJIS = ['🏠', '💼', '🚀', '🧪', '🛠️', '🎨', '📚', '🧠', '🎮', '🌱', '☕️', '⚡️'];
const COLORS = ['#cdd9f7', '#c9e3f5', '#cfe8ec', '#d3ecd5', '#f5e7c4', '#f7dcc0', '#f4cfdc', '#e8d6f3'];

/** Shortcuts to try in the tour, in order. */
const CHALLENGES: Array<{ id: string; label: string; done: string }> = [
  { id: 'newTab', label: 'Open the command bar', done: 'Tabs, history, actions: one box.' },
  { id: 'toggleSidebar', label: 'Hide the sidebar', done: 'Hover the left edge to bring it back.' },
  { id: 'splitNew', label: 'Split the view', done: 'Or drag any tab onto the page.' },
];

/** Where UrAnus Browser looks for each browser's app icon, by the name the importer reports. */
const APP_NAMES: Record<string, string> = {
  Chrome: 'Google Chrome',
  'Google Chrome': 'Google Chrome',
  Brave: 'Brave Browser',
  Edge: 'Microsoft Edge',
  'Microsoft Edge': 'Microsoft Edge',
  Firefox: 'Firefox',
  Safari: 'Safari',
  Arc: 'Arc',
  Vivaldi: 'Vivaldi',
  Opera: 'Opera',
  Chromium: 'Chromium',
};

export function setupOnboarding(api: AnusApi, h: H, icon: (name: IconName) => SVGElement) {
  const root = document.getElementById('onboarding')!;
  let step: Step = 'welcome';
  let state: UiState | undefined;
  let browsers: DetectedBrowser[] | undefined;
  const appIcons = new Map<string, string | undefined>();
  const imported = new Map<string, string>();
  const importErrors = new Map<string, string>();
  let includeArcPasswords = true;
  const importing = new Set<string>();
  const tried = new Set<string>();
  let drawn = '';
  /** The step the last draw showed; its entrance animation only plays when the step changes. */
  let shownStep: Step | undefined;

  // ---- the live miniature -----------------------------------------------------------

  const mockTabs = h(
    'div',
    { class: 'mock-tabs' },
    ...[
      ['#e4572e', 62],
      ['#3aa6d9', 78],
      ['#1f9d5b', 54],
      ['#6d5bd0', 70],
    ].map(([color, width], i) =>
      h('div', { class: `mock-row${i === 0 ? ' active' : ''}` }, h('i', { style: `background:${color}` }), h('b', { style: `width:${width}%` })),
    ),
  );
  const mockServers = h('div', { class: 'mock-servers' });
  const typed = h('span', { class: 'mock-typed' });
  const mock = h(
    'div',
    { class: 'mock' },
    h(
      'div',
      { class: 'mock-side' },
      h('div', { class: 'mock-lights' }, h('i'), h('i'), h('i')),
      h('div', { class: 'mock-url' }, h('b')),
      mockServers,
      h('div', { class: 'mock-space' }, h('span', { class: 'mock-emoji' }), h('span', { class: 'mock-name' })),
      mockTabs,
    ),
    h(
      'div',
      { class: 'mock-pages' },
      ...['a', 'b'].map((side) =>
        h('div', { class: `mock-page ${side}` }, h('div', { class: 'mock-hero' }), h('b', { style: 'width:72%' }), h('b', { style: 'width:88%' }), h('b', { style: 'width:64%' }), h('div', { class: 'mock-cards' }, h('i'), h('i'), h('i'))),
      ),
    ),
    h(
      'div',
      { class: 'mock-palette' },
      h('div', { class: 'mock-input' }, icon('search'), typed, h('i', { class: 'mock-caret' })),
      h('div', { class: 'mock-results' }, h('b', { class: 'on' }), h('b'), h('b')),
    ),
  );

  const left = h('section', { class: 'tour-left' });
  const progress = h('i');
  const progressBar = h('div', { class: 'tour-progress' }, progress);

  let typingTimer: number | undefined;
  /** Plays what a shortcut does in the miniature. */
  function play(command: string) {
    if (command === 'newTab' || command === 'openLocation') {
      mock.classList.add('palette');
      const text = 'flecha.oprimo.dev';
      let i = 0;
      typed.textContent = '';
      clearInterval(typingTimer);
      typingTimer = window.setInterval(() => {
        typed.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(typingTimer);
          setTimeout(() => mock.classList.remove('palette'), 900);
        }
      }, 55);
    } else if (command === 'toggleSidebar') {
      mock.classList.toggle('no-sidebar');
    } else if (command === 'splitNew') {
      mock.classList.add('split');
    }
  }

  function updateMock() {
    if (!state) return;
    const space = state.spaces.find((s) => s.id === state!.activeSpaceId);
    mock.style.setProperty('--mock-tint', state.tint);
    mock.querySelector('.mock-emoji')!.textContent = space?.emoji ?? '';
    mock.querySelector('.mock-name')!.textContent = space?.name ?? '';
    mockServers.replaceChildren(
      ...(step === 'dev' ? state.localServers.slice(0, 3) : []).map((s) =>
        h('div', { class: 'mock-server' }, h('i'), h('span', {}, s.name), h('small', {}, `:${s.port}`)),
      ),
    );
    mock.dataset.step = step;
  }

  // ---- steps ---------------------------------------------------------------------

  const go = (next: Step) => {
    step = next;
    mock.classList.remove('palette', 'no-sidebar', 'split');
    if (next === 'try') for (const id of tried) play(id);
    draw();
  };
  const next = () => go(STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]);
  const back = () => go(STEPS[Math.max(STEPS.indexOf(step) - 1, 0)]);
  const finish = () => {
    root.classList.add('leaving');
    setTimeout(() => {
      root.classList.remove('leaving');
      api.finishOnboarding();
    }, 380);
  };

  const keys = (id: string) => state?.shortcuts[id] || '';
  const space = () => state?.spaces.find((s) => s.id === state!.activeSpaceId);

  function heading(kicker: string, title: string, lead: string) {
    return h('header', { class: 'tour-head' }, h('span', { class: 'tour-kicker' }, kicker), h('h2', {}, title), h('p', { class: 'tour-lead' }, lead));
  }

  function welcome() {
    return h(
      'div',
      { class: 'tour-step tour-welcome' },
      h('h1', {}, 'Your browser,', h('br'), h('em', {}, 'sharpened.')),
      h(
        'p',
        { class: 'tour-lead' },
        state?.onboardingReplay
          ? 'Welcome back. Walk through UrAnus Browser again without resetting your tabs, Spaces, passwords or settings. Imports and other changes happen only when you choose them.'
          : 'Keep tabs tidy in Spaces, find anything from the command bar, and use tools built for developers.',
      ),
      h(
        'p',
        { class: 'tour-note' },
        'Early release, provided as is. Bugs can expose data or cause data loss. Keep a backup. The agent can act in signed-in tabs, and cloud AI can send page content or meeting data to a provider. Get everyone’s permission before recording. See Settings → Privacy.',
      ),
    );
  }

  function spaceStep() {
    const sp = space();
    if (!sp) return h('div');
    if (state?.onboardingReplay) return h(
      'div', { class: 'tour-step' },
      heading('Your Spaces', 'Everything stays in place', 'Spaces keep your work, personal and side projects apart. Replaying the tour keeps your existing names, colours and tabs.'),
      h('div', { class: 'tour-note' }, `${state.spaces.length} Spaces · Current Space: ${sp.emoji || ''} ${sp.name}`),
      h('p', { class: 'tour-lead' }, 'You can edit your Spaces later from the sidebar or Settings → Tabs & Spaces.'),
    );
    const name = h('input', { class: 'tour-input', value: sp.name, maxlength: '40', spellcheck: 'false', placeholder: 'Personal, Work, Side project…' }) as HTMLInputElement;
    name.addEventListener('input', () => name.value.trim() && api.updateSpace(sp.id, { name: name.value }));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && next());
    const theme = state?.theme ?? 'system';
    return h(
      'div',
      { class: 'tour-step' },
      heading('Your first Space', 'Give it a name and a colour', 'Spaces keep work, personal and side projects apart, each with its own tabs and colour. Make more anytime.'),
      name,
      h(
        'div',
        { class: 'tour-emojis' },
        ...EMOJIS.map((emoji) => h('button', { class: `tour-emoji${sp.emoji === emoji ? ' on' : ''}`, onclick: () => api.updateSpace(sp.id, { emoji }) }, emoji)),
      ),
      h(
        'div',
        { class: 'tour-swatches' },
        ...COLORS.map((color) => h('button', { class: `tour-swatch${sp.color === color ? ' on' : ''}`, style: `--swatch:${color}`, onclick: () => api.updateSpace(sp.id, { color }) })),
      ),
      h(
        'div',
        { class: 'tour-segmented' },
        ...(['system', 'light', 'dark'] as const).map((t) =>
          h('button', { class: theme === t ? 'on' : '', onclick: () => api.setPreferences({ theme: t }) }, t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'),
        ),
      ),
    );
  }

  function browserIcon(b: DetectedBrowser) {
    const appName = APP_NAMES[b.name] ?? b.name;
    if (!appIcons.has(appName)) {
      appIcons.set(appName, undefined);
      api.appIcon(appName).then((url) => {
        appIcons.set(appName, url);
        if (step === 'import') draw();
      });
    }
    const url = appIcons.get(appName);
    return url ? h('img', { class: 'tour-app-icon', src: url, alt: '' }) : h('span', { class: 'tour-app-icon letter' }, b.name[0]);
  }

  async function runImport(b: DetectedBrowser, passwordsOnly = false) {
    importing.add(b.id);
    draw();
    try {
      const result = await api.importBrowser(b.id, { passwords: passwordsOnly || includeArcPasswords, passwordsOnly });
      importErrors.delete(b.id);
      if (!result.spaces && !result.bookmarks && !result.history && !result.passwords && result.warnings.length) importErrors.set(b.id, importSummary(result));
      else imported.set(b.id, importSummary(result));
    } catch {
      importErrors.set(b.id, 'Couldn’t import this one. Try again.');
    }
    importing.delete(b.id);
    draw();
  }

  function importStep() {
    if (!browsers) {
      api.detectBrowsers().then(
        (found) => ((browsers = found), step === 'import' && draw()),
        () => ((browsers = []), step === 'import' && draw()),
      );
    }
    const list = !browsers
      ? h('div', { class: 'tour-note' }, h('span', { class: 'tour-spinner' }), 'Looking for your browsers…')
      : !browsers.length
        ? h('div', { class: 'tour-note' }, 'No other browsers with data on this Mac. You can import later from Settings › Import.')
        : h(
            'div',
            { class: 'tour-browsers' },
            ...browsers.map((b) => {
              const done = imported.get(b.id);
              const busy = importing.has(b.id);
              return h(
                'div',
                { class: `tour-browser${done ? ' done' : ''}${busy ? ' busy' : ''}` },
                browserIcon(b),
                h('span', { class: 'tour-browser-text' }, h('strong', {}, b.name), h('small', {}, importErrors.get(b.id) ?? done ?? browserDetail(b))),
                done
                  ? (b.id === 'arc' ? h('button', { class: 'tour-ghost', disabled: busy, onclick: () => runImport(b, true) }, busy ? 'Importing…' : 'Import passwords') : h('span', { class: 'tour-done' }, icon('check')))
                  : h('button', { class: 'tour-ghost', disabled: busy, onclick: () => runImport(b) }, busy ? 'Importing…' : 'Import'),
              );
            }),
          );
    return h(
      'div',
      { class: 'tour-step tour-import' },
      heading('Move in', 'Bring your stuff over', 'Bring your Arc sidebar and saved passwords with you, or import bookmarks and history from another browser.'),
      h('p', { class: 'tour-note' }, ARC_MAPPING),
      h('label', { class: 'tour-note' }, h('input', { type: 'checkbox', checked: includeArcPasswords, onchange: (event: Event) => { includeArcPasswords = (event.target as HTMLInputElement).checked; } }), ' ', ARC_PASSWORDS),
      list,
      h('p', { class: 'tour-note' }, ARC_LIMITS),
    );
  }

  function tryStep() {
    const current = CHALLENGES.find((c) => !tried.has(c.id));
    return h(
      'div',
      { class: 'tour-step' },
      heading('Muscle memory', 'Try it for real', 'Press the keys. The preview on the right does what UrAnus Browser does. (You can change every shortcut in Settings.)'),
      h(
        'div',
        { class: 'tour-challenges' },
        ...CHALLENGES.map((c) => {
          const done = tried.has(c.id);
          return h(
            'button',
            { class: `tour-challenge${done ? ' done' : ''}${c === current ? ' current' : ''}`, onclick: () => tourKey(c.id) },
            h('kbd', { class: 'tour-key' }, keys(c.id) || '—'),
            h('span', { class: 'tour-challenge-text' }, h('strong', {}, c.label), h('small', {}, done ? c.done : c === current ? 'Press the keys now' : '')),
            done ? h('span', { class: 'tour-done' }, icon('check')) : null,
          );
        }),
      ),
    );
  }

  function devStep() {
    const servers = state?.localServers ?? [];
    return h(
      'div',
      { class: 'tour-step' },
      heading('For developers', 'Built for the web you build', servers.length ? `UrAnus Browser already found ${servers.length} dev server${servers.length === 1 ? '' : 's'} running on this Mac. They live at the top of the sidebar.` : 'Start a dev server and it shows up at the top of the sidebar, with its console errors.'),
      h(
        'div',
        { class: 'tour-features' },
        feature('sparkle', 'Coding agents', 'Claude Code and Cursor can read, click and debug your tabs over MCP.', h('button', { class: 'tour-ghost', onclick: () => api.openSettings('agents') }, 'Connect')),
        feature('zap', 'Boosts', 'Your own TypeScript and CSS for any site, edited right in UrAnus Browser.', h('kbd', {}, keys('editBoost'))),
        feature('phone', 'Responsive view', 'Desktop and phone side by side, following each other.', h('kbd', {}, keys('responsive'))),
        feature('code', 'Environments', 'Local → staging → prod for the same page, with a badge so prod never looks safe.', h('kbd', {}, keys('nextEnvironment'))),
      ),
    );
  }

  function feature(name: IconName, title: string, text: string, action: HTMLElement) {
    return h('div', { class: 'tour-feature' }, h('span', { class: 'tour-feature-icon' }, icon(name)), h('span', { class: 'tour-feature-text' }, h('strong', {}, title), h('small', {}, text)), action);
  }

  /** What the browser already knows about the microphone and camera, so a row shows "Allowed" once it is. */
  const permission = new Map<string, string>();
  /** Rows whose permission tab is open and unanswered. */
  const asking = new Set<string>();
  function watchPermission(name: 'microphone' | 'camera') {
    if (permission.has(name)) return;
    permission.set(name, 'unknown');
    navigator.permissions
      .query({ name: name as PermissionName })
      .then((status) => {
        const update = () => {
          permission.set(name, status.state);
          if (status.state !== 'prompt') asking.delete(name);
          if (step === 'permissions') draw();
        };
        status.onchange = update;
        update();
      })
      .catch(() => undefined);
  }

  /** Asked now, with a button, so macOS doesn't interrupt later with a notice or a surprise prompt. */
  function permissionsStep() {
    watchPermission('microphone');
    watchPermission('camera');
    const row = (name: IconName, title: string, text: string, kind: 'microphone' | 'camera' | 'appManagement', label: string) => {
      const granted = permission.get(kind) === 'granted';
      // The tour page can't ask for the microphone or camera itself (Chromium gives it no media support), so a tab
      // asks. One at a time: pressing again while it is open would only pile up tabs.
      const waiting = asking.has(kind) && kind !== 'appManagement';
      return feature(
        name,
        title,
        granted ? 'Allowed.' : waiting ? 'A tab opened: choose “Allow while visiting the site” there, then Allow when macOS asks.' : text,
        granted
          ? h('span', { class: 'tour-done' }, icon('check'))
          : h(
              'button',
              {
                class: 'tour-ghost',
                disabled: waiting,
                onclick: () => {
                  api.openPermission(kind);
                  if (kind === 'appManagement') return;
                  asking.add(kind);
                  draw();
                  // Not answered, or the tab was closed: the button comes back.
                  setTimeout(() => (asking.delete(kind), step === 'permissions' && draw()), 45_000);
                },
              },
              waiting ? 'Waiting…' : label,
            ),
      );
    };
    return h(
      'div',
      { class: 'tour-step' },
      heading('Permissions', 'Allow what you want to use', 'Each one is optional, asked here with a button, and changeable later in System Settings › Privacy & Security.'),
      h(
        'div',
        { class: 'tour-features' },
        row('mic', 'Microphone', 'Meeting notes use it only after you press Start, and never keep the audio.', 'microphone', 'Allow…'),
        row('camera', 'Camera', 'Video calls ask for it themselves. Allow it now and macOS asks once, here, not mid-call.', 'camera', 'Allow…'),
        row('shield', 'App management', 'macOS can block UrAnus Browser from changing app files, for example when it updates. Allow it once so you aren’t interrupted.', 'appManagement', 'Open Settings'),
      ),
    );
  }

  function doneStep() {
    const d = state?.defaultBrowser;
    return h(
      'div',
      { class: 'tour-step' },
      heading('Last thing', d?.isDefault ? 'You’re all set' : 'Make it the default?', d?.isDefault ? 'Links from Slack, Mail and your terminal open in UrAnus Browser.' : 'So links from Slack, Mail and your terminal open here instead of somewhere else.'),
      d?.isDefault
        ? h('div', { class: 'tour-note ok' }, h('span', { class: 'tour-done' }, icon('check')), 'UrAnus Browser is your default browser')
        : d?.canSet
          ? h('button', { class: 'tour-ghost big', onclick: () => api.makeDefaultBrowser() }, icon('link'), 'Make UrAnus Browser the default browser')
          : null,
      h('div', { class: 'tour-tips' }, h('span', {}, h('kbd', {}, keys('newTab')), ' Command bar'), h('span', {}, h('kbd', {}, keys('shortcuts')), ' All shortcuts'), h('span', {}, h('kbd', {}, keys('settings')), ' Settings')),
    );
  }

  function primaryLabel() {
    if (step === 'welcome') return 'Let’s go';
    if (step === 'import') return imported.size ? 'Continue' : 'Skip';
    if (step === 'try') return tried.size === CHALLENGES.length ? 'Nice. Continue' : 'Skip';
    if (step === 'done') return 'Start browsing';
    return 'Continue';
  }

  function draw() {
    const body = { welcome, space: spaceStep, import: importStep, try: tryStep, dev: devStep, permissions: permissionsStep, done: doneStep }[step]();
    body.classList.toggle('enter', shownStep !== step);
    shownStep = step;
    const index = STEPS.indexOf(step);
    const focused = document.activeElement as HTMLElement | null;
    const keepCaret = focused?.classList.contains('tour-input') ? (focused as HTMLInputElement).selectionStart : null;
    const brand = h('div', { class: 'tour-brand' }, h('span', { class: 'tour-mark' }), h('span', {}, 'UrAnus Browser'));
    brand.firstElementChild!.innerHTML = LOGO_TILE;
    // The frame (grid, miniature, progress bar) is built once so its animations run on;
    // only the step's own content is redrawn.
    if (!root.firstChild) root.append(h('div', { class: 'tour-grid' }), h('div', { class: 'tour' }, left, h('section', { class: 'tour-stage' }, mock)));
    progress.style.width = `${((index + 1) / STEPS.length) * 100}%`;
    left.replaceChildren(
      h('div', { class: 'tour-top' }, brand, step === 'done' ? null : h('button', { class: 'tour-skip', onclick: finish }, 'Skip tour')),
      body,
      h(
        'footer',
        { class: 'tour-footer' },
        progressBar,
        h(
          'div',
          { class: 'tour-buttons' },
          index ? h('button', { class: 'tour-back', onclick: back }, 'Back') : h('span'),
          h('button', { class: 'tour-primary', onclick: step === 'done' ? finish : next }, primaryLabel(), h('kbd', {}, '↩')),
        ),
      ),
    );
    updateMock();
    // Redrawing replaces the name field; keep typing where you were.
    if (keepCaret !== null) {
      const input = root.querySelector<HTMLInputElement>('.tour-input');
      input?.focus();
      input?.setSelectionRange(keepCaret, keepCaret);
    }
  }

  function tourKey(command: string) {
    if (root.hidden) return;
    play(command);
    const challenge = CHALLENGES.find((c) => c.id === command);
    if (step === 'try' && challenge) {
      tried.add(command);
      draw();
    }
  }

  api.onTourKey(tourKey);
  document.addEventListener('keydown', (e) => {
    if (root.hidden || e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    root.querySelector<HTMLButtonElement>('.tour-primary')?.click();
  });

  return function render(s: UiState) {
    state = s;
    const show = !s.onboarded;
    const starting = show && root.hidden;
    if (starting) {
      step = 'welcome';
      tried.clear();
      imported.clear();
      importErrors.clear();
      browsers = undefined;
    }
    root.hidden = !show;
    if (!show) return;
    // Only what the steps show; other updates (pages loading) would restart the animations.
    const sp = s.spaces.find((x) => x.id === s.activeSpaceId);
    // The name isn't in it: the field already shows what you type, and the miniature follows below.
    const key = JSON.stringify([s.onboardingReplay, s.theme, sp?.emoji, sp?.color, s.defaultBrowser, s.shortcuts, s.localServers.length]);
    if (starting || key !== drawn || !root.firstChild) draw();
    else updateMock();
    drawn = key;
  };
}
