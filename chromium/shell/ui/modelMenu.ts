/**
 * The Agent panel's models: which model the chat uses, and the list to pick another one from
 * (ChatGPT's models, the API key's models), or Settings › AI to sign in or add a key. It has no
 * button of its own: the composer's selector (chooser.ts) shows the model on its pill and this
 * list in its Model flyout. The choice lives in the host (native-host/ai/registry.ts); a new
 * model starts a fresh conversation, and can't be picked while the agent is working.
 */
import type { AiFeatureOption, AiProviderId, AiView } from '../../shared/aiProtocol';
import type { ProviderInfo } from '../../shared/browserAgent';
import { invoke, on } from '../client';
import { ICONS } from './icons';

const BADGES: Record<string, string> = { codex: 'ChatGPT', openai: 'API key', underdog: 'On this Mac' };

export interface ModelMenu {
  /** The chat's provider as the last snapshot said. */
  setProvider(info: ProviderInfo | undefined, busy: boolean): void;
  /** The model's name for the pill, or "Set up a model". */
  label(): string;
  ready(): boolean;
  /** The list: a group per provider, then AI settings. `picked` runs after a pick. */
  render(picked: () => void): HTMLElement[];
  /** Fresh models from the account (the flyout calls it when it opens). */
  refresh(): Promise<void>;
  /** Called whenever the model, the provider or the list changes. */
  onChange(fn: () => void): void;
}

function glyph(name: keyof typeof ICONS) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  el.append(path);
  return el;
}

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, '');

export function setupModelMenu(): ModelMenu {
  const badge = document.getElementById('provider-badge')!;
  let view: AiView | undefined;
  let info: ProviderInfo | undefined;
  let busy = false;
  let note = '';
  let picked: () => void = () => {};
  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((fn) => fn());

  const labelFor = (provider: string | undefined, model: string | undefined) => {
    if (!model) return '';
    const option = view?.features.chat.options.find((o) => o.provider === provider);
    return option?.models.find((m) => m.id === model)?.label ?? model;
  };

  const label = () => (info?.ready ? labelFor(info?.id, info?.model) || 'Model' : 'Set up a model');

  function paintButton() {
    const ready = !!info?.ready;
    badge.hidden = !ready || !info?.id;
    badge.textContent = BADGES[info?.id ?? ''] ?? '';
    badge.dataset.provider = info?.id ?? '';
    changed();
  }

  function item(text: string, detail: string | undefined, onPick: (() => void) | undefined, opts: { checked?: boolean; disabled?: boolean } = {}) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'mm-item';
    el.setAttribute('role', opts.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (opts.checked !== undefined) el.setAttribute('aria-checked', String(opts.checked));
    if (opts.disabled) el.setAttribute('aria-disabled', 'true');
    const label = document.createElement('span');
    label.className = 'mm-label';
    label.textContent = text;
    el.append(label);
    if (detail) {
      const small = document.createElement('span');
      small.className = 'mm-detail';
      small.textContent = detail;
      el.append(small);
    }
    if (opts.checked) el.append(glyph('check'));
    if (onPick && !opts.disabled) el.addEventListener('click', onPick);
    return el;
  }

  function group(option: AiFeatureOption) {
    const box = document.createElement('div');
    box.className = 'mm-group';
    box.setAttribute('role', 'group');
    const provider = view?.providers.find((p) => p.id === option.provider);
    const head = document.createElement('div');
    head.className = 'mm-head';
    head.textContent = provider?.account?.email ? `${option.label} · ${provider.account.email}` : option.label;
    box.setAttribute('aria-label', head.textContent);
    box.append(head);
    if (!option.available) {
      const action = option.provider === 'codex' ? 'Sign in with ChatGPT…' : option.provider === 'openai' ? 'Add an API key…' : 'Set up…';
      box.append(item(action, option.reason, () => openSettings()));
      return box;
    }
    const current = view!.features.chat;
    for (const model of option.models) {
      const checked = current.provider === option.provider && current.model === model.id;
      box.append(item(model.label, undefined, () => pick(option.provider, model.id), { checked, disabled: busy && !checked }));
    }
    if (!option.models.length) box.append(item('No models offered', undefined, undefined, { disabled: true }));
    return box;
  }

  function render(onPicked: () => void): HTMLElement[] {
    picked = onPicked;
    const out: HTMLElement[] = [];
    if (!view) {
      out.push(item('Loading models…', undefined, undefined, { disabled: true }));
    } else {
      const chat = view.features.chat;
      if (chat.lockedBy) out.push(Object.assign(document.createElement('p'), { className: 'mm-note', textContent: `${chat.lockedBy} fixes the API key’s model (development).` }));
      for (const option of chat.options) if (option.provider !== 'underdog') out.push(group(option));
    }
    if (busy) out.push(Object.assign(document.createElement('p'), { className: 'mm-note', textContent: 'The agent is working. Stop it to change models.' }));
    if (note) out.push(Object.assign(document.createElement('p'), { className: 'mm-note error', role: 'alert', textContent: note }));
    const footer = document.createElement('div');
    footer.className = 'mm-group';
    footer.append(item('AI settings…', undefined, () => openSettings()));
    out.push(footer);
    return out;
  }

  function openSettings() {
    picked();
    void invoke('openSettings', 'ai');
  }

  async function pick(provider: AiProviderId, model: string) {
    note = '';
    try {
      view = await invoke<AiView>('ai:request', { op: 'setModel', feature: 'chat', provider, model });
      picked();
      paintButton();
    } catch (err) {
      note = errorText(err);
      changed();
    }
  }

  async function refresh() {
    note = '';
    try {
      view = await invoke<AiView>('ai:request', { op: 'view' });
    } catch (err) {
      note = errorText(err);
    }
    paintButton();
  }

  on('ai:changed', (next: AiView) => {
    view = next;
    paintButton();
  });
  void invoke<AiView | undefined>('ai:cached').then((cached) => {
    if (cached && !view) {
      view = cached;
      paintButton();
    }
  });

  return {
    setProvider(next, isBusy) {
      info = next;
      busy = isBusy;
      paintButton();
    },
    label,
    ready: () => !!info?.ready,
    render,
    refresh,
    onChange: (fn) => void listeners.push(fn),
  };
}
