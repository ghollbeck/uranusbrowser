/**
 * Settings › AI: how Uranus Browser reaches a model, and which model each AI feature uses.
 *
 * - ChatGPT account: sign in (Codex opens a ChatGPT sign-in page in a Uranus Browser tab), sign out,
 *   the plan and how much of its limits is used.
 * - OpenAI API key: pasted here, sent once to the native host, which stores it in the macOS
 *   Keychain. It is never sent back: the page only learns whether there is one.
 * - On this Mac (Underdog): whether the on-device model is set up.
 * - Models for each feature: a provider and a model per feature. Providers that can't do a
 *   feature, or aren't set up, are greyed out with the reason.
 *
 * Everything is decided in the host (native-host/ai/registry.ts); this page shows it.
 */
import {
  AI_FEATURES,
  FEATURE_LABELS,
  OPENAI_KEY_PATTERN,
  type AiFeature,
  type AiFeatureOption,
  type AiLimitWindow,
  type AiProviderId,
  type AiProviderView,
  type AiRequest,
  type AiView,
} from '../../shared/aiProtocol';
import { invoke, on } from '../client';
import { customSelect } from './select';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CODEX_INSTALL = 'https://developers.openai.com/codex/cli';

let view: AiView | undefined;
let busy = false;

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, '');

function showError(text?: string) {
  const el = $('ai-error');
  el.hidden = !text;
  el.textContent = text ?? '';
}

async function request(req: AiRequest) {
  busy = true;
  showError();
  paint();
  try {
    view = await invoke<AiView>('ai:request', req);
  } catch (err) {
    showError(errorText(err));
  } finally {
    busy = false;
    paint();
  }
}

// ---- the three providers ------------------------------------------------------------------------

function limitText(name: string, w?: AiLimitWindow) {
  if (!w) return '';
  const resets = w.resetsAt ? `, resets ${new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  return `${name} ${Math.round(w.usedPercent)}% used${resets}`;
}

function windowName(w: AiLimitWindow | undefined, fallback: string) {
  if (!w?.windowMins) return fallback;
  if (w.windowMins >= 7 * 24 * 60 - 60) return 'Weekly limit';
  if (w.windowMins >= 60) return `${Math.round(w.windowMins / 60)}-hour limit`;
  return `${w.windowMins}-minute limit`;
}

function paintChatGpt(p: AiProviderView | undefined) {
  const status = $('ai-chatgpt-status');
  const action = $<HTMLButtonElement>('ai-chatgpt-action');
  const cancel = $<HTMLButtonElement>('ai-chatgpt-cancel');
  const limits = $('ai-chatgpt-limits');
  cancel.hidden = !p?.loginPending;
  action.disabled = busy || !p;
  limits.hidden = true;
  if (!p) {
    status.textContent = 'Checking…';
    action.textContent = 'Sign In';
    return;
  }
  if (p.installed === false) {
    status.textContent = p.detail;
    action.textContent = 'Get Codex';
    action.dataset.op = 'install';
    return;
  }
  if (p.loginPending) {
    status.textContent = 'Finish signing in on the ChatGPT page that opened in a new tab.';
    action.textContent = 'Open Again';
    action.dataset.op = 'login';
    return;
  }
  if (p.ready) {
    const who = [p.account?.email, p.account?.plan ? `${p.account.plan[0].toUpperCase()}${p.account.plan.slice(1)} plan` : ''].filter(Boolean).join(' · ');
    status.textContent = who ? `Signed in: ${who}` : 'Signed in';
    const parts = [limitText(windowName(p.limits?.primary, 'Short limit'), p.limits?.primary), limitText(windowName(p.limits?.secondary, 'Long limit'), p.limits?.secondary)].filter(Boolean);
    limits.hidden = !parts.length;
    limits.textContent = parts.join(' · ');
    action.textContent = 'Sign Out';
    action.dataset.op = 'logout';
    return;
  }
  status.textContent = p.detail;
  action.textContent = 'Sign In';
  action.dataset.op = 'login';
}

function paintKey(p: AiProviderView | undefined) {
  const status = $('ai-key-status');
  const input = $<HTMLInputElement>('ai-key-input');
  const remove = $<HTMLButtonElement>('ai-key-remove');
  status.textContent = p?.detail ?? 'Checking…';
  remove.hidden = p?.keySource !== 'keychain';
  remove.disabled = busy;
  input.placeholder = p?.ready ? 'Replace key: sk-…' : 'sk-…';
  input.disabled = busy;
  $<HTMLButtonElement>('ai-key-save').disabled = busy || !OPENAI_KEY_PATTERN.test(input.value.trim());
}

// ---- models for each feature ----------------------------------------------------------------------

/** A short reason for a greyed-out choice in a menu; the full one is under the row. */
function shortReason(option: AiFeatureOption) {
  if (!option.reason) return '';
  if (/transcribe audio/.test(option.reason)) return 'can’t transcribe audio';
  if (/browser tools/.test(option.reason)) return 'can’t use the browser tools';
  if (/text only/.test(option.reason)) return 'text only';
  if (option.provider === 'codex') return 'sign in first';
  if (option.provider === 'openai') return 'add a key first';
  return 'not set up';
}

function featureRow(feature: AiFeature): HTMLElement {
  const f = view!.features[feature];
  const row = document.createElement('div');
  row.className = 'row ai-feature';
  row.dataset.feature = feature;
  const text = document.createElement('div');
  text.className = 'row-text';
  const title = document.createElement('strong');
  title.textContent = FEATURE_LABELS[feature];
  const small = document.createElement('small');
  const current = f.options.find((o) => o.provider === f.provider);
  const notes: string[] = [];
  if (current && !current.available && current.reason) notes.push(current.reason);
  if (f.lockedBy) notes.push(`${f.lockedBy} fixes the OpenAI model (development).`);
  // ChatGPT can't transcribe: said in so many words, not only in the greyed-out menu entry.
  const chatgpt = f.options.find((o) => o.provider === 'codex');
  if (feature === 'transcribe' && chatgpt?.reason) notes.push(chatgpt.reason);
  small.textContent = [describe(feature, f.followsChat), ...notes].join(' ');
  text.append(title, small);

  const controls = document.createElement('div');
  controls.className = 'ai-actions';
  const providerSelect = document.createElement('select');
  providerSelect.className = 'select ai-provider';
  providerSelect.setAttribute('aria-label', `${FEATURE_LABELS[feature]}: provider`);
  if (feature === 'routines') providerSelect.append(new Option('Same as chat', 'follow', false, !!f.followsChat));
  for (const o of f.options) {
    const option = new Option(o.available ? o.label : `${o.label} (${shortReason(o)})`, o.provider, false, !f.followsChat && o.provider === f.provider);
    // A provider that is chosen but not set up stays selectable, so the menu shows the truth.
    option.disabled = !o.available && !(o.provider === f.provider && !f.followsChat);
    if (o.reason) option.title = o.reason;
    providerSelect.append(option);
  }
  providerSelect.disabled = busy;
  providerSelect.addEventListener('change', () => {
    const picked = providerSelect.value;
    if (picked === 'follow') return void request({ op: 'followChat', feature: 'routines' });
    const option = f.options.find((o) => o.provider === picked);
    void request({ op: 'setModel', feature, provider: picked as AiProviderId, model: option?.models[0]?.id ?? '' });
  });

  const modelSelect = document.createElement('select');
  modelSelect.className = 'select ai-model';
  modelSelect.setAttribute('aria-label', `${FEATURE_LABELS[feature]}: model`);
  const models = [...(current?.models ?? [])];
  if (!models.some((m) => m.id === f.model)) models.unshift({ id: f.model, label: f.model });
  for (const m of models) modelSelect.append(new Option(m.label, m.id, false, m.id === f.model));
  modelSelect.disabled = busy || !!f.lockedBy || !!f.followsChat || !current?.available;
  modelSelect.addEventListener('change', () => void request({ op: 'setModel', feature, provider: f.provider, model: modelSelect.value }));
  controls.append(customSelect(providerSelect), customSelect(modelSelect));
  row.append(text, controls);
  return row;
}

function describe(feature: AiFeature, followsChat?: boolean) {
  switch (feature) {
    case 'chat':
      return 'The Agent panel, companions and artifacts.';
    case 'routines':
      return followsChat ? 'Scheduled routines. Same model as the agent chat.' : 'Scheduled routines.';
    case 'meetingSummary':
      return 'Writes meeting notes from the transcript.';
    case 'transcribe':
      return 'Turns meeting audio into text in the cloud.';
  }
}

function paint() {
  const by = (id: AiProviderId) => view?.providers.find((p) => p.id === id);
  paintChatGpt(by('codex'));
  paintKey(by('openai'));
  $('ai-underdog-status').textContent = by('underdog')?.detail ?? 'Checking…';
  const list = $('ai-features');
  // Don't redraw a menu the user has open.
  if (list.querySelector('.fs-trigger[aria-expanded="true"]') && !busy) return;
  list.replaceChildren(...(view ? AI_FEATURES.map(featureRow) : []));
}

// ---- wiring --------------------------------------------------------------------------------------

$('ai-chatgpt-action').addEventListener('click', () => {
  const op = $('ai-chatgpt-action').dataset.op;
  if (op === 'install') return void invoke('newTab', CODEX_INSTALL);
  if (op === 'logout') return void request({ op: 'logout' });
  void request({ op: 'login' });
});
$('ai-chatgpt-cancel').addEventListener('click', () => void request({ op: 'cancelLogin' }));

const keyInput = $<HTMLInputElement>('ai-key-input');
keyInput.addEventListener('input', () => {
  $<HTMLButtonElement>('ai-key-save').disabled = busy || !OPENAI_KEY_PATTERN.test(keyInput.value.trim());
});
$('ai-key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  // The key leaves this page once, to the host; the field is emptied straight away.
  keyInput.value = '';
  if (!OPENAI_KEY_PATTERN.test(key)) return showError('That doesn’t look like an OpenAI API key (sk-…).');
  void request({ op: 'setKey', key });
});
$('ai-key-remove').addEventListener('click', () => void request({ op: 'removeKey' }));

on('ai:changed', (next: AiView) => {
  view = next;
  paint();
});

/** Asks the host again whenever the pane comes into view (a sign-in may have finished elsewhere). */
function refresh() {
  void request({ op: 'view' });
}
const pane = document.querySelector<HTMLElement>('.pane[data-pane="ai"]')!;
new MutationObserver(() => {
  if (!pane.hidden) refresh();
}).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
void invoke<AiView | undefined>('ai:cached').then((cached) => {
  if (cached && !view) {
    view = cached;
    paint();
  }
});
if (!pane.hidden) refresh();
paint();
