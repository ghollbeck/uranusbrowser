/**
 * The central AI provider: which provider and model each AI feature uses, saved as a small JSON
 * file in UrAnus Browser's app data (no keys, no tokens). Every feature asks here; none picks a service
 * or reads a key on its own.
 *
 * - `chat` is the Agent panel (companions and artifacts run in it); `routines` follow the chat
 *   until the user picks something else for them; `meetingSummary` writes meeting notes;
 *   `transcribe` turns meeting audio into text.
 * - Nothing saved yet: the OpenAI API key, as before this registry existed.
 * - Development overrides (ANUS_AGENT_MODEL, ANUS_MEETING_SUMMARY_MODEL,
 *   ANUS_MEETING_TRANSCRIBE_MODEL) fix the OpenAI model above anything saved.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_FEATURES,
  AI_PROVIDERS,
  type AiFeature,
  type AiFeatureOption,
  type AiFeatureView,
  type AiProviderId,
  type AiProviderView,
  type AiView,
} from '../../shared/aiProtocol';
import { ProviderError, type ChatProvider } from '../agentProvider';
import type { AiProvider, CompleteRequest, TranscribeRequest } from './types';

interface Choice {
  provider: AiProviderId;
  model: string;
}

interface Prefs {
  version: 1;
  features: Partial<Record<AiFeature, Choice>>;
}

export interface Resolved {
  provider: AiProvider;
  model: string;
  lockedBy?: string;
  followsChat?: boolean;
}

/** What a feature needs from a provider. */
const NEEDS: Record<AiFeature, 'chat' | 'text' | 'transcribe'> = { chat: 'chat', routines: 'chat', meetingSummary: 'text', transcribe: 'transcribe' };

/** Why a provider can't do a feature at all, in the user's words. */
function cannot(provider: AiProviderId, feature: AiFeature): string {
  const need = NEEDS[feature];
  if (provider === 'codex' && need === 'transcribe') return 'A ChatGPT plan can’t transcribe audio. Use an OpenAI API key, or on-device Whisper in Meeting notes.';
  if (provider === 'underdog' && need === 'chat') return 'The on-device model can’t use the browser tools.';
  if (provider === 'underdog' && need === 'transcribe') return 'The on-device model reads text only.';
  return 'This provider can’t do that.';
}

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,100}$/;

export interface RegistryOptions {
  providers: AiProvider[];
  /** Where the choices are saved; nothing is saved without it (tests). */
  file?: string;
  env?: NodeJS.ProcessEnv;
  log?: (...args: unknown[]) => void;
}

export class AiRegistry {
  private providers = new Map<AiProviderId, AiProvider>();
  private prefs: Prefs = { version: 1, features: {} };
  private listeners: Array<() => void> = [];

  constructor(private options: RegistryOptions) {
    for (const p of options.providers) this.providers.set(p.id, p);
    this.prefs = this.load();
  }

  provider<T extends AiProvider = AiProvider>(id: AiProviderId): T | undefined {
    return this.providers.get(id) as T | undefined;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  /** Tells every listener (the chat, the shell) that a choice or a provider's state changed. */
  changed() {
    for (const fn of this.listeners) fn();
  }

  private get env() {
    return this.options.env ?? process.env;
  }

  /** The development override for a feature's OpenAI model, if one is set. */
  private override(feature: AiFeature): { name: string; model: string } | undefined {
    const env = this.env;
    const pick = (...names: string[]) => {
      for (const name of names) {
        const value = env[name]?.trim();
        if (value) return { name, model: value };
      }
      return undefined;
    };
    if (feature === 'transcribe') return pick('ANUS_MEETING_TRANSCRIBE_MODEL');
    if (feature === 'meetingSummary') return pick('ANUS_MEETING_SUMMARY_MODEL', 'ANUS_AGENT_MODEL');
    return pick('ANUS_AGENT_MODEL');
  }

  /** The provider and model a feature uses now. */
  choice(feature: AiFeature): Resolved {
    const saved = this.prefs.features[feature];
    if (feature === 'routines' && !saved) return { ...this.choice('chat'), followsChat: true };
    let provider = saved ? this.providers.get(saved.provider) : undefined;
    // A saved provider that can't do this feature (or went away) falls back to the API key.
    if (!provider || !provider.capabilities[NEEDS[feature]]) provider = this.providers.get('openai')!;
    let model = saved && saved.provider === provider.id ? saved.model : provider.defaultModel(feature);
    const forced = provider.id === 'openai' ? this.override(feature) : undefined;
    if (forced) model = forced.model;
    return { provider, model, lockedBy: forced?.name };
  }

  /** Picks a provider and model for a feature, and saves it. Throws a ProviderError the UI can show. */
  set(feature: AiFeature, providerId: AiProviderId, model: string) {
    if (!AI_FEATURES.includes(feature)) throw new ProviderError('Unknown feature.');
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderError('Unknown provider.');
    if (!provider.capabilities[NEEDS[feature]]) throw new ProviderError(cannot(providerId, feature));
    const id = String(model ?? '').trim() || provider.defaultModel(feature);
    if (!MODEL_ID.test(id)) throw new ProviderError('That isn’t a model name.');
    this.prefs.features[feature] = { provider: providerId, model: id };
    this.save();
    this.changed();
  }

  /** Routines go back to whatever the chat uses. */
  followChat(feature: 'routines') {
    delete this.prefs.features[feature];
    this.save();
    this.changed();
  }

  /**
   * A provider just became ready (a sign-in, a saved key): every feature it can do whose
   * current provider isn't ready moves to it, so "sign in, then chat" works without a trip to
   * Settings. A feature that works stays as it is.
   */
  async adopt(providerId: AiProviderId) {
    const provider = this.providers.get(providerId);
    if (!provider || !(await provider.status()).ready) return;
    let moved = false;
    for (const feature of AI_FEATURES) {
      if (feature === 'routines' && !this.prefs.features.routines) continue;
      const current = this.choice(feature);
      if (current.provider.id === providerId || !provider.capabilities[NEEDS[feature]]) continue;
      if ((await current.provider.status()).ready) continue;
      this.prefs.features[feature] = { provider: providerId, model: provider.defaultModel(feature) };
      moved = true;
    }
    if (moved) {
      this.save();
      this.options.log?.(`ai: features moved to ${providerId}`);
    }
    this.changed();
  }

  /** A chat provider for the panel (`chat`) or a scheduled routine (`routines`). */
  chat(feature: 'chat' | 'routines' = 'chat'): ChatProvider {
    const { provider, model } = this.choice(feature);
    if (!provider.chat) throw new ProviderError(cannot(provider.id, feature));
    return provider.chat(model);
  }

  /** One text answer from the feature's provider. */
  complete(feature: AiFeature, request: Omit<CompleteRequest, 'model'>): Promise<string> {
    const { provider, model } = this.choice(feature);
    if (!provider.complete) throw new ProviderError(cannot(provider.id, feature));
    return provider.complete({ ...request, model });
  }

  transcribe(wav: Uint8Array<ArrayBuffer>, request: Omit<TranscribeRequest, 'model'>): Promise<string> {
    const { provider, model } = this.choice('transcribe');
    if (!provider.transcribe) throw new ProviderError(cannot(provider.id, 'transcribe'));
    return provider.transcribe(wav, { ...request, model });
  }

  /** Everything Settings › AI and the panel's model menu show. Never a key or a token. */
  async view(): Promise<AiView> {
    const ids = AI_PROVIDERS.filter((id) => this.providers.has(id));
    const statuses = new Map<AiProviderId, AiProviderView>();
    await Promise.all(
      ids.map(async (id) => {
        const p = this.providers.get(id)!;
        try {
          statuses.set(id, await p.status());
        } catch {
          statuses.set(id, { id, label: p.label, ready: false, detail: 'Couldn’t check this provider.', capabilities: p.capabilities });
        }
      }),
    );
    const features = {} as Record<AiFeature, AiFeatureView>;
    for (const feature of AI_FEATURES) {
      const current = this.choice(feature);
      const options: AiFeatureOption[] = [];
      for (const id of ids) {
        const p = this.providers.get(id)!;
        const status = statuses.get(id)!;
        if (!p.capabilities[NEEDS[feature]]) {
          options.push({ provider: id, label: p.label, available: false, reason: cannot(id, feature), models: [] });
          continue;
        }
        const models = status.ready ? await p.models(feature).catch(() => []) : [];
        options.push({ provider: id, label: p.label, available: status.ready, reason: status.ready ? undefined : status.detail, models });
      }
      features[feature] = { provider: current.provider.id, model: current.model, lockedBy: current.lockedBy, followsChat: current.followsChat, options };
    }
    return { providers: ids.map((id) => statuses.get(id)!), features };
  }

  async dispose() {
    await Promise.allSettled([...this.providers.values()].map((p) => p.dispose?.()));
  }

  // ---- saved choices --------------------------------------------------------------------------

  private load(): Prefs {
    const file = this.options.file;
    if (!file) return { version: 1, features: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Prefs>;
      const features: Prefs['features'] = {};
      for (const feature of AI_FEATURES) {
        const c = raw.features?.[feature];
        if (c && AI_PROVIDERS.includes(c.provider) && typeof c.model === 'string' && MODEL_ID.test(c.model)) features[feature] = { provider: c.provider, model: c.model };
      }
      return { version: 1, features };
    } catch {
      return { version: 1, features: {} };
    }
  }

  private save() {
    const file = this.options.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (err) {
      this.options.log?.('ai: could not save the model choices', err instanceof Error ? err.name : typeof err);
    }
  }
}
