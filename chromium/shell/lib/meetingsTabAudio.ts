/**
 * Adding the meeting tab's sound to a recording that is already running.
 *
 * Chromium refuses `chrome.tabCapture.getMediaStreamId` unless the extension was "invoked" for
 * that tab (the activeTab grant), and it only grants that on a user gesture in ITS OWN UI: a
 * click on one of the extension's context-menu items, or one of its keyboard commands. A click
 * in Uranus Browser's Agent panel doesn't count. So while a recording runs, this module keeps one
 * context-menu item on web pages ("Uranus Browser: add this tab's audio to the meeting notes") and
 * answers the extension's keyboard command; either one, and only either one, asks for the
 * stream id, in the same turn as the click (that click is the grant), and hands it to the
 * capture page, which adds the tab's sound mid-recording.
 *
 * It takes the chrome APIs it uses as a parameter, so the menu's life (only while recording,
 * removed on stop), the one-click path, a repeated click and a refusal are unit-tested with fakes.
 */

export const MENU_ID = 'anus-meeting-tab-audio';
export const MENU_TITLE = 'Uranus Browser: add this tab’s audio to the meeting notes';
export const COMMAND = 'anus-add-tab-audio';
export const MENU_CONTEXTS = ['page', 'frame', 'video', 'audio', 'selection'] as const;

export interface TabLike {
  id?: number;
  url?: string;
}

export interface TabAudioDeps {
  contextMenus: {
    create(props: { id: string; title: string; contexts: string[] }): unknown;
    remove(id: string): Promise<void> | void;
    onClicked: { addListener(fn: (info: { menuItemId: string | number }, tab?: TabLike) => void): void };
  };
  commands: {
    onCommand: { addListener(fn: (command: string, tab?: TabLike) => void): void };
    getAll(): Promise<Array<{ name?: string; shortcut?: string }>>;
  };
  tabCapture: { getMediaStreamId(options: { targetTabId: number }): Promise<string> };
  /** The tab, if it is a page that can be captured at all, as the meeting module sees it. */
  accept(tab: TabLike): boolean;
  /** Hands the stream id to the capture page. */
  attach(streamId: string, tab: { id: number; url: string }): void;
  /** Says something to the user (a refusal, a repeat click); undefined clears it. */
  say(message: string | undefined): void;
}

/** The plain how-to shown while a recording has no tab audio yet. */
export function tabAudioHint(v: { tabAudioMenu: string; tabAudioShortcut: string }): string {
  // The shortcut first: it works wherever the focus is. The menu item is only in the page's own right-click menu
  // (not the sidebar's tab menu), which is easy to miss.
  if (v.tabAudioShortcut) {
    return `Remote participants’ audio isn’t being captured yet. Click the meeting tab, then press ${v.tabAudioShortcut}. Or right-click inside the meeting page (not the sidebar) and choose “${v.tabAudioMenu}”.`;
  }
  return `Remote participants’ audio isn’t being captured yet. Right-click inside the meeting page (not the sidebar) and choose “${v.tabAudioMenu}”.`;
}

/** What to tell the user when Chromium says no. */
export function refusal(error: unknown): string {
  const why = error instanceof Error ? error.message : String(error ?? '');
  if (/not been invoked|activeTab/i.test(why)) {
    return 'Chromium didn’t allow capturing this tab. Use the right-click menu item (or the keyboard shortcut) on the meeting page itself, not from the panel.';
  }
  if (/chrome:|cannot be captured|Chrome pages/i.test(why)) return 'This kind of page can’t be captured.';
  if (/another|already|active stream/i.test(why)) return 'This tab’s sound is already being captured by something else.';
  return 'The meeting tab’s sound couldn’t be captured.';
}

export function createTabAudio(deps: TabAudioDeps) {
  let active = false;
  let menuShown = false;
  let attachedTab: number | undefined;

  /** The menu exists only while a recording is running. */
  function setActive(on: boolean) {
    active = on;
    if (on && !menuShown) {
      menuShown = true;
      deps.contextMenus.create({ id: MENU_ID, title: MENU_TITLE, contexts: [...MENU_CONTEXTS] });
    } else if (!on) {
      attachedTab = undefined;
      if (menuShown) {
        menuShown = false;
        void Promise.resolve(deps.contextMenus.remove(MENU_ID)).catch(() => undefined);
      }
    }
  }

  /**
   * The user's gesture. `getMediaStreamId` is called before anything else, in this same turn.
   * Returns a promise only so tests can wait for the outcome.
   */
  function gesture(tab: TabLike | undefined): Promise<void> {
    if (!active) return Promise.resolve();
    if (!tab || tab.id === undefined || !tab.url || !deps.accept(tab)) {
      deps.say('This page can’t be recorded. Use the menu on the meeting’s own tab.');
      return Promise.resolve();
    }
    const id = tab.id;
    const url = tab.url;
    if (attachedTab === id) {
      deps.say('This tab’s audio is already being added to the notes.');
      return Promise.resolve();
    }
    const asked = deps.tabCapture.getMediaStreamId({ targetTabId: id });
    return asked.then(
      (streamId) => {
        if (!active) return;
        attachedTab = id;
        deps.say(undefined);
        deps.attach(streamId, { id, url });
      },
      (error) => {
        if (active) deps.say(refusal(error));
      },
    );
  }

  deps.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) void gesture(tab);
  });
  deps.commands.onCommand.addListener((command, tab) => {
    if (command === COMMAND) void gesture(tab);
  });

  return {
    setActive,
    gesture,
    /** The capture page lost or replaced the tab's sound (the tab closed, say). */
    detached: () => {
      attachedTab = undefined;
    },
    attachedTab: () => attachedTab,
    /** The shortcut Chromium actually assigned (empty if another extension or the browser has it). */
    async shortcut(): Promise<string> {
      try {
        return (await deps.commands.getAll()).find((c) => c.name === COMMAND)?.shortcut ?? '';
      } catch {
        return '';
      }
    },
  };
}
