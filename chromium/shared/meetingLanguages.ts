/**
 * The spoken languages a meeting can be pinned to. Transcription guesses the language of every
 * 10-second chunk on its own, and a short or noisy chunk can come back as a different script
 * (one Korean line inside English speech). Choosing the language removes the guess.
 *
 * Codes are ISO 639-1 (the form both OpenAI's transcription endpoint and whisper.cpp take).
 * `auto` is the default and means "send no language, let the engine detect it". Pure data.
 */

export type MeetingLanguage = string;

export const AUTO_LANGUAGE = 'auto';

/** Common languages, in the order the picker shows them (after Automatic). Names are in English. */
export const MEETING_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'sv', name: 'Swedish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
];

const CODES = new Set(MEETING_LANGUAGES.map((l) => l.code));

/** A stored or received value made safe: one of the listed codes, else `auto`. */
export function restoreLanguage(raw: unknown): string {
  return typeof raw === 'string' && CODES.has(raw) ? raw : AUTO_LANGUAGE;
}

/** The code to put on a transcription request, or undefined for Automatic (no `language` is sent at all). */
export function languageForRequest(setting: unknown): string | undefined {
  const code = restoreLanguage(setting);
  return code === AUTO_LANGUAGE ? undefined : code;
}
