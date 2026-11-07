import type { UiState } from '../../shared/types';

/**
 * The state as one window's pages draw it. The background's state is the focused window's;
 * a window behind it shows its own Space and tab instead, and every window marks the tabs
 * another window has on screen.
 */
export function forWindow(state: UiState, windowId: number | undefined): UiState {
  const windows = state.windows;
  if (!windows || windowId === undefined) return state;
  const shownElsewhere = Object.entries(windows.showing)
    .filter(([w]) => Number(w) !== windowId)
    .map(([, tabId]) => tabId);
  const parkedTab = windows.parked[windowId];
  const view = windows.views[windowId];
  const space = view && state.spaces.find((s) => s.id === view.spaceId);
  if (!view || !space) return { ...state, shownElsewhere, parkedTab };
  return {
    ...state,
    activeSpaceId: space.id,
    spaces: state.spaces.map((s) => (s === space ? { ...s, activeTabId: view.tabId } : s)),
    tint: space.color,
    // The focused tab's; this window's tab may be on another.
    environment: undefined,
    shownElsewhere,
    parkedTab,
  };
}
