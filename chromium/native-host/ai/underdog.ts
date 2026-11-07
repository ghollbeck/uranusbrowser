/**
 * The on-device Underdog model (underdogLlm.ts) as one of the registry's providers: text only.
 * A small model can pick numbered lines from a transcript but can't drive the browser tools or
 * hear audio, so it offers neither. Nothing it does leaves the Mac, and it is started only by
 * the first prompt.
 */
import type { AiFeature, AiModel, AiProviderView } from '../../shared/aiProtocol';
import { ProviderError } from '../agentProvider';
import { UnderdogError, type UnderdogLlm } from '../underdogLlm';
import type { AiProvider, CompleteRequest } from './types';

export class UnderdogProvider implements AiProvider {
  readonly id = 'underdog' as const;
  readonly label = 'On this Mac (Underdog)';
  readonly capabilities = { chat: false, text: true, transcribe: false };

  constructor(readonly llm: UnderdogLlm) {}

  async status(): Promise<AiProviderView> {
    const info = this.llm.info();
    const name = info.label.replace(/\s*\(on this Mac\)$/i, '');
    const detail = info.ready ? `${name} is set up for meeting notes. ${info.detail.replace(/^On this Mac\.\s*/, '')}` : info.detail;
    return { id: this.id, label: this.label, capabilities: this.capabilities, ready: info.ready, detail };
  }

  /** One model: the one OpenWhisper set up (ANUS_UNDERDOG_MODEL picks the other size). */
  async models(_feature: AiFeature): Promise<AiModel[]> {
    const info = this.llm.info();
    return [{ id: 'underdog', label: info.label }];
  }

  defaultModel() {
    return 'underdog';
  }

  async complete(request: CompleteRequest): Promise<string> {
    try {
      const reply = await this.llm.chat({
        messages: [
          { role: 'system', content: request.instructions },
          { role: 'user', content: request.input },
        ],
        maxTokens: Math.min(request.maxTokens, 2048),
        jsonSchema: request.schema?.schema ?? null,
        signal: request.signal,
      });
      if (!reply.text.trim()) throw new ProviderError('The on-device model returned nothing.', 'empty');
      return reply.text.trim();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(err instanceof UnderdogError ? err.message : 'The on-device model failed.', 'local');
    }
  }

  dispose() {
    return this.llm.dispose();
  }
}
