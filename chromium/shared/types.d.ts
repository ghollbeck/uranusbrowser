export interface TabInfo {
  importedArcId?: string;
  id: string;
  url: string;
  title: string;
  favicon?: string;
  /** A name the user gave the tab; page titles no longer replace it. */
  customTitle?: string;
  /** Playing sound right now (not persisted). */
  audible?: boolean;
  muted?: boolean;
  /** A phone-sized mirror opened by the responsive split. */
  device?: 'mobile';
  /** Pinned and favorite tabs remember where they started, like Arc. */
  homeUrl?: string;
  loading?: boolean;
  lastActive: number;
  /** Back/forward entries (with scroll position) so a tab comes back as it was after a restart. */
  history?: { entries: Array<{ url: string; title: string; pageState?: string }>; index: number };
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export type PinnedNode =
  | { kind: 'tab'; tabId: string }
  | { kind: 'folder'; id: string; name: string; open: boolean; children: PinnedNode[] };

export interface Space {
  importedArcId?: string;
  id: string;
  name: string;
  emoji?: string;
  color: string;
  pinned: PinnedNode[];
  today: string[];
  activeTabId?: string;
  /** Separate cookies, storage and logins from the other Spaces. */
  isolated?: boolean;
  /** Two tabs shown side by side (left, right) whenever either one is active. */
  split?: [string, string];
  /** `responsive`: the right side is a phone-sized mirror that follows the left side's navigation. */
  splitMode?: 'responsive';
  /** Share of the width the left pane takes, 0.2–0.8. Half and half when unset. */
  splitRatio?: number;
  /** The pinned tabs are folded away under the Space's name (only the active one still shows). */
  pinnedCollapsed?: boolean;
}

export interface ArchivedTab {
  url: string;
  title: string;
  closedAt: number;
}

/**
 * One action that closed tabs, kept so ⌘Z in the sidebar (and ⇧⌘T) can put them back where they
 * were: same Space, folder and position, with their history.
 */
export interface ClosedTabs {
  closedAt: number;
  /** In the order they went; each comes back before the tab that followed it then. */
  tabs: Array<{ tab: TabInfo; to: TabPlacement; index: number }>;
  /** A pinned folder deleted with its tabs: it comes back whole, tabs inside. */
  folder?: { node: Extract<PinnedNode, { kind: 'folder' }>; spaceId: string; parentId?: string; beforeId?: string; index: number };
  /** A pinned tab or favorite that was only unloaded: it opens again at the page it showed. */
  unloaded?: { tabId: string; url: string; history?: TabInfo['history'] };
  /** The tab that was on screen, shown again on undo. */
  activeTabId?: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisit: number;
}

/** Another browser on this Mac with data Uranus Browser can bring over. */
export interface DetectedBrowser {
  id: string;
  name: string;
  profiles: number;
  hasBookmarks: boolean;
  hasHistory: boolean;
}

/** Password access is requested only when explicitly selected in the import UI. */
export interface BrowserImportOptions { passwords?: boolean; passwordsOnly?: boolean }

/** What one import brought over, with partial failures in warnings. */
export interface ImportResult {
  passwords?: number;
  passwordsSkipped?: number;
  spaces: number;
  bookmarks: number;
  history: number;
  warnings: string[];
}

export interface DownloadInfo {
  id: string;
  filename: string;
  path: string;
  url: string;
  received: number;
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startedAt: number;
}

export interface EnvironmentTarget {
  label: string;
  origin: string;
}

/** One project's origins, e.g. local → staging → production. */
export interface Environment {
  id: string;
  name: string;
  targets: EnvironmentTarget[];
}

export interface ActiveEnvironment {
  name: string;
  label: string;
  tone: 'local' | 'staging' | 'production';
  /** The same page on the project's other environments. */
  switches: Array<{ label: string; tone: ActiveEnvironment['tone']; url: string }>;
}

/** A dev server found listening on this machine. */
export interface LocalServer {
  port: number;
  url: string;
  /** The project folder it runs in, or the process name. */
  name: string;
}

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'brave' | 'kagi' | 'ecosia';

export interface BrowserState {
  spaces: Space[];
  activeSpaceId: string;
  favorites: string[];
  tabs: Record<string, TabInfo>;
  archive: ArchivedTab[];
  /** The last tab closes and deletes, newest first, for undo. */
  recentlyClosed?: ClosedTabs[];
  sidebarVisible: boolean;
  /** The sidebar's width in px, set by dragging its right edge (200–480). Default 260. */
  sidebarWidth?: number;
  window?: WindowBounds;
  theme?: 'system' | 'light' | 'dark';
  /** Links that leave a pinned tab or favorite open in Peek. Default on. */
  peekPinnedLinks?: boolean;
  /** Links arriving from other apps open in a AnusMini instead of a tab. Default on. */
  openLinksInAnusMini?: boolean;
  /** Today tabs untouched this long are archived; 0 keeps them forever. Default 12. */
  archiveAfterHours?: number;
  /** Remembered answers to site permission prompts, by origin then permission. */
  sitePermissions?: Record<string, Record<string, 'allow' | 'block'>>;
  searchEngine?: SearchEngineId;
  /** Where downloads go; the system Downloads folder when unset. */
  downloadsFolder?: string;
  askWhereToSave?: boolean;
  environments?: Environment[];
  /** Built-in ad and tracker blocking; on unless turned off. */
  adBlock?: boolean;
  /** The MCP bridge for coding agents: off unless turned on in Settings. */
  agent?: { enabled: boolean; token: string };
  /** The welcome tour has been finished (or skipped). */
  onboarded?: boolean;
  /** Existing-profile tour replay: show Space setup without changing it. */
  onboardingReplay?: boolean;
  /** Your own keyboard shortcuts by command id (Electron accelerators); null removes a shortcut. */
  keybindings?: Record<string, string | null>;
}

/** One row of Settings → Keyboard Shortcuts. */
export interface ShortcutInfo {
  id: string;
  group: string;
  label: string;
  /** For display ("⇧⌘T"); empty when the command has no shortcut. */
  keys: string;
  /** Differs from Uranus Browser's default. */
  changed?: boolean;
  /** A family of keys like ⌘1…⌘9, shown but not recordable. */
  fixed?: boolean;
}

export interface UiState extends BrowserState {
  nav: { canGoBack: boolean; canGoForward: boolean; zoom: number };
  searchEngineName: string;
  /** The active Space's colour, darkened in dark mode. */
  tint: string;
  /** docked: always there. hidden: a hover strip at the left edge. floating: shown over the page until the mouse leaves. */
  sidebarMode: 'docked' | 'hidden' | 'floating';
  /** Set when the active tab is on one of the configured environments. */
  environment?: ActiveEnvironment;
  localServers: LocalServer[];
  /** Console errors since each tab's last page load (only tabs that have some). */
  consoleErrors: Record<string, number>;
  /** Hosts that have a boost (script or styles), for the sidebar's ⚡ marker. */
  boostedHosts: string[];
  /** Cached website images as data URLs, keyed by site origin. */
  faviconUrls?: Record<string, string>;
  /** What a coding agent is doing, for the sidebar. */
  agent?: { connected: boolean; tabId?: string; action?: string; busy: boolean };
  /** Current shortcut per command, for display ("⌘T"); empty when removed. */
  shortcuts: Record<string, string>;
  defaultBrowser: { isDefault: boolean; canSet: boolean };
  /**
   * With more than one window (Chromium build): what each shows, by Chromium window id. The
   * state's own activeSpaceId and activeTabIds are the focused window's.
   */
  windows?: {
    /** The other windows' Space and tab. */
    views: Record<number, { spaceId: string; tabId?: string }>;
    /** The tab on screen in each window. */
    showing: Record<number, string>;
    /** Windows whose tab another window took: their new tab page says where it went. */
    parked: Record<number, string>;
  };
  /** Filled in by a page for its own window: tabs on screen in another window. */
  shownElsewhere?: string[];
  /** Filled in by a page for its own window: its tab, which another window has now. */
  parkedTab?: string;
}

export type PaletteMode = 'new-tab' | 'navigate' | 'split';

export interface PeekState {
  url: string;
  title: string;
  /** Where the peek page sits, so the sidebar UI can draw its toolbar right above it. */
  bounds: { x: number; y: number; width: number; height: number };
}

export type DropTarget =
  | { zone: 'favorites'; beforeTabId?: string }
  | { zone: 'today'; beforeTabId?: string }
  | { zone: 'pinned'; folderId?: string; beforeTabId?: string };

/**
 * A place in any Space, for Settings → Tabs & Spaces. `beforeId` is a tab (or, in pinned, a folder)
 * in that list; without it, or when it isn't there, the item goes at the end.
 */
export type TabPlacement =
  | { zone: 'favorites'; beforeId?: string }
  | { zone: 'today'; spaceId: string; beforeId?: string }
  | { zone: 'pinned'; spaceId: string; folderId?: string; beforeId?: string };

/** What a AnusMini's toolbar shows. */
export interface AnusMiniState {
  /** Empty until something has been opened. */
  url: string;
  title: string;
  favicon?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** The active Space's colour, darkened in dark mode; the toolbar wears it. */
  tint: string;
  /** Where "Open in Uranus Browser" puts the page. */
  space: { name: string; emoji?: string };
  searchEngineName: string;
}

/** A AnusMini toolbar's bridge: the small window for links from other apps and quick lookups. */
export interface AnusMiniApi {
  onState(cb: (state: AnusMiniState) => void): void;
  /** ⌘L: start editing the address. */
  onEditAddress(cb: () => void): void;
  /** A short confirmation in place of the address ("Link copied"). */
  onFlash(cb: (message: string) => void): void;
  ready(): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  /** A URL or a search, resolved like the command bar. */
  navigate(input: string): void;
  copyLink(): void;
  /** Moves the page into the main window as a Today tab and closes the AnusMini. */
  openInAnus(): void;
  close(): void;
}

/** What the settings page shows. */
export interface SettingsView {
  adBlock: boolean;
  searchEngine: SearchEngineId;
  searchEngines: Array<{ id: SearchEngineId; name: string }>;
  /** For display only, with the home folder shortened to ~. */
  downloadsFolder: string;
  askWhereToSave: boolean;
  defaultBrowser: { isDefault: boolean; canSet: boolean };
  /** Edited as text: one `label origin` per line. */
  environments: Array<{ id: string; name: string; targetsText: string }>;
  agent: { enabled: boolean; endpoint?: string; token?: string };
  /** Why Uranus Browser's native host (imports, the agent bridge) last failed; undefined while it works. */
  hostError?: string;
  theme: 'system' | 'light' | 'dark';
  archiveAfterHours: number;
  peekPinnedLinks: boolean;
  shortcuts: ShortcutInfo[];
  /** Set after recording a shortcut another command had, which lost it. */
  notice?: string;
  openLinksInAnusMini: boolean;
}

/** The downloads folder is only changed through the folder picker, never set directly. */
export type SettingsPatch = Partial<Omit<SettingsView, 'searchEngines' | 'downloadsFolder' | 'defaultBrowser' | 'agent' | 'shortcuts' | 'notice'>> & {
  agentEnabled?: boolean;
  /** An accelerator, null for no shortcut, or 'default' to go back to Uranus Browser's. */
  shortcut?: { id: string; keys: string | null };
  resetShortcuts?: boolean;
};

/** A key pressed while Settings records a shortcut. */
export interface RecordedKey {
  code: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** Settings → Tabs & Spaces: favorites and every Space at once, for editing like a bookmarks manager. */
export interface TabsView {
  favorites: string[];
  spaces: Array<Pick<Space, 'id' | 'name' | 'emoji' | 'color' | 'pinned' | 'today' | 'isolated'>>;
  activeSpaceId: string;
  tabs: Record<string, Pick<TabInfo, 'id' | 'url' | 'title' | 'customTitle' | 'favicon' | 'homeUrl'> & { open: boolean }>;
  /** Hosts whose icon is cached and served as `favicon://<host>`. */
  faviconHosts: string[];
}

/** Where a folder can go: the pinned tabs of a Space, optionally inside another folder. */
export interface FolderPlacement {
  spaceId: string;
  folderId?: string;
  beforeId?: string;
}

/** One change made in Settings → Tabs & Spaces. Deleting a folder or a Space asks first, in a native dialog. */
export type TabsEdit =
  | { op: 'renameTab'; tabId: string; title: string }
  | { op: 'setUrl'; tabId: string; url: string }
  | { op: 'move'; tabIds: string[]; to: TabPlacement }
  | { op: 'delete'; tabIds: string[] }
  | { op: 'add'; url: string; title?: string; to: TabPlacement }
  | { op: 'newFolder'; spaceId: string; parentId?: string }
  | { op: 'renameFolder'; folderId: string; name: string }
  | { op: 'deleteFolder'; folderId: string }
  | { op: 'moveFolder'; folderId: string; to: FolderPlacement }
  | { op: 'newSpace' }
  | { op: 'updateSpace'; spaceId: string; name?: string; emoji?: string; color?: string }
  | { op: 'deleteSpace'; spaceId: string }
  | { op: 'moveSpace'; spaceId: string; beforeSpaceId?: string };

export interface TabsEditResult {
  view: TabsView;
  /** The folder or Space just made, so it can be named right away. */
  created?: string;
  /** Why nothing changed, e.g. an address that doesn't parse. */
  error?: string;
}

/** What a right-click on tabs or a folder asks the page to do; the rest happens in main. */
export type TabsMenuAction = 'rename' | 'edit';

export interface SettingsApi {
  get(): Promise<SettingsView>;
  set(patch: SettingsPatch): Promise<SettingsView>;
  chooseDownloadsFolder(): Promise<SettingsView>;
  makeDefaultBrowser(): Promise<SettingsView>;
  newAgentToken(): Promise<SettingsView>;
  copy(text: string): Promise<void>;
  openBoosts(): Promise<void>;
  /** Plays the welcome tour again in the browser window. */
  showTour(): Promise<void>;
  /** Other browsers on this Mac with bookmarks or history to bring over. */
  detectBrowsers(): Promise<DetectedBrowser[]>;
  /** Imports one of the browsers `detectBrowsers` found, by id. */
  importBrowser(id: string, options?: BrowserImportOptions): Promise<ImportResult>;
  /** Imports the bookmarks in a file exported from any browser as HTML, given its text. */
  importBookmarksFile(html: string, fileName?: string): Promise<ImportResult>;
  onPane(cb: (pane: string) => void): void;
  /** ⌘F while Settings is in front: focus its search field. */
  onFind(cb: () => void): void;
  /** Something the background shows here changed on its own (the agent bridge, the native host); `get` again. */
  onChange(cb: () => void): void;
  /** While recording, every key goes to `onKey` instead of the page or the menus. */
  recordShortcut(recording: boolean): Promise<void>;
  onKey(cb: (key: RecordedKey) => void): void;
  tabs(): Promise<TabsView>;
  editTabs(edit: TabsEdit): Promise<TabsEditResult>;
  /** The native menu for tabs (`tabIds`) or one folder: Move to…, Delete and, with `context`, Rename and Edit Address. */
  tabsMenu(request: { tabIds?: string[]; folderId?: string; context?: boolean }): Promise<TabsMenuAction | undefined>;
  /** The pane redraws whenever the sidebar changes something. */
  onTabs(cb: (view: TabsView) => void): void;
  /** Opens a tab in the browser window. */
  showTab(tabId: string): Promise<void>;
  /** The macOS emoji picker, for a Space's icon. */
  showEmojiPanel(): Promise<void>;
}

export interface AnusApi {
  onState(cb: (state: UiState) => void): void;
  onPalette(cb: (mode: PaletteMode) => void): void;
  /** Main asks the sidebar to open the Space editor (new Space, menu, shortcut). */
  onEditSpace(cb: (spaceId: string) => void): void;
  /** Main asks the sidebar to start renaming a tab in place. */
  onRenameTab(cb: (tabId: string) => void): void;
  onPeek(cb: (peek: PeekState | null) => void): void;
  /** `started` is set when this update is a new download beginning. */
  onDownloads(cb: (items: DownloadInfo[], started?: DownloadInfo) => void): void;
  ready(): void;
  searchHistory(query: string): Promise<HistoryEntry[]>;
  /** In a window whose tab another window took: the picture of that tab taken as it left. */
  parkedShot?(): Promise<string | undefined>;
  /** An installed app's icon as a data URL, by its name in /Applications. */
  appIcon(name: string): Promise<string | undefined>;
  /** During the welcome tour, shortcuts you press are reported here instead of acting. */
  onTourKey(cb: (command: string) => void): void;
  /** Other browsers with bookmarks or history to import. */
  detectBrowsers(): Promise<DetectedBrowser[]>;
  /** Imports one of the browsers `detectBrowsers` found, by id. */
  importBrowser(id: string, options?: BrowserImportOptions): Promise<ImportResult>;
  newTab(input: string): void;
  navigate(input: string): void;
  activate(tabId: string): void;
  close(tabId: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  switchSpace(spaceId: string): void;
  newSpace(): void;
  updateSpace(spaceId: string, patch: { name?: string; emoji?: string; color?: string }): void;
  setSpaceIsolated(spaceId: string, isolated: boolean): void;
  deleteSpace(spaceId: string): void;
  tabMenu(tabId: string): void;
  spaceMenu(spaceId: string): void;
  toggleFolder(folderId: string): void;
  togglePinnedCollapsed(spaceId: string): void;
  renameFolder(folderId: string, name: string): void;
  moveTab(tabId: string, target: DropTarget): void;
  /** Tabs picked together in the sidebar (⌘- or ⇧-click), moved, pinned or removed as one. */
  moveTabs(tabIds: string[], target: DropTarget): void;
  moveTabsToSpace(tabIds: string[], spaceId: string): void;
  pinInNewFolder(tabIds: string[]): void;
  /** Removes them; they can still be found in the archive (the command bar's Archive). */
  archiveTabs(tabIds: string[]): void;
  /** Asks first, then removes them without keeping them in the archive. */
  deleteTabs(tabIds: string[]): void;
  /** The menu for several picked tabs; `only: 'spaces'` shows just the Spaces to move them to. */
  tabsMenu(tabIds: string[], only?: 'spaces'): void;
  /** A short message at the bottom of the window, as onFlash shows them. */
  flash(message: string): void;
  clearToday(): void;
  /** Puts back the tabs the last close or delete took away, where they were (⌘Z in the sidebar). */
  undoClose(): void;
  /** Brings over the Spaces and tabs of Uranus Browser's Electron version. */
  importMenu(): void;
  openPalette(mode: PaletteMode): void;
  closePalette(): void;
  toggleSidebar(): void;
  /** Saves the sidebar's width (Chromium build: dragging its right edge). */
  setSidebarWidth?(width: number): void;
  setSidebarPeek(peek: boolean): void;
  /** Copies text and says so in the address field: "Link copied" unless `message` says otherwise. */
  copyText(text: string, message?: string): void;
  renameTab(tabId: string, title: string): void;
  toggleMute(tabId: string): void;
  /** Screenshot of the active page, to the clipboard. */
  capturePage(): void;
  clearSiteData(origin: string): void;
  setSitePermission(origin: string, permission: string, decision: 'allow' | 'block' | 'ask'): void;
  zoom(step: 1 | -1 | 0): void;
  openDevTools(): void;
  /** A short confirmation shown in the address bar ("Link copied"). */
  onFlash(cb: (message: string) => void): void;
  openSettings(pane?: string): void;
  /** Starts asking for a permission with a button (first-run tour): the microphone or camera page, or the App Management pane of System Settings. */
  openPermission(kind: 'microphone' | 'camera' | 'appManagement'): void;
  toggleResponsive(): void;
  showConsole(tabId: string): void;
  editBoost(kind: 'script' | 'styles'): void;
  openBoostsFolder(): void;
  splitWith(tabId: string): void;
  /** While a tab is dragged, the sidebar UI covers the page so it can be dropped there. */
  setTabDragging(dragging: boolean): void;
  dropToSplit(tabId: string, side: 'left' | 'right'): void;
  splitNew(input: string): void;
  closePeek(): void;
  openDownload(id: string): void;
  revealDownload(id: string): void;
  cancelDownload(id: string): void;
  clearDownloads(): void;
  promotePeek(): void;
  finishOnboarding(): void;
  setPreferences(prefs: { theme?: 'system' | 'light' | 'dark'; searchEngine?: SearchEngineId; adBlock?: boolean }): void;
  makeDefaultBrowser(): void;
  /** An empty AnusMini, for a quick lookup. */
  newAnusMini(): void;
}
