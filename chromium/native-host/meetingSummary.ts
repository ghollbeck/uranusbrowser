/**
 * Meeting notes, in the native host: the grounded summary and the title.
 *
 * The model is shown the numbered transcript (as JSON, fenced as untrusted data) and answers
 * with source ids only, under a strict JSON schema; shared/meetings.ts checks every id and the
 * notes are then built by quoting the original lines. Nothing the model writes reaches the
 * notes. Long meetings go in groups; a later group's retraction or answer is applied in code
 * (`reconcileSelections`), not by asking the model to summarise its own summaries.
 *
 * The model is the one Settings › AI picked for meeting notes (ai/registry.ts): the OpenAI API
 * key, a ChatGPT account or the on-device model. Without a registry (tests), the OpenAI API key
 * with ANUS_MEETING_SUMMARY_MODEL, else ANUS_AGENT_MODEL, else the chat's default. Errors
 * never contain transcript text or a key.
 */
import {
  deriveMeetingTitle,
  groupSummarySources,
  meetingSummaryPrompt,
  meetingSummarySources,
  parseMeetingTitle,
  parseSummarySelection,
  reconcileSelections,
  renderMeetingSummary,
  selectionSchemaFor,
  summaryItems,
  titlePrompt,
  titleSchema,
  type SummarySelection,
  type SummarySource,
} from '../shared/meetings';
import type { MeetingSummarizeReply, MeetingSummarizeRequest } from '../shared/meetingProtocol';
import { ProviderError } from './agentProvider';
import { DEFAULT_MODEL, OpenAIApiProvider } from './ai/openaiApi';
import type { AiRegistry } from './ai/registry';
import type { AiProvider } from './ai/types';
import { UnderdogProvider } from './ai/underdog';
import { MeetingError } from './meetingTranscribe';
import type { SecretStore } from './secrets';
import type { UnderdogLlm } from './underdogLlm';

/** A group is a few thousand words; the model's context is far larger, but accuracy is better in pieces. */
export const GROUP_CHARS = 24_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
/** The most transcript a summary will take: an enormous paste must not become an enormous bill. */
export const MAX_SUMMARY_CHARS = 600_000;

export function summaryModel(env: NodeJS.ProcessEnv = process.env) {
  return env.ANUS_MEETING_SUMMARY_MODEL?.trim() || env.ANUS_AGENT_MODEL?.trim() || DEFAULT_MODEL;
}

export interface SummaryDeps {
  /** The central provider: meeting notes use whatever Settings › AI picked. */
  registry?: AiRegistry;
  /** Without a registry: the OpenAI API key, this model, this fetcher. */
  secrets?: SecretStore;
  model?: string;
  fetcher?: typeof fetch;
  groupChars?: number;
  /** The on-device model, used only when the request asks for it (never by default). */
  underdog?: UnderdogLlm;
}

/** The provider and model this summary uses, and its name for messages. */
interface Backend {
  provider: AiProvider;
  model: string;
  /** For the notes' footer. */
  label: string;
  /** For messages: "OpenAI took too long…". */
  name: string;
}

const NAMES: Record<string, string> = { openai: 'OpenAI', codex: 'ChatGPT', underdog: 'The on-device model' };

/** One structured-output request; returns the JSON text the model produced. */
async function structured(
  backend: Backend,
  request: { instructions: string; input: string; name: string; schema: object; maxTokens: number },
  signal: AbortSignal,
): Promise<string> {
  try {
    return await backend.provider.complete!({
      model: backend.model,
      instructions: request.instructions,
      input: request.input,
      schema: { name: request.name, schema: request.schema },
      maxTokens: request.maxTokens,
      signal,
    });
  } catch (err) {
    throw summaryError(err, backend.name, signal);
  }
}

/** A provider's failure, said for meeting notes. */
function summaryError(err: unknown, name: string, signal: AbortSignal): MeetingError {
  if (err instanceof MeetingError) return err;
  if (signal.aborted) return new MeetingError('The summary was cancelled or took too long.');
  if (!(err instanceof ProviderError)) return new MeetingError(`${name} failed to summarise. Try again.`);
  switch (err.code) {
    case 'aborted':
      return new MeetingError('The summary was cancelled or took too long.');
    case 'timeout':
      return new MeetingError(`${name} took too long to summarise. Try again.`);
    case 'network':
      return new MeetingError(`Couldn’t reach ${name} to summarise. Check the connection and try again.`);
    case 'incomplete':
      return new MeetingError('The summary response was cut off. Try again.');
    case 'refusal':
      return new MeetingError(`${name} declined to summarise this meeting.`);
    case 'empty':
      return new MeetingError(`${name} returned an empty summary.`);
    case 'http':
      return new MeetingError(err.message.replace(/^The request/, 'The summary request'));
    default:
      // Already short, scrubbed and actionable (a key, a quota, a sign-in).
      return new MeetingError(err.message);
  }
}

/** Which provider writes these notes: the on-device model when asked for, else the registry's pick. */
async function backendFor(request: MeetingSummarizeRequest, deps: SummaryDeps): Promise<Backend> {
  if (request.provider === 'underdog') {
    const local = deps.registry?.provider<UnderdogProvider>('underdog') ?? (deps.underdog ? new UnderdogProvider(deps.underdog) : undefined);
    if (!local) throw new MeetingError('The on-device model isn’t available. Use OpenAI instead.');
    return { provider: local, model: local.defaultModel(), label: local.llm.info().label, name: NAMES.underdog };
  }
  const chosen = deps.registry
    ? deps.registry.choice('meetingSummary')
    : { provider: new OpenAIApiProvider(deps.secrets ?? { openaiKey: async () => undefined }, deps.fetcher ?? fetch), model: deps.model ?? summaryModel() };
  const { provider, model } = chosen;
  if (provider instanceof UnderdogProvider) return { provider, model, label: provider.llm.info().label, name: NAMES.underdog };
  const status = await provider.status();
  if (!status.ready) {
    throw new MeetingError(
      provider.id === 'openai'
        ? 'No OpenAI API key is set up, so the notes can’t be written. Use the quick digest instead, or add a key in Settings › AI.'
        : provider.id === 'codex'
          ? 'ChatGPT isn’t signed in, so the notes can’t be written. Use the quick digest instead, or sign in under Settings › AI.'
          : status.detail,
    );
  }
  return { provider, model, label: model, name: NAMES[provider.id] ?? provider.label };
}

async function requestSelection(backend: Backend, group: SummarySource[], signal: AbortSignal): Promise<SummarySelection> {
  const content = await structured(
    backend,
    {
      instructions: meetingSummaryPrompt,
      input: `Numbered transcript (JSON data):\n${JSON.stringify(group)}`,
      name: 'meeting_evidence',
      schema: selectionSchemaFor(group),
      maxTokens: 4000,
    },
    signal,
  );
  return parseSummarySelection(content, group);
}

/** A model-made title, accepted only if its words come from the notes; null otherwise. */
async function requestTitle(backend: Backend, notes: string, signal: AbortSignal): Promise<string | null> {
  const source = notes.slice(0, 6000);
  try {
    const content = await structured(
      backend,
      { instructions: titlePrompt, input: `Recording evidence (JSON string):\n${JSON.stringify(source)}`, name: 'meeting_title', schema: titleSchema, maxTokens: 1000 },
      signal,
    );
    return parseMeetingTitle(content, notes);
  } catch {
    return null;
  }
}

/**
 * The grounded notes for a transcript. With no key or no network this throws a MeetingError;
 * the shell can then offer the no-model digest (shared/meetings.ts `meetingDigest`).
 */
export async function summarizeMeeting(request: MeetingSummarizeRequest, deps: SummaryDeps, outer?: AbortSignal): Promise<MeetingSummarizeReply> {
  if (!request || !Array.isArray(request.segments)) throw new MeetingError('Bad summary request.');
  const sources = meetingSummarySources(
    request.segments.map((s) => ({ speaker: String(s?.speaker ?? '').slice(0, 80), start_ms: Number(s?.start_ms), text: String(s?.text ?? '') })),
  );
  if (!sources.length) throw new MeetingError('There is no transcript to summarise.');
  if (sources.reduce((n, s) => n + s.text.length, 0) > MAX_SUMMARY_CHARS) throw new MeetingError('This meeting is too long to summarise in one go.');
  if (outer?.aborted) throw new MeetingError('The summary was cancelled.');
  const backend = await backendFor(request, deps);
  const groups = groupSummarySources(sources, deps.groupChars ?? GROUP_CHARS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
  try {
    const picks: SummarySelection[] = [];
    for (const group of groups) {
      if (signal.aborted) throw new MeetingError('The summary was cancelled or took too long.');
      picks.push(await requestSelection(backend, group, signal));
    }
    const selections = reconcileSelections(sources, groups, picks);
    const notes = renderMeetingSummary(sources, selections);
    const title = (await requestTitle(backend, notes, signal)) ?? deriveMeetingTitle(notes);
    return { items: summaryItems(sources, selections), model: backend.label, method: 'model', warning: null, title };
  } finally {
    clearTimeout(timer);
  }
}
