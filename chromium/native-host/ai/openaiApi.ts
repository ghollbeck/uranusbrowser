/**
 * The OpenAI API, with the user's API key from the macOS Keychain (secrets.ts). The only file in
 * UrAnus Browser that talks to api.openai.com: the agent chat, text answers (meeting notes) and audio
 * transcription all come through here.
 *
 * Chat uses the Responses API (POST /v1/responses) with function tools, and store: false, so
 * OpenAI keeps no copy of the conversation; reasoning comes back encrypted and goes out again
 * with the next turn. Every error is scrubbed of the key (and anything shaped like one).
 */
import type { ProviderInfo, ReasoningEffort } from '../../shared/browserAgent';
import type { AiFeature, AiModel, AiProviderView } from '../../shared/aiProtocol';
import { ProviderError, type ChatProvider, type Conversation, type RespondRequest, type Turn } from '../agentProvider';
import { scrub, type SecretStore } from '../secrets';
import type { AiProvider, CompleteRequest, TranscribeRequest } from './types';

const API = 'https://api.openai.com/v1';
export const RESPONSES_ENDPOINT = `${API}/responses`;
export const TRANSCRIBE_ENDPOINT = `${API}/audio/transcriptions`;
const MODELS_ENDPOINT = `${API}/models`;

export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const COMPLETE_TIMEOUT_MS = 90_000;
const TRANSCRIBE_TIMEOUT_MS = 40_000;
const MODELS_TTL_MS = 10 * 60_000;

/** Offered when the model list can't be read (no key yet, or no network). */
const CURATED_CHAT: AiModel[] = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];
const TRANSCRIBE_MODELS: AiModel[] = [
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
  { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { id: 'whisper-1', label: 'Whisper' },
];

const NO_KEY_DETAIL = 'No OpenAI API key yet. Add one in Settings › AI; it is kept in the macOS Keychain.';
const reasons = (model: string) => /^(gpt-[5-9]|o\d)/.test(model);
/** A model name is letters, digits, dots and dashes; anything else from the panel is ignored. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.\-]{1,63}$/i;

type Item = Record<string, unknown>;

// ---- chat ----------------------------------------------------------------------------------

class OpenAIConversation implements Conversation {
  items: Item[] = [];
  /** The model the last turn ran on: another model can't read its encrypted reasoning. */
  model?: string;
  addUser(text: string) {
    this.items.push({ role: 'user', content: [{ type: 'input_text', text }] });
  }
  addToolResult(callId: string, output: string) {
    this.items.push({ type: 'function_call_output', call_id: callId, output });
  }
}

/** The agent chat on the OpenAI API, with one model. */
export class OpenAIProvider implements ChatProvider {
  readonly id = 'openai';

  constructor(
    private secrets: SecretStore,
    readonly model = process.env.ANUS_AGENT_MODEL?.trim() || DEFAULT_MODEL,
    private fetcher: typeof fetch = fetch,
  ) {}

  async info(): Promise<ProviderInfo> {
    const found = await this.secrets.openaiKey();
    return found
      ? { id: this.id, label: 'OpenAI API key', ready: true, model: this.model, detail: found.source === 'keychain' ? 'Key in the macOS Keychain' : 'Key from the environment (development)' }
      : { id: this.id, label: 'OpenAI API key', ready: false, model: this.model, detail: NO_KEY_DETAIL };
  }

  newConversation(): Conversation {
    return new OpenAIConversation();
  }

  /**
   * The composer's mode can pick another model and how hard it thinks, for this message; not
   * every model thinks at every level, so Ultra steps down to High once if it's refused.
   */
  async respond(conversation: Conversation, request: RespondRequest): Promise<Turn> {
    const model = request.choice?.model && MODEL_NAME.test(request.choice.model) ? request.choice.model : this.model;
    const effort: ReasoningEffort = request.choice?.effort ?? 'low';
    try {
      return await this.respondWith(conversation, request, model, effort);
    } catch (err) {
      if (effort !== 'xhigh' || !(err instanceof ProviderError) || !/reasoning|effort/i.test(err.message)) throw err;
      return this.respondWith(conversation, request, model, 'high');
    }
  }

  private async respondWith(conversation: Conversation, { instructions, tools, signal }: RespondRequest, model: string, effort: ReasoningEffort): Promise<Turn> {
    const convo = conversation as OpenAIConversation;
    const found = await this.secrets.openaiKey();
    if (!found) throw new ProviderError('No OpenAI API key is set up.', 'auth');
    // Another model mid-conversation: the old one's encrypted reasoning stays behind.
    if (convo.model && convo.model !== model) convo.items = convo.items.filter((item) => item.type !== 'reasoning');
    convo.model = model;
    const body = {
      model,
      instructions,
      input: convo.items,
      tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true })),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      ...(reasons(model) ? { reasoning: { effort }, include: ['reasoning.encrypted_content'] } : {}),
      max_output_tokens: 4000,
    };
    let response: Response;
    try {
      response = await this.fetcher(RESPONSES_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${found.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProviderError(`Couldn’t reach OpenAI: ${scrub(err instanceof Error ? err.message : String(err), found.key)}`, 'network');
    }
    const json = (await response.json().catch(() => undefined)) as
      | { output?: Item[]; error?: { message?: string }; status?: string; incomplete_details?: { reason?: string } }
      | undefined;
    if (!response.ok || !json) {
      const why = json?.error?.message ?? `HTTP ${response.status}`;
      throw new ProviderError(`OpenAI said: ${scrub(why, found.key)}`, response.status === 401 || response.status === 403 ? 'auth' : 'http');
    }
    const output = json.output ?? [];
    const turn: Turn = { text: '', calls: [] };
    for (const item of output) {
      // With store: false the API does not persist Responses application state; send items without their IDs,
      // except reasoning, which needs its id with its encrypted content.
      if (item.type === 'reasoning') {
        convo.items.push(item);
      } else if (item.type === 'message') {
        const { id: _id, status: _status, ...rest } = item;
        convo.items.push(rest);
        for (const part of (item.content as Item[] | undefined) ?? []) if (part.type === 'output_text') turn.text += String(part.text ?? '');
      } else if (item.type === 'function_call') {
        const { id: _id, status: _status, ...rest } = item;
        convo.items.push(rest);
        turn.calls.push({ callId: String(item.call_id), name: String(item.name), arguments: String(item.arguments ?? '{}') });
      }
    }
    if (json.status === 'incomplete' && !turn.calls.length && !turn.text) {
      throw new ProviderError(`OpenAI stopped early (${json.incomplete_details?.reason ?? 'incomplete'})`, 'incomplete');
    }
    return turn;
  }
}

// ---- text answers ----------------------------------------------------------------------------

/** One Responses API request without tools; returns the text the model wrote (JSON when a schema is given). */
export async function openaiComplete(secrets: SecretStore, fetcher: typeof fetch, request: CompleteRequest): Promise<string> {
  const found = await secrets.openaiKey();
  if (!found) throw new ProviderError('No OpenAI API key is set up.', 'auth');
  const { signal } = request;
  const body = {
    model: request.model,
    instructions: request.instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: request.input }] }],
    ...(request.schema ? { text: { format: { type: 'json_schema', name: request.schema.name, strict: true, schema: request.schema.schema } } } : {}),
    store: false,
    ...(reasons(request.model) ? { reasoning: { effort: 'low' } } : {}),
    max_output_tokens: request.maxTokens,
  };
  let response: Response;
  try {
    response = await fetcher(RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${found.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(COMPLETE_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw new ProviderError('Cancelled.', 'aborted');
    if (err instanceof Error && err.name === 'TimeoutError') throw new ProviderError('OpenAI took too long. Try again.', 'timeout');
    throw new ProviderError('Couldn’t reach OpenAI. Check the connection and try again.', 'network');
  }
  const json = (await response.json().catch(() => undefined)) as
    | { output?: Item[]; error?: { message?: string; code?: string }; status?: string }
    | undefined;
  if (!response.ok || !json) {
    if (json?.error?.code === 'insufficient_quota' || response.status === 429) throw new ProviderError('OpenAI is limiting requests or the account is out of credit (HTTP 429).', 'quota');
    if (response.status === 401 || response.status === 403) throw new ProviderError('OpenAI didn’t accept the API key. Check it in Settings › AI.', 'auth');
    // Provider text can echo the request; only a short, scrubbed API message is passed on.
    throw new ProviderError(`The request failed (HTTP ${response.status}${json?.error?.message ? `: ${scrub(json.error.message, found.key).slice(0, 160)}` : ''}).`, 'http');
  }
  if (json.status === 'incomplete') throw new ProviderError('The answer was cut off. Try again.', 'incomplete');
  let text = '';
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of (item.content as Item[] | undefined) ?? []) {
      if (part.type === 'refusal') throw new ProviderError('OpenAI declined.', 'refusal');
      if (part.type === 'output_text') text += String(part.text ?? '');
    }
  }
  if (!text.trim()) throw new ProviderError('OpenAI returned nothing.', 'empty');
  return text.trim();
}

// ---- transcription ---------------------------------------------------------------------------

/** What to tell the user for an HTTP failure; never the response body unless it is a short API message. */
function transcribeMessage(status: number, apiMessage: string | undefined, key: string): string {
  if (status === 401 || status === 403) return 'OpenAI didn’t accept the API key for transcription. Check the key in Settings › AI.';
  if (status === 429) return 'OpenAI is limiting requests or the account is out of credit (HTTP 429).';
  if (status >= 500) return `OpenAI had a problem on its side (HTTP ${status}). The next chunks will be tried again.`;
  const said = apiMessage ? `: ${scrub(apiMessage, key).slice(0, 200)}` : '';
  return `OpenAI refused the audio (HTTP ${status})${said}`;
}

/** One chunk of 16 kHz mono WAV to text. An abort is passed through as is. */
export async function openaiTranscribe(secrets: SecretStore, fetcher: typeof fetch, wav: Uint8Array<ArrayBuffer>, { model, language, signal }: TranscribeRequest): Promise<string> {
  const found = await secrets.openaiKey();
  if (!found) throw new ProviderError('No OpenAI API key is set up, so this audio can’t be transcribed.', 'auth');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  let response: Response;
  try {
    response = await fetcher(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${found.key}` },
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ProviderError(`Couldn’t reach OpenAI: ${scrub(err instanceof Error ? err.message : String(err), found.key).slice(0, 200)}`, 'network');
  }
  const json = (await response.json().catch(() => undefined)) as { text?: unknown; error?: { message?: string } } | undefined;
  if (!response.ok || !json) throw new ProviderError(transcribeMessage(response.status, json?.error?.message, found.key), 'http');
  return typeof json.text === 'string' ? json.text.replace(/\s+/g, ' ').trim() : '';
}

// ---- models ----------------------------------------------------------------------------------

/** Chat models from GET /v1/models: GPT and o-series text models, not audio, image, search or embedding ones. */
export function chatModelsFrom(ids: string[]): AiModel[] {
  const skip = /(audio|realtime|transcribe|tts|whisper|image|embedding|search|moderation|instruct|codex|computer-use|dall-e|davinci|babbage|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/;
  return ids
    .filter((id) => /^(gpt-[4-9]|gpt-\d\d|o\d)/.test(id) && !skip.test(id))
    // GPT first, then the o-series; newest first within each.
    .sort((a, b) => Number(a.startsWith('o')) - Number(b.startsWith('o')) || b.localeCompare(a, 'en', { numeric: true }))
    .map((id) => ({ id, label: modelLabel(id) }));
}

/** gpt-5.4-mini → GPT-5.4 mini. */
export function modelLabel(id: string) {
  return id.replace(/^gpt-/, 'GPT-').replace(/-(mini|nano|pro|turbo|chat-latest)$/, ' $1');
}

/** The OpenAI API key as one of the registry's providers. */
export class OpenAIApiProvider implements AiProvider {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI API key';
  readonly capabilities = { chat: true, text: true, transcribe: true };
  private cached?: { at: number; models: AiModel[] };

  constructor(
    readonly secrets: SecretStore,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async status(): Promise<AiProviderView> {
    const found = await this.secrets.openaiKey();
    return {
      id: this.id,
      label: this.label,
      capabilities: this.capabilities,
      ready: !!found,
      keySource: found?.source,
      detail: !found ? NO_KEY_DETAIL : found.source === 'keychain' ? 'Key in the macOS Keychain. Billed to your OpenAI API account.' : 'Key from the environment (development).',
    };
  }

  defaultModel(feature: AiFeature) {
    return feature === 'transcribe' ? DEFAULT_TRANSCRIBE_MODEL : DEFAULT_MODEL;
  }

  async models(feature: AiFeature): Promise<AiModel[]> {
    if (feature === 'transcribe') return TRANSCRIBE_MODELS;
    if (this.cached && this.now() - this.cached.at < MODELS_TTL_MS) return this.cached.models;
    const found = await this.secrets.openaiKey();
    if (!found) return CURATED_CHAT;
    try {
      const response = await this.fetcher(MODELS_ENDPOINT, { headers: { authorization: `Bearer ${found.key}` }, signal: AbortSignal.timeout(10_000) });
      const json = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const models = chatModelsFrom((json.data ?? []).map((m) => String(m.id ?? '')));
      if (!response.ok || !models.length) return CURATED_CHAT;
      // The default stays first, so it is easy to find again.
      const sorted = [...models.filter((m) => m.id === DEFAULT_MODEL), ...models.filter((m) => m.id !== DEFAULT_MODEL)];
      this.cached = { at: this.now(), models: sorted };
      return sorted;
    } catch {
      return CURATED_CHAT;
    }
  }

  /** A saved or removed key changes what the account offers. */
  forget() {
    this.cached = undefined;
  }

  chat(model: string): ChatProvider {
    return new OpenAIProvider(this.secrets, model, this.fetcher);
  }

  complete(request: CompleteRequest) {
    return openaiComplete(this.secrets, this.fetcher, request);
  }

  transcribe(wav: Uint8Array<ArrayBuffer>, request: TranscribeRequest) {
    return openaiTranscribe(this.secrets, this.fetcher, wav, request);
  }
}
