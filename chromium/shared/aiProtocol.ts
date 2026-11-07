/**
 * The central AI provider, as the shell sees it: which providers exist (an OpenAI API key, a
 * ChatGPT account through the Codex app-server, the on-device Underdog model), whether each is
 * ready, and which provider and model every AI feature uses. Built by the native host
 * (native-host/ai/registry.ts); never carries a key, a token or anything a page wrote.
 */

/** The AI features that each have their own provider and model. Companions and artifacts run in the chat. */
export type AiFeature = 'chat' | 'routines' | 'meetingSummary' | 'transcribe';
export const AI_FEATURES: readonly AiFeature[] = ['chat', 'routines', 'meetingSummary', 'transcribe'];

export type AiProviderId = 'openai' | 'codex' | 'underdog';
export const AI_PROVIDERS: readonly AiProviderId[] = ['codex', 'openai', 'underdog'];

/** What a provider can do: drive the browser tools, write text (with a JSON schema), turn audio into text. */
export interface AiCapabilities {
  chat: boolean;
  text: boolean;
  transcribe: boolean;
}

export interface AiModel {
  id: string;
  label: string;
}

/** A rate-limit window of the ChatGPT plan, as Codex reports it. */
export interface AiLimitWindow {
  usedPercent: number;
  windowMins?: number;
  /** Unix seconds. */
  resetsAt?: number;
}

export interface AiProviderView {
  id: AiProviderId;
  label: string;
  ready: boolean;
  /** One line: why it is ready, or what is missing. */
  detail: string;
  capabilities: AiCapabilities;
  /** ChatGPT: who is signed in. No token, ever. */
  account?: { email?: string; plan?: string };
  /** ChatGPT: whether the Codex app is installed at all. */
  installed?: boolean;
  /** ChatGPT: a sign-in is waiting for the browser. */
  loginPending?: boolean;
  limits?: { primary?: AiLimitWindow; secondary?: AiLimitWindow };
  /** OpenAI API key: where the key is (never the key). */
  keySource?: 'keychain' | 'environment';
}

export interface AiFeatureOption {
  provider: AiProviderId;
  label: string;
  /** Whether this provider could do this feature right now. */
  available: boolean;
  /** Why not, when it can't. */
  reason?: string;
  models: AiModel[];
}

export interface AiFeatureView {
  provider: AiProviderId;
  model: string;
  /** Set when an environment variable (development) fixes the model. */
  lockedBy?: string;
  /** Routines: follows the chat until the user picks something else. */
  followsChat?: boolean;
  options: AiFeatureOption[];
}

export interface AiView {
  providers: AiProviderView[];
  features: Record<AiFeature, AiFeatureView>;
}

/** What the shell may ask the host to change. The key travels one way, shell to host. */
export type AiRequest =
  | { op: 'view' }
  | { op: 'setModel'; feature: AiFeature; provider: AiProviderId; model: string }
  | { op: 'followChat'; feature: 'routines' }
  | { op: 'login' }
  | { op: 'cancelLogin' }
  | { op: 'logout' }
  | { op: 'setKey'; key: string }
  | { op: 'removeKey' };

export const FEATURE_LABELS: Record<AiFeature, string> = {
  chat: 'Agent chat',
  routines: 'Routines',
  meetingSummary: 'Meeting notes',
  transcribe: 'Transcription',
};

export const PROVIDER_LABELS: Record<AiProviderId, string> = {
  codex: 'ChatGPT',
  openai: 'OpenAI API key',
  underdog: 'On this Mac (Underdog)',
};

/** An API key as OpenAI issues them: checked in the shell and again in the host. */
export const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,300}$/;
