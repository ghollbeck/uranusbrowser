/**
 * What the shell and the native host say to each other about meeting notes (the `meeting*`
 * methods in native-host/protocol.ts). Types only. Audio goes shell to host as base64 WAV
 * (shared/wav.ts); the host answers with text and keeps no audio.
 */
import type { SummaryItems, SummarySegment } from './meetings';

/** Where a transcription engine runs: `cloud` sends the audio to OpenAI, `local` keeps it on this Mac. */
export type EngineId = 'openai' | 'local';

export interface EngineInfo {
  id: EngineId;
  label: string;
  model: string;
  where: 'cloud' | 'local';
  ready: boolean;
  /** One line for the panel: why it is ready, or what is missing. */
  detail: string;
}

export interface MeetingTranscribeRequest {
  engine: EngineId;
  /** A 16 kHz mono 16-bit PCM WAV, base64. */
  wav: string;
  /** RMS level of the chunk, 0 to 1 (for dropping recogniser stock phrases on near-silence). */
  level?: number;
  /** ISO 639-1 code, or omitted to detect it. */
  language?: string;
}

export interface MeetingTranscribeReply {
  text: string;
}

/** Whether the on-device Underdog model could run, looked up from files alone (nothing is loaded to find out). */
export interface UnderdogInfo {
  ready: boolean;
  /** One line for the panel: what it is, or what is missing. */
  detail: string;
  /** Its name, for the notes' footer. */
  label: string;
  /** Whether the weights are in memory right now. */
  loaded: boolean;
}

export interface MeetingSummarizeRequest {
  /** The cleaned transcript lines (shared/meetings.ts `shownTranscript`). */
  segments: SummarySegment[];
  /** Which model writes the notes. OpenAI unless the user picks the on-device one for this meeting. */
  provider?: 'openai' | 'underdog';
}

export interface MeetingSummarizeReply {
  items: SummaryItems;
  model: string;
  method: 'model' | 'extractive';
  warning: string | null;
  /** A short title taken from, and checked against, the meeting's own words; null if there's none. */
  title: string | null;
}

// ---- the capture page (an offscreen document) and the shell's background -------------------------

/** From the background to the capture page. */
export type CaptureCommand =
  | {
      type: 'meeting:capture-start';
      /** Hard stop for this recording, from the moment it starts. */
      maxMs: number;
      /** Which microphone to open: this Mac's built-in one when there is one, or the system default. */
      mic: 'builtin' | 'default' | 'device';
      /** For `device`: the microphone to open (by id, then by name). */
      micDevice?: { id: string; label: string };
      /** Test mode only: recorded speech to play in place of the microphone and the tab (base64 16 kHz mono WAV). */
      fixture?: { me?: string; others?: string };
    }
  /**
   * Adds (or replaces) the meeting tab's sound mid-recording. `tabStreamId` comes from
   * chrome.tabCapture.getMediaStreamId, called on the user's menu click or keyboard command.
   * `fixture` (test mode only) plays recorded speech instead.
   */
  | { type: 'meeting:capture-attach-tab'; tabStreamId?: string; fixture?: string }
  /** Asks the capture page for the microphones it can see, by name (the panel page can't read names). Answered with the response. */
  | { type: 'meeting:capture-list-mics' }
  | { type: 'meeting:capture-stop' };

/** From the capture page to the background. */
export type CaptureEvent =
  | { type: 'meeting:capture-started'; /** The microphone in use (its name), when the browser says. */ micLabel?: string; /** Whether the tab's own sound is being recorded (it is added later, on the user's gesture). */ others: boolean }
  /** The tab's sound is now recorded ("Others" chunks begin), or went away (the tab closed, the stream ended). */
  | { type: 'meeting:capture-tab'; attached: boolean; message?: string }
  /** The microphone went away (unplugged, Bluetooth or iPhone mic dropped) and the recorder opened the input that is the default now. */
  | { type: 'meeting:capture-mic'; label: string }
  | { type: 'meeting:capture-chunk'; channel: 'Me' | 'Others'; startMs: number; endMs: number; level: number; wav: string }
  | { type: 'meeting:capture-level'; me: number; others: number; elapsedMs: number }
  | { type: 'meeting:capture-error'; code: 'mic-permission' | 'mic-unavailable' | 'failed'; message: string }
  | { type: 'meeting:capture-ended'; reason: 'stopped' | 'limit' | 'tab-ended' | 'failed' | 'mic-lost' };
