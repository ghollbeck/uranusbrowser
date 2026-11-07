/**
 * The Algorithm Diet in the background: live tracking of what you read and watch, and the bridge
 * to the on-device model. Port of the iOS app's DietTracker.swift (sampling) and the live half of
 * DietEngine.swift (asking Woof about a new site as you browse).
 *
 * Time only comes from uninterrupted samples (every 5 s) of the active tab of the focused normal
 * window, never wall-clock gaps: a minimised window, a locked screen, another app in front or an
 * idle Mac (no input for 2 min) add nothing, unless a video on that tab is playing (a talk on a
 * second display is still watched). Incognito
 * windows are never recorded (and run their own background, which doesn't track at all). The page
 * is read in the extension's isolated world: its title, description, a visible article or
 * transcript excerpt and the playing video's clock. No form values, no network requests.
 */
import { broadcast, handle } from './hub';
import { classify, hintKey, type DietHints } from './lib/dietClassifier';
import * as db from './lib/dietDb';
import { normalizedHost, type DietCategory, type DietVisit } from './lib/dietModel';
import { CLASSIFY_SYSTEM, classifyPrompt, parseAnswer } from './lib/dietChat';

export const DIET_PAGE = 'diet.html';
const TICK = 5_000;
const IDLE_SECONDS = 120;
const TRACKING_KEY = 'diet.tracking';

export interface DietDeps {
  /** The on-device model, through Uranus Browser's helper; undefined in incognito. */
  complete?: (request: { system: string; user: string; maxTokens: number }) => Promise<string>;
  modelInfo?: () => Promise<{ ready: boolean; label: string; detail: string } | undefined>;
  /** Opens a page in a new tab of the main window. */
  openTab: (url: string) => void;
}

/** Only uninterrupted foreground time counts. A delayed timer must not turn sleep into browsing (DietTiming.swift). */
export function elapsedSince(previous: number | undefined, now: number, cadence = TICK) {
  if (previous === undefined || now < previous || now - previous > cadence * 2) return 0;
  return now - previous;
}

/** Playback since the last sample, in seconds: pauses add nothing, a big jump is a seek. */
export function watchedSince(previous: number | undefined, now: number | undefined, elapsedSeconds: number) {
  if (elapsedSeconds <= 0 || previous === undefined || now === undefined || !Number.isFinite(previous) || !Number.isFinite(now)) return 0;
  const delta = now - previous;
  if (delta < 0 || delta > elapsedSeconds * 2 + 0.5) return 0;
  return Math.min(delta, elapsedSeconds * 2);
}

interface PageProbe {
  url: string;
  contentURL: string | null;
  title: string | null;
  description: string | null;
  channel: string | null;
  videoTime: number | null;
  excerpt: string | null;
}

/** Runs in the page (isolated world): visible article/transcript text only, never form values or hidden nodes. */
function probe(): PageProbe {
  const meta = (n: string) => (document.querySelector(`meta[name="${n}"],meta[property="${n}"]`) as HTMLMetaElement | null)?.content ?? null;
  const visible = (e: Element | null) => {
    if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const videos = Array.from(document.querySelectorAll('video'));
  const video = videos.find((v) => !v.paused) || videos.find((v) => v.currentTime > 0);
  const ch = document.querySelector('#owner #channel-name a, ytd-channel-name a, .slim-owner-channel-name, [itemprop="author"] [itemprop="name"]');
  const root = Array.from(document.querySelectorAll('article, [role="article"], ytd-transcript-renderer, ytd-transcript-segment-list-renderer'))
    .filter(visible)
    .sort((a, b) => Math.abs(a.getBoundingClientRect().top - innerHeight / 3) - Math.abs(b.getBoundingClientRect().top - innerHeight / 3))[0];
  const permalink = root?.querySelector('a[href*="/p/"],a[href*="/reel/"],a[href*="/status/"]') as HTMLAnchorElement | null | undefined;
  let contentURL: string | null = null;
  if (permalink) {
    const link = new URL(permalink.href, location.href);
    if (link.origin === location.origin) contentURL = link.href;
  }
  let excerpt: string | null = null;
  if (root) {
    const parts: string[] = [];
    let length = 0;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walk.nextNode() && length < 2400) {
      const node = walk.currentNode;
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('script,style,nav,form,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]')) continue;
      const text = (node.textContent ?? '').trim();
      if (text) {
        parts.push(text);
        length += text.length;
      }
    }
    excerpt = parts.join(' ').replace(/\s+/g, ' ').slice(0, 2400) || null;
  }
  return {
    url: location.href,
    contentURL,
    title: document.title || null,
    description: (meta('description') || meta('og:description') || '').slice(0, 500) || null,
    channel: ch ? (ch.textContent || ch.getAttribute('content') || '').trim().slice(0, 80) || null : null,
    videoTime: video && !video.seeking ? video.currentTime : null,
    excerpt,
  };
}

export function registerDiet(deps: DietDeps) {
  let enabled = true;
  let current: DietVisit | undefined;
  let currentTab: number | undefined;
  let lastVideoTime: number | undefined;
  let lastSample: number | undefined;
  let sampling = false;
  let generation = 0;
  let hints: DietHints | undefined;
  const asked = new Set<string>();
  let asking = false;

  const ready = chrome.storage.local.get(TRACKING_KEY).then((v) => {
    enabled = v[TRACKING_KEY] !== false;
  });

  function reset() {
    generation += 1;
    current = undefined;
    currentTab = undefined;
    lastVideoTime = undefined;
    lastSample = undefined;
  }

  async function readPage(tabId: number): Promise<PageProbe | undefined> {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: probe });
      return res?.result as PageProbe | undefined;
    } catch {
      return undefined; // a page scripts can't run on (the Web Store, an error page)
    }
  }

  async function step() {
    if (sampling) return;
    sampling = true;
    try {
      await ready;
      if (!enabled) return reset();
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
      if (!win || win.incognito || win.state === 'minimized' || win.id === undefined) return reset();
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (!tab?.id || tab.incognito || !/^https?:/.test(tab.url ?? '')) return reset();
      const token = generation;
      const [state, page] = await Promise.all([chrome.idle.queryState(IDLE_SECONDS).catch(() => 'active' as const), readPage(tab.id)]);
      if (token !== generation || !enabled || !page || page.url !== tab.url) return reset();
      const now = performance.now();
      // Not in front, or nobody at the Mac: only a playing video counts.
      const away = state !== 'active' || !win.focused;
      const contentURL = page.contentURL ?? page.url;

      if (current?.url !== contentURL || currentTab !== tab.id) {
        // Something new on screen. While away, only a page with a video that has started is recorded.
        reset();
        if (away && !(page.videoTime && page.videoTime > 0)) return;
        const mine = generation;
        currentTab = tab.id;
        lastVideoTime = page.videoTime ?? undefined;
        lastSample = now;
        const host = normalizedHost(new URL(page.url).hostname);
        const [added] = await db.insertVisits([
          {
            url: contentURL,
            host,
            title: page.title ?? tab.title ?? '',
            at: Date.now(),
            seconds: 0,
            watchSeconds: 0,
            description: page.description ?? undefined,
            channel: page.channel ?? undefined,
            excerpt: page.excerpt ?? undefined,
            source: 'live',
          },
        ]);
        if (mine !== generation) return;
        current = added;
        if (added) visitChanged(added);
        return;
      }

      const elapsed = elapsedSince(lastSample, now) / 1000;
      const watched = watchedSince(lastVideoTime, page.videoTime ?? undefined, elapsed);
      lastSample = now;
      lastVideoTime = page.videoTime ?? undefined;
      if (away && watched <= 0) return; // away and no video playing: the clock doesn't run
      const v = { ...current };
      v.seconds += elapsed;
      v.watchSeconds = (v.watchSeconds ?? 0) + watched;
      if (page.title) v.title = page.title;
      if (page.description) v.description = page.description;
      if (page.channel) v.channel = page.channel;
      if (page.excerpt) v.excerpt = page.excerpt;
      current = v;
      await db.updateVisit(v);
      visitChanged(v);
    } catch (err) {
      console.warn('Uranus Browser diet: sample failed', err instanceof Error ? err.message : err);
      reset();
    } finally {
      sampling = false;
    }
  }

  function visitChanged(v: DietVisit) {
    broadcast('diet:visit', v);
    void classifyLiveIfNeeded(v);
  }

  /** New browsing never needs a manual classification run: an unknown site (or a video with no title cues) goes to Woof once. */
  async function classifyLiveIfNeeded(visit: DietVisit) {
    if (asking || !deps.complete) return;
    hints ??= await db.hints().catch(() => ({ hosts: {}, titles: {} }));
    const label = classify(visit, hints);
    const video = label.kind === 'video' && label.method === 'domain';
    if (label.category !== 'other' && !video) return;
    const key = video ? hintKey(visit.host, visit.title) : visit.host;
    if (!visit.title || asked.has(key)) return;
    asked.add(key);
    asking = true;
    try {
      const info = await deps.modelInfo?.().catch(() => undefined);
      if (!info?.ready) return;
      const line = `1. ${visit.host} — ${visit.title.slice(0, 160)} — ${(visit.description ?? '').slice(0, 300)} — ${(visit.excerpt ?? '').slice(0, 600)}`;
      const text = await deps.complete({ system: CLASSIFY_SYSTEM, user: classifyPrompt(video ? 'video' : 'website', [line]), maxTokens: 64 });
      const category: DietCategory | undefined = parseAnswer(text).get(1);
      if (!category) return;
      const found = video ? { titles: { [key]: category } } : { hosts: { [key]: category } };
      await db.saveHints(found, 'woof');
      hints = await db.hints();
      broadcast('diet:hints', found);
    } catch {
      // the model isn't there or failed: the rules' answer stands
    } finally {
      asking = false;
    }
  }

  setInterval(() => void step(), TICK);
  chrome.tabs.onActivated.addListener(() => void step());
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.status === 'complete' || change.title) void step();
  });
  chrome.windows.onFocusChanged.addListener(() => void step());
  chrome.idle.onStateChanged.addListener(() => void step());
  chrome.idle.setDetectionInterval(IDLE_SECONDS);

  handle({
    'diet:open': () => openDiet(deps),
    'diet:open-url': (url: string) => {
      if (typeof url === 'string' && /^https?:\/\//.test(url)) deps.openTab(url);
    },
    'diet:tracking': async (on?: boolean) => {
      await ready;
      if (typeof on === 'boolean') {
        enabled = on;
        reset();
        await chrome.storage.local.set({ [TRACKING_KEY]: on });
        broadcast('diet:tracking', on);
      }
      return enabled;
    },
    'diet:model': async () => (await deps.modelInfo?.().catch(() => undefined)) ?? { ready: false, label: 'Underdog Woof 2B 1.1', detail: 'Uranus Browser’s helper isn’t running.' },
    'diet:complete': async (request: { system: string; user: string; maxTokens: number }) => {
      if (!deps.complete) throw new Error('The on-device model needs Uranus Browser’s helper.');
      return deps.complete({ system: String(request.system), user: String(request.user), maxTokens: Number(request.maxTokens) || 256 });
    },
    // The page erased or imported: drop what the tracker holds so the next sample starts fresh.
    'diet:reset': () => {
      reset();
      hints = undefined;
      asked.clear();
    },
  });
}

/** Opens the Diet in a tab, or brings the open one forward. */
export async function openDiet(deps: Pick<DietDeps, 'openTab'>, hash = '') {
  const url = chrome.runtime.getURL(DIET_PAGE);
  // Match patterns don't cover chrome-extension:// URLs, so compare addresses instead.
  const open = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(url) && !t.incognito);
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true, ...(hash ? { url: `${url}${hash}` } : {}) });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  deps.openTab(`${url}${hash}`);
}
