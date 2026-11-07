/**
 * window.anus for the Chromium build: the same API the Electron preload gives the sidebar,
 * over the shell's port. Imported before the sidebar code so it is there when that runs.
 */
import type { AnusApi, PaletteMode, UiState } from '../shared/types';
import { spaceTint } from './lib/spaceTint';
import { systemDark, tweenColor } from './lib/themeFade';
import { cmd, invoke, on, tellWindow } from './client';
import { forWindow } from './lib/windowView';
import { confirmDeleteSpace, confirmDeleteTabs, copy, setupWindowUi, showMenu } from './windowUi';
import { incognito } from './incognito';

const surface = document.documentElement.dataset.surface;
/** UrAnus Browser's own browser draws the window frame from window.html; stock Chromium has the side panel. */
const framed = typeof chrome.anusPrivate?.setFrame === 'function';
if (framed) document.documentElement.dataset.frame = '';
// An incognito window's pages: one Space of tabs, always dark (shell.css, incognito.ts).
if (incognito) document.documentElement.dataset.incognito = '';

/**
 * The background sends the Space's light colour; dark mode darkens it here. Pages follow
 * Chromium's appearance (the system's), not UrAnus Browser's theme setting, until a native patch
 * applies that setting to Chromium; the tint follows the same thing so text stays readable.
 */
const stateListeners: Array<(state: UiState) => void> = [];
let lastState: UiState | undefined;
function emitState(state: UiState) {
  lastState = state;
  // Each window draws its own Space and tab (lib/windowView.ts).
  const own = forWindow(state, ownWindowId);
  const shown = { ...own, tint: spaceTint(own.tint, systemDark.matches), faviconUrls: siteIcons };
  for (const cb of stateListeners) cb(shown);
  applyFrame();
}
on('state', emitState);

/** Cached site images, sent separately so tab state changes do not resend image bytes. */
const siteIcons: Record<string, string> = {};
on('site-icons', (icons: Record<string, string>) => {
  Object.assign(siteIcons, icons);
  if (lastState) emitState(lastState);
});

// The frame page lays its window out: the background says how, this page adds the colour.
let frameState: { sidebar: chrome.anusPrivate.SidebarMode; overlay: boolean; sidebarWidth?: number } | undefined;
/** The width while the user drags the sidebar's edge (sidebarResize.ts), ahead of the store. */
let draggedWidth: number | undefined;
/** False once this browser refused sidebarWidth (built before patch 0044): leave it out. */
let widthSupported = true;
const windowId = surface === 'window' && framed ? chrome.anusPrivate.getWindowId() : undefined;
/**
 * The window this page is in: frame pages ask the browser, the new tab page is one of its tabs.
 * The background is told, so this page's commands act on this window.
 */
let ownWindowId: number | undefined;
void (windowId ?? (surface === 'newtab' ? chrome.tabs.getCurrent().then((tab) => tab?.windowId) : Promise.resolve(undefined)))
  .catch(() => undefined)
  .then((id) => {
    if (id === undefined) return;
    ownWindowId = id;
    tellWindow(id);
    if (lastState) emitState(lastState);
  });
// After a light/dark switch the frame fades on the same curve as the pages (lib/themeFade.ts).
let frameBackground: string | undefined;
let stopFrameFade = () => {};
function applyFrame() {
  if (frameState?.sidebarWidth) {
    document.documentElement.style.setProperty('--sidebar', `${draggedWidth ?? frameState.sidebarWidth}px`);
  }
  if (!windowId || !frameState || !lastState) return;
  stopFrameFade();
  stopFrameFade = tweenColor(frameBackground, spaceTint(forWindow(lastState, ownWindowId).tint, systemDark.matches), (background) => {
    frameBackground = background;
    sendFrame(background);
  });
}
function sendFrame(background: string) {
  const { sidebar, overlay, sidebarWidth } = frameState!;
  const state: chrome.anusPrivate.FrameState = { sidebar, overlay, background };
  if (widthSupported && sidebarWidth) state.sidebarWidth = draggedWidth ?? sidebarWidth;
  void windowId!.then((id) =>
    chrome.anusPrivate.setFrame(state, id).catch((err) => {
      if (!('sidebarWidth' in state)) throw err;
      widthSupported = false;
      document.documentElement.style.removeProperty('--sidebar');
      return chrome.anusPrivate.setFrame({ sidebar, overlay, background }, id);
    }),
  );
}
on('frame', (state) => {
  frameState = state;
  if (draggedWidth !== undefined && !sidebarDragging) draggedWidth = undefined;
  applyFrame();
});

let sidebarDragging = false;
/** sidebarResize.ts: lays the window out at `width` while dragging; undefined when the drag ends. */
export function previewSidebarWidth(width: number | undefined) {
  sidebarDragging = width !== undefined;
  if (width !== undefined) draggedWidth = width;
  if (frameState && frameBackground) sendFrame(frameBackground);
  if (draggedWidth !== undefined) document.documentElement.style.setProperty('--sidebar', `${draggedWidth}px`);
}
/** Whether the window can be laid out with another sidebar width (patch 0044). */
export const sidebarResizable = () => framed && widthSupported && !!frameState?.sidebarWidth;

// The Agent panel beside the page (patch 0042), or floating over it (patch 0043), where the
// browser has it. A browser without 0043 refuses `floating`: the panel docks instead.
if (windowId && typeof chrome.anusPrivate.setAgentPanel === 'function') {
  type Panel = { open: boolean; side: 'left' | 'right'; width: number; focusWindow?: number; float?: { x: number; y: number; width: number; height: number } };
  on('agentPanel', (panel: Panel) => {
    void windowId.then(async (id) => {
      const state = { open: panel.open, side: panel.side, width: panel.width, focus: panel.focusWindow === id };
      try {
        await chrome.anusPrivate.setAgentPanel(panel.float ? { ...state, floating: panel.float } : state, id);
      } catch (err) {
        if (!panel.float) return console.error('UrAnus Browser shell: the Agent panel didn’t move', err);
        await chrome.anusPrivate.setAgentPanel(state, id).catch(() => undefined);
      }
    });
  });
}

const paletteListeners: Array<(mode: PaletteMode) => void> = [];
const renameListeners: Array<(tabId: string) => void> = [];
setupWindowUi({ rename: (tabId) => renameListeners.forEach((cb) => cb(tabId)), state: () => lastState && forWindow(lastState, ownWindowId) });
systemDark.addEventListener('change', () => lastState && emitState(lastState));
// Tabs a server themed for the old scheme reload (serverThemedTabs.ts). Every window reports;
// a repeat finds nothing left to reload.
if (surface === 'window') systemDark.addEventListener('change', () => cmd('colorScheme')(systemDark.matches));

const api: AnusApi = {
  onState: (cb) => void stateListeners.push(cb),
  // The command bar lives in the sidebar; new tab pages have their own search.
  onPalette: (cb) => {
    if (surface !== 'panel' && surface !== 'window') return;
    paletteListeners.push(cb);
    on('palette', cb);
  },
  onEditSpace: (cb) => on('edit-space', cb),
  onRenameTab: (cb) => {
    renameListeners.push(cb);
    on('rename-tab', cb);
  },
  onPeek: (cb) => on('peek', cb),
  onDownloads: (cb) => on('downloads', cb),
  onTourKey: (cb) => on('tour-key', cb),
  onFlash: (cb) => on('flash', cb),
  ready: cmd('ready'),
  searchHistory: (query) => invoke('searchHistory', query),
  parkedShot: () => (ownWindowId === undefined ? Promise.resolve(undefined) : invoke<string | undefined>('parkedShot', ownWindowId)),
  // Extensions can't read other apps' icons; the onboarding falls back to the name.
  appIcon: async () => undefined,
  detectBrowsers: () => invoke('detectBrowsers'),
  importBrowser: (id, options) => invoke('importBrowser', id, options),
  // On the new tab page, what you type opens in this tab.
  newTab: surface === 'newtab' ? cmd('navigate') : cmd('newTab'),
  navigate: cmd('navigate'),
  activate: cmd('activate'),
  close: cmd('close'),
  back: cmd('back'),
  forward: cmd('forward'),
  reload: cmd('reload'),
  switchSpace: cmd('switchSpace'),
  newSpace: cmd('newSpace'),
  updateSpace: cmd('updateSpace'),
  setSpaceIsolated: cmd('setSpaceIsolated'),
  // Electron asks first, in a message box; the page asks in its own dialog.
  deleteSpace: (id) => void confirmDeleteSpace(id),
  // Electron pops native menus; the page draws them, from items the background builds.
  tabMenu: (id) => void showMenu('tabMenu', id),
  spaceMenu: (id) => void showMenu('spaceMenu', id),
  toggleFolder: cmd('toggleFolder'),
  togglePinnedCollapsed: cmd('togglePinnedCollapsed'),
  renameFolder: cmd('renameFolder'),
  moveTab: cmd('moveTab'),
  moveTabs: cmd('moveTabs'),
  moveTabsToSpace: cmd('moveTabsToSpace'),
  pinInNewFolder: cmd('pinInNewFolder'),
  archiveTabs: cmd('archiveTabs'),
  deleteTabs: (ids) => void confirmDeleteTabs(ids),
  tabsMenu: (ids, only) => void showMenu('tabsMenu', ids, only),
  flash: cmd('flash'),
  clearToday: cmd('clearToday'),
  undoClose: cmd('undoClose'),
  // Brings over UrAnus Browser's own Electron state (~/Library/Application Support/Anus Browser/anus-state.json).
  importMenu: async () => {
    // UrAnus Browser's native host reads it straight from disk; the file picker is for when it isn't installed.
    const json = await invoke<string | undefined>('nativeHost:anusState').catch(() => undefined);
    if (json) {
      if (confirm('Replace your Spaces and tabs with those of UrAnus Browser (Electron)?')) cmd('importAnusState')(json);
      return;
    }
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) cmd('importAnusState')(await file.text());
    };
    input.click();
  },
  // The frame grows over the page first, as in Electron; the side panel just opens it. A new
  // tab page has no command bar of its own: its search opens the window's (or the panel's).
  openPalette: surface === 'panel' ? (mode) => paletteListeners.forEach((cb) => cb(mode)) : cmd('openPalette'),
  closePalette: surface === 'window' ? cmd('closePalette') : () => undefined,
  toggleSidebar: cmd('toggleSidebar'),
  setSidebarWidth: cmd('setSidebarWidth'),
  setSidebarPeek: cmd('setSidebarPeek'),
  // The page can write the clipboard itself; the background has no document to do it from.
  copyText: (text, message) => void copy(String(text), typeof message === 'string' ? message : 'Link copied'),
  renameTab: cmd('renameTab'),
  toggleMute: cmd('toggleMute'),
  capturePage: cmd('capturePage'),
  clearSiteData: cmd('clearSiteData'),
  setSitePermission: cmd('setSitePermission'),
  zoom: cmd('zoom'),
  openDevTools: cmd('openDevTools'),
  openSettings: cmd('openSettings'),
  openPermission: cmd('permissions:open'),
  toggleResponsive: cmd('toggleResponsive'),
  showConsole: cmd('showConsole'),
  editBoost: cmd('editBoost'),
  openBoostsFolder: cmd('openBoostsFolder'),
  splitWith: cmd('splitWith'),
  setTabDragging: cmd('setTabDragging'),
  dropToSplit: cmd('dropToSplit'),
  splitNew: cmd('splitNew'),
  closePeek: cmd('closePeek'),
  // Chromium opens a download only in answer to a click, which a message to the background loses.
  openDownload: (id) => {
    if (typeof chrome.downloads?.open !== 'function') return cmd('openDownload')(id);
    void chrome.downloads.search({ id: Number(id) }).then(([item]) => {
      if (item?.state === 'complete') return chrome.downloads.open(item.id);
    });
  },
  revealDownload: cmd('revealDownload'),
  cancelDownload: cmd('cancelDownload'),
  clearDownloads: cmd('clearDownloads'),
  promotePeek: cmd('promotePeek'),
  finishOnboarding: cmd('finishOnboarding'),
  setPreferences: cmd('setPreferences'),
  makeDefaultBrowser: cmd('makeDefaultBrowser'),
  newAnusMini: cmd('newAnusMini'),
};

window.anus = api;
