/**
 * The meeting platforms' marks, drawn small for the meeting reminder (the windows' card and the
 * native host's floating panel): simplified Google Meet, Zoom and Microsoft Teams logos, to say
 * which app the meeting is in. Constant SVG on a 24 grid, never built from event text.
 */
import type { MeetingPlatform } from './joinly';

export const MEETING_LOGOS: Record<MeetingPlatform, string> = {
  'Google Meet':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path fill="#00832d" d="M13.6 12l1.9 2.2 2.6 1.6.4-3.8-.4-3.7-2.6 1.4z"/>' +
    '<path fill="#0066da" d="M2.5 15.4v3.2c0 .7.6 1.4 1.4 1.4h3.3l.7-2.4-.7-2.2-2.2-.7z"/>' +
    '<path fill="#e94235" d="M7.2 4L2.5 8.7l2.4.7 2.3-.7.7-2.2z"/>' +
    '<path fill="#2684fc" d="M7.2 8.7H2.5v6.7h4.7z"/>' +
    '<path fill="#00ac47" d="M21.4 5.9l-3 2.5v7.4l3 2.5c.4.4 1.1 0 1.1-.6V6.5c0-.6-.7-.9-1.1-.6zM13.6 12v3.4H7.2V20h9.5c.8 0 1.4-.6 1.4-1.4v-3l-4.5-3.6z"/>' +
    '<path fill="#ffba00" d="M16.7 4H7.2v4.7h6.4V12l4.5-3.7V5.4c0-.8-.6-1.4-1.4-1.4z"/>' +
    '</svg>',
  Zoom:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<rect width="24" height="24" rx="6" fill="#0b5cff"/>' +
    '<path fill="#fff" d="M4.5 9.2c0-.9.7-1.7 1.7-1.7h6.6c.9 0 1.7.8 1.7 1.7v5.6c0 .9-.8 1.7-1.7 1.7H6.2c-1 0-1.7-.8-1.7-1.7zM15.5 10.6l3-2.1c.4-.3 1 0 1 .5v6c0 .5-.6.8-1 .5l-3-2.1z"/>' +
    '</svg>',
  'Microsoft Teams':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<circle cx="18.5" cy="6.5" r="2.5" fill="#7b83eb"/>' +
    '<path fill="#5059c9" d="M15 10h7v6a3.5 3.5 0 0 1-7 0z"/>' +
    '<circle cx="12.5" cy="5" r="3" fill="#7b83eb"/>' +
    '<path fill="#7b83eb" d="M8 9.5h9.5V16a5 5 0 0 1-10 0V9.5z"/>' +
    '<rect x="2" y="6.5" width="12" height="12" rx="2" fill="#4b53bc"/>' +
    '<path fill="#fff" d="M5 9.4h6v1.4H8.8v5.4H7.2v-5.4H5z"/>' +
    '</svg>',
};
