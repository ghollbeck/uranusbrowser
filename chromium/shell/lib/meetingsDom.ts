/**
 * Reads WHO IS SPEAKING from a meeting page, for naming the "Others" lines. It is injected on
 * demand with chrome.scripting.executeScript (isolated world) once a second WHILE the user has
 * a recording running, and nowhere else: there is no content script, nothing is added to the
 * page, nothing is clicked, and only a name and a list of names leave it.
 *
 * The selectors are the ones joinly's platform controllers use (joinly/providers/browser/
 * platforms/{google_meet,zoom,teams}.py, MIT licensed), which watch the same highlighted tile.
 * Meeting UIs change often and their labels depend on the language, so this FAILS SOFT: if
 * nothing matches, the speaker is null and the lines stay "Others". joinly opens the people
 * panel by clicking; this reads the list only if the user already has it open.
 *
 * `readMeetingPage` is serialised and run in the page, so it must be self-contained: no
 * imports, no outer variables.
 */
export interface MeetingPageRead {
  /** The name on the highlighted speaker tile, or null. */
  speaker: string | null;
  /** Every name visible on tiles or in an open participant list. */
  names: string[];
}

export function readMeetingPage(provider: string): MeetingPageRead {
  const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const out: MeetingPageRead = { speaker: null, names: [] };
  const add = (name: string) => {
    if (name && name.length <= 80 && !out.names.includes(name) && out.names.length < 100) out.names.push(name);
  };
  try {
    if (provider === 'Google Meet') {
      for (const tile of Array.from(document.querySelectorAll('div[data-participant-id]'))) {
        const name = text(tile.querySelector('span.notranslate'));
        if (!name) continue;
        add(name);
        // A silent tile has a hidden leaf element with a thick border (the speaking ring); a speaking one doesn't.
        const silent = Array.from(tile.querySelectorAll('div')).some(
          (d) => !d.children.length && getComputedStyle(d).display === 'none' && parseFloat(getComputedStyle(d).borderTopWidth) > 3,
        );
        if (!silent && !out.speaker && name !== 'You') out.speaker = name;
      }
      for (const item of Array.from(document.querySelectorAll('div[aria-label="Participants"][role="list"] div[role="listitem"]'))) add((item.getAttribute('aria-label') ?? '').trim());
    } else if (provider === 'Zoom') {
      const selectors = ['div.speaker-active-container__video-frame span', 'div.speaker-bar-container__video-frame--active span', 'div.speaker-bar-container__video-frame span'];
      for (const selector of selectors) {
        const found = Array.from(document.querySelectorAll(selector)).map((el) => text(el)).find((t) => t.length > 0);
        if (found) {
          out.speaker = found;
          break;
        }
      }
      for (const item of Array.from(document.querySelectorAll('div[role="list"][aria-label^="participants" i] div.participants-li[aria-label]'))) {
        add((item.getAttribute('aria-label') ?? '').split(',')[0].trim());
      }
    } else if (provider === 'Microsoft Teams') {
      for (const tile of Array.from(document.querySelectorAll('div[data-tid="stage-layout"] div[role="menuitem"]'))) {
        const name = text(tile.querySelector('div[data-tid="participant-info-nametag"]') ?? tile.querySelector('div:not(:has(*)):not(:empty)'));
        if (name) add(name);
        if (name && !out.speaker && tile.querySelector('div[data-tid="voice-level-stream-outline"].vdi-frame-occlusion')) out.speaker = name;
      }
      for (const item of Array.from(document.querySelectorAll('div[aria-label="Attendees"][role="tree"] [data-cid="roster-participant"][aria-label]'))) {
        add((item.getAttribute('aria-label') ?? '').split(', ')[0].trim());
      }
    }
  } catch {
    // A page that doesn't look as expected is just a page with no names.
  }
  return out;
}
