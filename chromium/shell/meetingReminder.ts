/**
 * The meeting reminder in the window: a card that slides in at the bottom of the sidebar from a
 * couple of minutes before a meeting until it ends (calendar.ts sends `calendar:reminder`): its
 * title, a live line ("Live · 17 min in · until 22:45") with a thin progress bar, Join, Record
 * (Join & record), AI (record with the AI assistant, when joinly is on) and ✕ to dismiss. The same meeting is
 * also on a floating panel on the pointer's display (the native host's reminderPopup.ts); an
 * answer on either closes both.
 *
 * With the sidebar hidden, the sidebar peeks out once when a meeting's card first appears, so the
 * card is seen; it hides again as a peek does. The title is someone else's text: DOM text only.
 */
import { cmd, invoke, on } from './client';
import { incognito } from './incognito';
import { ICONS } from './ui/icons';
import { reminderStatus, type CalendarMeeting } from '../shared/calendar';
import { MEETING_LOGOS } from '../shared/meetingLogos';

interface ReminderView {
  meeting?: CalendarMeeting;
  assistant: boolean;
}

const sidebar = document.getElementById('sidebar');
const footer = sidebar?.querySelector(':scope > footer');
const surface = document.documentElement.dataset.surface;

if (sidebar && footer && surface === 'window' && !incognito) {
  const card = document.createElement('section');
  card.id = 'meeting-reminder';
  card.className = 'meeting-reminder';
  card.setAttribute('role', 'alert');
  card.setAttribute('aria-label', 'Meeting reminder');
  card.hidden = true;
  sidebar.insertBefore(card, footer);

  let view: ReminderView = { assistant: false };
  let peeked = '';
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const svg = (name: keyof typeof ICONS) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 16 16');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<path d="${ICONS[name]}"/>`;
    return el;
  };
  /** A button with its full label, and a short one for a narrow sidebar (shell.css container query). */
  const button = (label: string, action: string, className = '', short?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mr-button ${className}`.trim();
    b.dataset.action = action;
    if (!short) b.textContent = label;
    else {
      const long = Object.assign(document.createElement('span'), { className: 'long', textContent: label });
      const brief = Object.assign(document.createElement('span'), { className: 'short', textContent: short });
      b.append(long, brief);
      b.setAttribute('aria-label', label);
    }
    return b;
  };

  /** Fills the live parts: the status line and the progress bar (every 30 s too). */
  function tick() {
    const m = view.meeting;
    if (!m) return;
    const status = reminderStatus(m, Date.now(), time);
    card.classList.toggle('live', status.live);
    const line = card.querySelector('.mr-status-text');
    if (line) line.textContent = status.lead;
    const until = card.querySelector('.mr-until');
    if (until) until.textContent = status.tail;
    card.querySelector<HTMLElement>('.mr-progress i')?.style.setProperty('width', `${(status.progress * 100).toFixed(1)}%`);
  }

  function render() {
    const m = view.meeting;
    if (!m) {
      card.classList.remove('shown');
      card.hidden = true;
      return;
    }
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: Array<Node | string>) => {
      const node = document.createElement(tag);
      node.className = className;
      node.append(...children);
      return node;
    };
    // The app the meeting is in, by its own mark (a constant SVG, never event text).
    const platform = el('span', 'mr-platform');
    const logo = MEETING_LOGOS[m.platform];
    if (logo) platform.innerHTML = logo;
    else platform.append(svg('video'));
    platform.dataset.tip = m.platform;
    platform.setAttribute('aria-label', m.platform);
    const close = el('button', 'mr-close', svg('close'));
    close.type = 'button';
    close.dataset.action = 'dismiss';
    close.dataset.tip = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    const head = el(
      'div',
      'mr-head',
      platform,
      el('div', 'mr-text', el('strong', 'mr-title', m.title), el('span', 'mr-status', el('i', 'mr-dot'), el('span', 'mr-status-text'))),
      close,
    );

    const join = button('Join', 'join', 'primary');
    join.dataset.tip = `Open in ${m.platform}`;
    const record = button('Join & record', 'record', '', view.assistant ? 'Record' : undefined);
    record.dataset.tip = 'Join and record meeting notes';
    const actions = el('div', 'mr-actions', join, record);
    if (view.assistant) {
      const assistant = button('Record + AI assistant', 'assistant', '', 'Record + AI');
      assistant.dataset.tip = 'Join, record and bring the AI assistant';
      actions.append(assistant);
    }

    card.replaceChildren(head, el('div', 'mr-timeline', el('div', 'mr-progress', el('i', '')), el('span', 'mr-until')), actions, el('div', 'mr-hint', 'If you record, tell the others.'));
    card.dataset.meeting = m.id;
    tick();
    if (card.hidden) {
      card.hidden = false;
      // Next frame, so the slide-in transition runs from the hidden position.
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('shown')));
    }
    // The sidebar is hidden: let it peek out once for this meeting.
    if (document.body.dataset.sidebar === 'hidden' && peeked !== m.id) {
      peeked = m.id;
      cmd('setSidebarPeek')(true);
    }
  }

  card.addEventListener('click', (e) => {
    const target = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
    const id = view.meeting?.id;
    if (!target || !id) return;
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    void invoke('calendar:reminderAction', id, target.dataset.action).finally(() => {
      for (const b of card.querySelectorAll('button')) b.disabled = false;
    });
  });

  on('calendar:reminder', (next: ReminderView) => {
    view = next ?? { assistant: false };
    render();
  });
  void invoke<ReminderView>('calendar:reminder')
    .then((next) => {
      view = next ?? { assistant: false };
      render();
    })
    .catch(() => undefined);
  // "In 2 min" → "Live · 4 min in", and the bar moves on.
  setInterval(tick, 30_000);
}
