/**
 * While the agent works, the page it works on says so: a soft blue glow around its edges,
 * a small "Controlled by …" card with Take over and Stop, which you can drag anywhere on the
 * page (where you leave it is remembered for every page), and the agent's own pointer, which
 * glides to whatever the agent clicks or types into and ripples as it acts.
 *
 * All of it lives in the extension's isolated world, inside a closed shadow root hung on <html>
 * (not <body>), so the page's scripts can't reach it and the agent's read_page doesn't see it.
 * The glow and the pointer take no clicks; only the card does.
 *
 * The glow fades in once, when a run starts, and then stays, breathing slowly, until the run
 * ends: across tool calls, short gaps between them, and navigations in the tab (the new page
 * gets it already on, at the same point of its breath).
 */
import type { ChatSnapshot } from '../shared/browserAgent';

export interface AgentOverlayContext {
  /** The Chromium tab the agent is looking at: the main window's active one. */
  activeChromeId(): number | undefined;
  /** Who the agent works as, for the card's "Controlled by …". */
  companion(): { name: string; hue: number };
  takeOver(): void;
  stop(): void;
}

/** Where the card was left, as fractions of the page's width and height. */
interface CardPosition {
  x: number;
  y: number;
}

/** A point in the page's viewport, in CSS px. */
export interface PagePoint {
  x: number;
  y: number;
}

/** What the page draws; `on: false` fades it all away. */
export interface OverlayState {
  on: boolean;
  name: string;
  hue: number;
  text: string;
  waiting: boolean;
  position?: CardPosition;
  /** Already on (a run going on, a new page in its tab): appear without the entrance. */
  steady?: boolean;
  /** When the run started (ms since the epoch): every page breathes in step with it. */
  since?: number;
  /** The page area's corner radius, in the page's CSS px. */
  radius?: number;
  /** Where the agent's pointer was last, so a new page's pointer starts from there. */
  pointer?: PagePoint;
}

const POSITION_KEY = 'agentOverlayPosition';
/**
 * The page area's corner radius in the window: kAnusPageCornerRadius (patch 0024:
 * kAnusWindowCornerRadius 20 - kAnusGap 8); --page-radius in the shell's tokens.css.
 */
export const PAGE_RADIUS = 12;
/**
 * Between two steps of a run the host may say "idle" for a moment; the glow only goes when the
 * agent has been idle this long.
 */
const IDLE_GRACE_MS = 900;

export function registerAgentOverlay(ctx: AgentOverlayContext) {
  let position: CardPosition | undefined;
  void chrome.storage.local.get(POSITION_KEY).then((saved) => {
    const p = saved[POSITION_KEY] as CardPosition | undefined;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) position = { x: clamp01(p.x), y: clamp01(p.y) };
  });

  /** The tab now showing the overlay, and what it shows. */
  let shownIn: number | undefined;
  let last: OverlayState = { on: false, name: '', hue: 0, text: '', waiting: false };
  let busy = false;
  /** When this run's glow came on; undefined while the agent rests. */
  let since: number | undefined;
  /** Tabs whose page has had the glow this run: they get it again without an entrance. */
  const glowed = new Set<number>();
  /** Where the agent's pointer was last, per tab. */
  const pointers = new Map<number, PagePoint>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** The page area's corner radius in that tab's CSS px: none in full screen, less when zoomed in. */
  async function radiusIn(chromeId: number) {
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    const window = tab ? await chrome.windows.get(tab.windowId).catch(() => undefined) : undefined;
    if (window?.state === 'fullscreen') return 0;
    const zoom = await chrome.tabs.getZoom(chromeId).catch(() => 1);
    return PAGE_RADIUS / (zoom || 1);
  }

  async function stateFor(chromeId: number): Promise<OverlayState> {
    return {
      ...last,
      position,
      since,
      steady: last.on && glowed.has(chromeId),
      radius: await radiusIn(chromeId),
      pointer: pointers.get(chromeId),
    };
  }

  async function draw(chromeId: number, state: OverlayState, pointAt?: PagePoint, immediately = false) {
    const [result] = await chrome.scripting
      .executeScript({ target: { tabId: chromeId }, func: renderAgentOverlay, args: [state, pointAt ?? null], world: 'ISOLATED', injectImmediately: immediately } as any)
      // UrAnus Browser's own pages, the Web Store and error pages can't take scripts: no overlay there.
      .catch(() => [undefined]);
    if (state.on && result) glowed.add(chromeId);
    return result;
  }

  async function sync() {
    const target = busy ? ctx.activeChromeId() : undefined;
    if (shownIn !== undefined && shownIn !== target) {
      const was = shownIn;
      shownIn = undefined;
      await draw(was, { ...last, on: false });
    }
    if (target === undefined) return;
    shownIn = target;
    await draw(target, await stateFor(target));
  }

  // The active tab changed: the overlay follows.
  chrome.tabs.onActivated.addListener(() => busy && void sync());
  // A new page in the tab: put the overlay back as soon as the page exists, already on, so the
  // page never shows without it (and the glow doesn't come in again).
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    if (!busy || frameId !== 0 || tabId !== shownIn) return;
    void stateFor(tabId).then((state) => draw(tabId, state, undefined, true));
  });
  // In case the early one didn't take (the page wasn't ready for scripts yet).
  chrome.tabs.onUpdated.addListener((chromeId, info) => {
    if (busy && chromeId === shownIn && info.status === 'complete') void sync();
  });
  // Zooming the page changes how many of its px the corner is.
  chrome.tabs.onZoomChange?.addListener(({ tabId }) => {
    if (busy && tabId === shownIn) void sync();
  });
  chrome.tabs.onRemoved.addListener((chromeId) => {
    glowed.delete(chromeId);
    pointers.delete(chromeId);
  });

  chrome.runtime.onMessage.addListener((message: { type?: string; op?: string; x?: number; y?: number }, sender) => {
    if (message?.type !== 'anus-agent-overlay' || sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    if (sender.tab.id !== shownIn) return;
    if (message.op === 'takeOver') ctx.takeOver();
    else if (message.op === 'stop') ctx.stop();
    else if (message.op === 'moved' && Number.isFinite(message.x) && Number.isFinite(message.y)) {
      position = { x: clamp01(message.x!), y: clamp01(message.y!) };
      void chrome.storage.local.set({ [POSITION_KEY]: position });
    }
  });

  function apply(next: OverlayState) {
    const changed = next.on !== last.on || next.text !== last.text || next.name !== last.name || next.waiting !== last.waiting;
    if (next.on && !last.on) since = Date.now();
    if (!next.on) {
      since = undefined;
      glowed.clear();
      pointers.clear();
    }
    last = next;
    busy = next.on;
    if (changed) void sync();
  }

  return {
    onChat(snapshot: ChatSnapshot | undefined) {
      const status = snapshot?.status ?? 'idle';
      const companion = ctx.companion();
      const next: OverlayState = {
        on: status !== 'idle',
        name: companion.name,
        hue: companion.hue,
        text: status === 'waiting' ? 'Waiting for your approval' : snapshot?.activity || 'Working on task',
        waiting: status === 'waiting',
      };
      clearTimeout(idleTimer);
      // A blink of "idle" between two steps isn't the end of the run.
      if (!next.on && last.on) idleTimer = setTimeout(() => apply(next), IDLE_GRACE_MS);
      else apply(next);
    },

    /**
     * Glides the agent's pointer to `point` in tab `chromeId` and ripples there; resolves when
     * it arrives, which is when the action should happen. Nothing (at once) if the agent isn't
     * working or the page takes no scripts.
     */
    async pointAt(chromeId: number, point: PagePoint) {
      if (!busy) return;
      // The tool's tab just came forward and the overlay hasn't followed it yet.
      if (shownIn !== chromeId) await sync();
      if (shownIn !== chromeId) return;
      const result = await draw(chromeId, await stateFor(chromeId), point);
      if (result) pointers.set(chromeId, point);
    },
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// ---- in the page (isolated world): self-contained, it's serialized -----------------------

/**
 * Draws (or updates) the overlay; with `pointAt`, also glides the agent's pointer there and
 * resolves once it has arrived (the click's ripple starts then).
 */
export function renderAgentOverlay(state: OverlayState, pointAt: PagePoint | null): Promise<boolean> | boolean {
  type Overlay = {
    host: HTMLElement;
    glow: HTMLElement;
    card: HTMLElement;
    title: HTMLElement;
    text: HTMLElement;
    dot: HTMLElement;
    pointer: HTMLElement;
    hideTimer?: number;
    restTimer?: number;
    /** Made before the page had a root element; it goes in as soon as there is one. */
    mounting?: boolean;
    moved?: boolean;
    pos?: CardPosition;
    at?: PagePoint;
    placeAt(p: CardPosition | undefined): void;
  };
  const PERIOD = 5200; // one breath of the glow, ms
  const g = globalThis as unknown as { __anusAgentOverlay?: Overlay };
  let o = g.__anusAgentOverlay;
  if (o && !o.host.isConnected && !o.mounting) o = g.__anusAgentOverlay = undefined;

  if (!state.on) {
    if (!o) return false;
    const overlay = o;
    overlay.host.dataset.on = 'false';
    clearTimeout(overlay.hideTimer);
    overlay.hideTimer = window.setTimeout(() => {
      overlay.host.remove();
      if (g.__anusAgentOverlay === overlay) g.__anusAgentOverlay = undefined;
    }, 700);
    return true;
  }

  if (!o) {
    const host = document.createElement('anus-agent-overlay');
    // Out of the page's layout and reach; nothing here takes clicks but the card.
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { --blue: 56 132 255; --radius: 12px; }
      :host([data-waiting='true']) { --blue: 245 166 35; }
      /* The glow follows the page area's rounded corners (the window clips the page to them),
         so a corner is the same soft fade as an edge, not a cut-off square. */
      .glow {
        position: fixed; inset: 0; pointer-events: none; border-radius: var(--radius);
        opacity: 0; transition: opacity 600ms cubic-bezier(0.37, 0, 0.63, 1);
      }
      .glow::before {
        content: ''; position: absolute; inset: 0; border-radius: inherit;
        box-shadow:
          inset 0 0 0 1.5px rgb(var(--blue) / 0.55),
          inset 0 0 28px 6px rgb(var(--blue) / 0.38),
          inset 0 0 120px 24px rgb(var(--blue) / 0.22);
        transition: box-shadow 400ms ease;
        animation: breathe ${PERIOD}ms cubic-bezier(0.37, 0, 0.63, 1) infinite;
        animation-delay: var(--phase, 0ms);
      }
      :host([data-on='true']) .glow { opacity: 1; }
      @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.62; } }
      .pointer {
        /* Offset so the arrow's tip (2.8, 2.8 in its box) sits on the point. */
        position: fixed; left: -2.8px; top: -2.8px; width: 26px; height: 26px; pointer-events: none;
        transform-origin: 2.8px 2.8px;
        opacity: 0; transition: opacity 260ms ease; will-change: transform;
        filter: drop-shadow(0 2px 4px rgb(0 0 0 / 0.32));
      }
      .pointer.shown { opacity: 1; }
      .pointer svg { display: block; width: 26px; height: 26px; overflow: visible; transform-origin: 2.8px 2.8px; }
      .pointer path { paint-order: stroke; }
      .ripple {
        position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
        border-radius: 50%; pointer-events: none; box-sizing: border-box;
        border: 2px solid rgb(var(--blue) / 0.9); background: rgb(var(--blue) / 0.18);
        animation: ripple 520ms cubic-bezier(0.2, 0, 0.2, 1) forwards;
      }
      @keyframes ripple { from { transform: scale(0.35); opacity: 1; } to { transform: scale(1.25); opacity: 0; } }
      .card {
        position: fixed; pointer-events: auto; box-sizing: border-box;
        width: 352px; max-width: calc(100vw - 24px);
        font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
        color: #f2f2f3; background: rgb(28 28 30 / 0.94);
        border: 1px solid rgb(255 255 255 / 0.1); border-radius: 14px;
        box-shadow: 0 10px 34px rgb(0 0 0 / 0.38), 0 1px 3px rgb(0 0 0 / 0.3);
        -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
        cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
        opacity: 0; transform: translateY(6px) scale(0.98);
        transition: opacity 220ms ease, transform 220ms ease;
      }
      :host([data-on='true']) .card { opacity: 1; transform: none; }
      .card.dragging { cursor: grabbing; transition: none; box-shadow: 0 18px 48px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(var(--blue) / 0.6); }
      .title {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        padding: 6px 12px 5px; font-size: 11.5px; font-weight: 500; color: rgb(255 255 255 / 0.62);
        border-bottom: 1px solid rgb(255 255 255 / 0.08);
      }
      .title svg { width: 12px; height: 12px; opacity: 0.8; }
      .row { display: flex; align-items: center; gap: 10px; padding: 9px 10px 9px 12px; }
      .dot {
        flex: none; width: 22px; height: 22px; border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, hsl(var(--hue) 80% 72%), hsl(var(--hue) 62% 48%));
        box-shadow: 0 0 0 2px rgb(var(--blue) / 0.35);
        animation: pulse 1.6s ease-in-out infinite;
      }
      @keyframes pulse { 50% { box-shadow: 0 0 0 5px rgb(var(--blue) / 0.12); } }
      .text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: rgb(255 255 255 / 0.85); }
      button {
        flex: none; height: 28px; padding: 0 12px; border-radius: 8px; border: 0;
        font-family: inherit; font-size: 12.5px; font-weight: 600; line-height: 1; cursor: pointer;
      }
      .takeover { background: #fff; color: #111; }
      .takeover:hover { background: #e9e9ec; }
      .stop { background: #e5484d; color: #fff; }
      .stop:hover { background: #d93b40; }
      @media (prefers-reduced-motion: reduce) {
        .glow::before, .dot { animation: none; }
        .card, .pointer { transition: none; }
        .ripple { animation-name: ripple-still; }
        @keyframes ripple-still { from { opacity: 1; } to { opacity: 0; } }
      }
    `);
    root.adoptedStyleSheets = [sheet];

    const svg = (viewBox: string, d: string, attrs: Record<string, string>) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', viewBox);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
      s.append(path);
      return s;
    };

    const glow = document.createElement('div');
    glow.className = 'glow';
    // The agent's pointer: an arrow in the glow's colour, its tip on the point it acts on.
    const pointer = document.createElement('div');
    pointer.className = 'pointer';
    pointer.append(
      // A soft arrowhead: every corner rounded, its sides slightly bowed.
      svg(
        '0 0 26 26',
        'M4.3 3.1 C3.4 2.5 2.4 3.1 2.7 4.1 L7.1 20.3 C7.4 21.5 9 21.6 9.5 20.5 L11.7 15.6 C12 15 12.5 14.6 13.2 14.5 L18.5 13.7 C19.7 13.5 20 12 19 11.3 Z',
        { fill: 'rgb(var(--blue))', stroke: '#fff', 'stroke-width': '2', 'stroke-linejoin': 'round' },
      ),
    );
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'status');
    const title = document.createElement('div');
    title.className = 'title';
    const titleText = document.createElement('span');
    title.append(svg('0 0 16 16', 'M3 2l10 5-4.2 1.3L7 13z', { fill: 'currentColor' }), titleText);
    const row = document.createElement('div');
    row.className = 'row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.className = 'text';
    const send = (op: string, extra: object = {}) => void chrome.runtime.sendMessage({ type: 'anus-agent-overlay', op, ...extra }).catch(() => undefined);
    const takeOver = Object.assign(document.createElement('button'), { className: 'takeover', type: 'button', textContent: 'Take over' });
    const stop = Object.assign(document.createElement('button'), { className: 'stop', type: 'button', textContent: 'Stop' });
    takeOver.addEventListener('click', () => send('takeOver'));
    stop.addEventListener('click', () => send('stop'));
    row.append(dot, text, takeOver, stop);
    card.append(title, row);
    root.append(glow, card, pointer);

    // Nothing inside reaches the page's own listeners.
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu', 'keydown', 'wheel']) {
      card.addEventListener(type, (e) => e.stopPropagation());
    }

    const place = (left: number, top: number) => {
      const r = card.getBoundingClientRect();
      const x = Math.min(Math.max(8, left), innerWidth - r.width - 8);
      const y = Math.min(Math.max(8, top), innerHeight - r.height - 8);
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
    };
    const placeAt = (p: CardPosition | undefined) => {
      const r = card.getBoundingClientRect();
      // Bottom centre until you move it.
      const fx = p ? p.x : 0.5;
      const fy = p ? p.y : 1;
      place(fx * (innerWidth - r.width), Math.min(fy * (innerHeight - r.height), innerHeight - r.height - 28));
    };
    o = g.__anusAgentOverlay = { host, glow, card, title: titleText, text, dot, pointer, placeAt, pos: state.position, at: state.pointer };
    const overlay = o;
    addEventListener('resize', () => placeAt(overlay.pos));

    let drag: { id: number; dx: number; dy: number } | undefined;
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('button')) return;
      const r = card.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
      e.preventDefault();
    });
    card.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = undefined;
      card.classList.remove('dragging');
      const r = card.getBoundingClientRect();
      const pos = { x: r.left / Math.max(1, innerWidth - r.width), y: r.top / Math.max(1, innerHeight - r.height) };
      overlay.pos = pos;
      overlay.moved = true;
      send('moved', pos);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);

    // Every page breathes in step with the run, so a new page picks up where the last one was.
    const elapsed = state.since ? Math.max(0, Date.now() - state.since) : 0;
    glow.style.setProperty('--phase', `${-(elapsed % PERIOD)}ms`);
    host.style.setProperty('--radius', `${state.radius ?? 12}px`);
    host.dataset.enter = state.steady ? 'steady' : 'fade';
    // Already on: styled "on" from its first frame, so nothing transitions in. Otherwise it
    // fades in on the next frame.
    if (state.steady) host.dataset.on = 'true';
    const mount = () => {
      overlay.mounting = false;
      document.documentElement.append(host);
      placeAt(state.position);
      if (!state.steady) requestAnimationFrame(() => (host.dataset.on = 'true'));
    };
    if (document.documentElement) mount();
    else {
      overlay.mounting = true;
      // Put in as the page starts: wait for its root element.
      const watch = new MutationObserver(() => {
        if (!document.documentElement) return;
        watch.disconnect();
        mount();
      });
      watch.observe(document, { childList: true });
    }
  } else {
    clearTimeout(o.hideTimer);
    o.host.dataset.on = 'true';
    // Another tab moved the card: follow it, unless it was moved here.
    if (state.position && !o.moved && (o.pos?.x !== state.position.x || o.pos?.y !== state.position.y)) {
      o.pos = state.position;
      o.placeAt(state.position);
    }
    if (state.radius !== undefined) o.host.style.setProperty('--radius', `${state.radius}px`);
  }

  o.host.dataset.waiting = String(state.waiting);
  o.title.textContent = `Controlled by ${state.name || 'UrAnus Browser'}`;
  o.text.textContent = state.text;
  o.dot.style.setProperty('--hue', String(state.hue));
  if (!pointAt) return true;

  // ---- the agent's pointer: glide to the point, ripple, and say when it's there ----------
  const overlay = o;
  const { pointer } = overlay;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const to = { x: Math.round(pointAt.x), y: Math.round(pointAt.y) };
  const shown = pointer.classList.contains('shown');
  // From where it was; the first time, from the card (where the agent "sits").
  const card = overlay.card.getBoundingClientRect();
  const from = overlay.at ?? (card.width ? { x: card.left + card.width / 2, y: card.top } : { x: innerWidth / 2, y: innerHeight - 80 });
  const at = (p: PagePoint, tilt = 0) => `translate(${p.x}px, ${p.y}px)${tilt ? ` rotate(${tilt.toFixed(2)}deg)` : ''}`;
  clearTimeout(overlay.restTimer);
  overlay.at = to;
  pointer.getAnimations().forEach((a) => a.cancel());
  pointer.style.transform = at(to);
  pointer.classList.add('shown');
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // Longer moves take a little longer, as a hand's do.
  const duration = still || distance < 2 ? 0 : Math.round(Math.min(560, 340 + distance * 0.22));
  // Out of sight, it first shows where it was.
  const appear = shown || !duration ? 0 : 140;
  let arrived: Promise<unknown> = Promise.resolve();
  if (duration) {
    // A hand doesn't move in straight lines: the path bows a little to one side (a wrist's
    // arc, up rather than down), and the pointer leans into the move and straightens as it
    // lands. Slow off, fast through the middle, slow in.
    const bend = Math.min(90, distance * 0.16);
    let nx = -dy / distance;
    let ny = dx / distance;
    if (ny > 0 || (ny === 0 && nx < 0)) [nx, ny] = [-nx, -ny];
    const control = { x: (from.x + to.x) / 2 + nx * bend, y: (from.y + to.y) / 2 + ny * bend };
    const lean = Math.max(-9, Math.min(9, (dx / Math.max(distance, 1)) * 9));
    const STEPS = 36;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const u = 1 - t;
      const p = { x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y };
      frames.push({ transform: at(p, lean * Math.sin(Math.PI * t)) });
    }
    if (appear) pointer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: appear, easing: 'ease-out' });
    const glide = pointer.animate(frames, { duration, delay: appear, fill: 'backwards', easing: 'cubic-bezier(0.45, 0, 0.25, 1)' });
    arrived = Promise.race([
      glide.finished.catch(() => undefined),
      // A background page may not run animations: don't hold the action for it.
      new Promise((resolve) => setTimeout(resolve, appear + duration + 60)),
    ]);
  }
  return arrived.then(() => {
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = `${to.x}px`;
    ripple.style.top = `${to.y}px`;
    pointer.before(ripple);
    setTimeout(() => ripple.remove(), 600);
    // A small press, like a finger on a trackpad.
    if (!still) {
      pointer.firstElementChild?.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.84)', offset: 0.4 }, { transform: 'scale(1)' }], {
        duration: 240,
        easing: 'cubic-bezier(0.37, 0, 0.63, 1)',
      });
    }
    // It rests out of sight when the agent hasn't moved it for a while.
    overlay.restTimer = window.setTimeout(() => pointer.classList.remove('shown'), 3000);
    return true;
  });
}
