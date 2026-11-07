/**
 * Meetings, from the background: the opt-in and the other settings (saved per profile,
 * lib/joinlyState.ts), and the go-between for the Meetings sheet in the Agent panel and the
 * native host, which holds the connection to the user's joinly server (native-host/joinlyClient.ts).
 *
 * The sheet only asks; the host decides. Nothing here talks to joinly, and nothing here joins
 * a meeting by itself: the sheet's Join is a click after an explicit confirmation, the model's
 * is an approval card in the chat (native-host/agentChat.ts).
 */
import type { ToHost } from '../native-host/protocol';
import { JOINLY_DEFAULT_BOT_NAME, checkBotName, checkMeetingUrl, applyChange, cleanModelName, type JoinlyConfig, type JoinlyOp, type JoinlySettings, type JoinlyView } from '../shared/joinly';
import { broadcast, handle } from './hub';
import { HELPER_SILENT, NOT_IN_PRIVATE, configOf, helperView, initialView, loadSettings, saveSettings } from './lib/joinlyState';

export interface JoinlyContext {
  /** Sends the host a message; undefined where there is no host (private windows). */
  send?(message: Extract<ToHost, { type: 'joinly' }>): void;
}

/** What the sheet draws. */
export interface JoinlyState {
  settings: JoinlySettings;
  view: JoinlyView;
}

/** How long the host has to answer before the sheet says it didn't. */
const ANSWER_WITHIN = 6_000;

export function registerJoinly(ctx: JoinlyContext) {
  const storage = chrome.storage.local;
  let settings: JoinlySettings = { enabled: false, endpoint: '', botName: '', voiceModel: '', voiceConsent: false };
  let view: JoinlyView = initialView(settings);
  /** Whether the host has said anything yet: before that it needn't be woken just to hear "off". */
  let hostKnows = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loaded = loadSettings(storage).then((saved) => {
    settings = saved;
    view = ctx.send ? initialView(saved) : helperView(saved, NOT_IN_PRIVATE);
    publish();
  });

  const state = (): JoinlyState => ({ settings, view });
  const publish = () => broadcast('joinly', state());

  /** Tells the host something, and notes if it never answers (an old or missing helper). */
  function ask(op: JoinlyOp) {
    if (!ctx.send) return;
    try {
      ctx.send({ type: 'joinly', config: configOf(settings), ...op });
    } catch {
      return setView(helperView(settings, HELPER_SILENT));
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      hostKnows = false;
      setView(helperView(settings, HELPER_SILENT));
    }, ANSWER_WITHIN);
  }

  function setView(next: JoinlyView) {
    view = next;
    publish();
  }

  handle({
    'joinly:get': async () => {
      await loaded;
      return state();
    },
    /**
     * A change to the settings, all of it or none. Turning meetings on needs the consent the
     * sheet collects; turning them off while in a meeting makes the host leave.
     */
    'joinly:save': async (change: unknown) => {
      await loaded;
      const c = (change && typeof change === 'object' ? change : {}) as Record<string, unknown>;
      if (c.enabled === true && !settings.enabled && c.consent !== true) return { error: 'Turning meetings on needs your consent in the Meetings sheet.' };
      const result = applyChange(settings, c);
      if (!result.ok) return { error: result.reason };
      const moved = result.settings.enabled !== settings.enabled || result.settings.endpoint !== settings.endpoint;
      settings = result.settings;
      await saveSettings(storage, settings);
      view = { ...view, enabled: settings.enabled, endpoint: settings.endpoint };
      if (moved && (settings.enabled || hostKnows)) ask({ op: 'sync' });
      publish();
      return {};
    },
    /** Look for joinly now (the sheet's "Check again", and when it opens). */
    'joinly:refresh': async () => {
      await loaded;
      ask({ op: 'probe' });
      return {};
    },
    /** The sheet's Join, after its confirmation. The host checks everything again. */
    'joinly:join': async (meetingUrl: unknown, botName: unknown, confirmed: unknown) => {
      await loaded;
      if (confirmed !== true) return { error: 'Joining needs your confirmation.' };
      if (!settings.enabled) return { error: 'Turn on “Let the agent join meetings for me” first.' };
      const url = checkMeetingUrl(meetingUrl);
      if (!url.ok) return { error: url.reason };
      const name = checkBotName(botName);
      if (!name.ok) return { error: name.reason };
      if (view.status === 'joined' || view.phase) return { error: 'Already in a meeting, or joining one.' };
      // Remember the name for next time.
      if (name.name !== settings.botName) {
        settings = { ...settings, botName: name.name };
        await saveSettings(storage, settings);
      }
      ask({ op: 'join', meetingUrl: url.url, botName: name.name });
      return {};
    },
    /**
     * Voice mode (the bot answers out loud by itself, with a model on this Mac). Turning it on is a
     * click on the sheet's own button after its confirmation text; the host checks again, and
     * nothing else (not the model, not a page) can reach this.
     */
    'joinly:voice': async (on: unknown, model: unknown, confirmed: unknown) => {
      await loaded;
      if (on !== true) {
        ask({ op: 'voice', on: false });
        return {};
      }
      if (confirmed !== true) return { error: 'Voice mode needs your confirmation.' };
      if (!settings.enabled) return { error: 'Turn on “Let the agent join meetings for me” first.' };
      if (view.status !== 'joined') return { error: 'Join a meeting first: voice mode works only while the bot is in one.' };
      const name = cleanModelName(model);
      if (name !== settings.voiceModel || !settings.voiceConsent) {
        settings = { ...settings, voiceModel: name, voiceConsent: true };
        await saveSettings(storage, settings);
      }
      ask({ op: 'voice', on: true, model: name || undefined, confirmed: true });
      return {};
    },
    /** Which models the local Ollama has (the sheet's picker). */
    'joinly:voice-models': async () => {
      await loaded;
      ask({ op: 'voice-models', model: settings.voiceModel || undefined });
      return {};
    },
    'joinly:leave': async () => {
      await loaded;
      ask({ op: 'leave' });
      return {};
    },
  });

  return {
    /** Whether the user has switched on the assistant joining meetings (the calendar reminder offers it then). */
    available: async () => {
      await loaded;
      return !!ctx.send && settings.enabled;
    },
    /**
     * The calendar reminder's "Record + AI assistant": the user's click on it is the confirmation.
     * The same checks as the sheet's Join: switched on, a meeting address joinly accepts, one at a time.
     */
    joinFor: async (meetingUrl: string): Promise<{ error?: string }> => {
      await loaded;
      if (!ctx.send) return { error: NOT_IN_PRIVATE };
      if (!settings.enabled) return { error: 'Turn on “Let the agent join meetings for me” in Agent in a meeting first.' };
      const url = checkMeetingUrl(meetingUrl);
      if (!url.ok) return { error: url.reason };
      if (view.status === 'joined' || view.phase) return { error: 'The assistant is already in a meeting, or joining one.' };
      const name = checkBotName(settings.botName);
      ask({ op: 'join', meetingUrl: url.url, botName: name.ok ? name.name : JOINLY_DEFAULT_BOT_NAME });
      return {};
    },
    /** The saved setting the host is given with each chat message: whether meetings are on, and where joinly is. */
    config: async (): Promise<JoinlyConfig> => {
      await loaded;
      return configOf(settings);
    },
    /** The host's view of joinly changed, or the host went away (undefined, and why). */
    onView(next: JoinlyView | undefined, problem?: string) {
      clearTimeout(timer);
      if (next) {
        hostKnows = true;
        return setView(next);
      }
      hostKnows = false;
      const wasIn = view.status === 'joined' || !!view.phase;
      setView(helperView(settings, problem ?? 'UrAnus Browser’s helper stopped.', wasIn ? 'UrAnus Browser’s helper stopped, which ends the meeting: the bot leaves.' : undefined));
    },
    /** Whether the bot is in a meeting (or on its way in). */
    active: () => view.status === 'joined' || !!view.phase,
  };
}
