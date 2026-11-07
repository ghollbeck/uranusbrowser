/**
 * The central AI provider's pieces, in the native host. Every AI feature (the agent chat,
 * routines, meeting notes, transcription) asks the registry (registry.ts) for a provider and
 * a model instead of talking to a service itself:
 *
 *  - openaiApi.ts: the OpenAI API with the Keychain key (the only file that calls api.openai.com)
 *  - codex.ts:     a ChatGPT account, through the official Codex app-server (Codex owns the tokens)
 *  - underdog.ts:  the on-device Underdog model, text only
 */
import type { AiCapabilities, AiFeature, AiModel, AiProviderId, AiProviderView } from '../../shared/aiProtocol';
import type { ChatProvider } from '../agentProvider';

export type { AiCapabilities, AiFeature, AiModel, AiProviderId, AiProviderView };

/** One text request: instructions, the input, and optionally a strict JSON schema for the answer. */
export interface CompleteRequest {
  model: string;
  instructions: string;
  input: string;
  schema?: { name: string; schema: object };
  maxTokens: number;
  signal: AbortSignal;
}

export interface TranscribeRequest {
  model: string;
  language?: string;
  signal: AbortSignal;
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly label: string;
  readonly capabilities: AiCapabilities;
  /** Whether it is ready, for Settings and the panel. Cheap: never starts a model. */
  status(): Promise<AiProviderView>;
  /** The models this provider offers for a feature; a curated list when it can't ask. */
  models(feature: AiFeature): Promise<AiModel[]>;
  defaultModel(feature: AiFeature): string;
  /** A chat provider bound to one model (capabilities.chat). */
  chat?(model: string): ChatProvider;
  /** One text answer (capabilities.text). Throws a ProviderError with a `code`. */
  complete?(request: CompleteRequest): Promise<string>;
  /** Audio to text (capabilities.transcribe). */
  transcribe?(wav: Uint8Array<ArrayBuffer>, request: TranscribeRequest): Promise<string>;
  dispose?(): Promise<void>;
}
