/**
 * What the shell extension (chromium/shell/nativeHost.ts) and the native messaging host
 * (host.ts) say to each other. Chromium frames each message as JSON with a length prefix;
 * the host's messages may be at most 1 MB, so bigger ones go as `chunk`s.
 */

/** The host's name in its manifest and in chrome.runtime.connectNative. */
export const HOST_NAME = 'dev.oprimo.anus.host';

/** Things only Node can do, which the shell asks for and the host answers with a `reply`. */
export interface HostMethods {
  readArcPasswords(): import('../shared/arcPasswords').ArcPasswords;
  detectBrowsers(): import('../shared/types').DetectedBrowser[];
  readBrowser(id: string): import('../shared/importApply').BrowserImportData;
  /** A bookmarks file exported from any browser as HTML, by its text; `fileName` is for warnings. */
  readBookmarksHtml(html: string, fileName?: string): import('../shared/importApply').BrowserImportData;
  /** The Electron spike's saved state (its anus-state.json), if it has one. */
  readAnusState(): string | undefined;
  /** Meeting notes (meetingTranscribe.ts, meetingSummary.ts): which engines are usable, one audio chunk to text, a transcript to grounded notes. */
  meetingEngines(): import('../shared/meetingProtocol').EngineInfo[];
  meetingTranscribe(request: import('../shared/meetingProtocol').MeetingTranscribeRequest): import('../shared/meetingProtocol').MeetingTranscribeReply;
  /** Opens a pane of System Settings > Privacy & Security, by name from a fixed list. */
  openPrivacyPane(pane: string): boolean;
  /** Whether the on-device Underdog model could run (looked up from files; loads nothing). */
  underdogInfo(): import('../shared/meetingProtocol').UnderdogInfo;
  meetingSummarize(request: import('../shared/meetingProtocol').MeetingSummarizeRequest): import('../shared/meetingProtocol').MeetingSummarizeReply;
  /** The composer's modes: the OpenAI API key's chat models, the default model, and the chat's provider. */
  agentModels(): { models: string[]; default: string; provider: string };
  /** The central AI provider (ai/registry.ts): what Settings › AI and the panel's model menu show and change. */
  ai(request: import('../shared/aiProtocol').AiRequest): AiReply;
  /** A document attached to a companion (PDF, Word, RTF…) as text (fileText.ts). */
  extractText(request: import('../shared/knowledge').ExtractRequest): import('../shared/knowledge').ExtractReply;
  /** The Algorithm Diet's prompts (sorting unknown sites, the chat with your history), answered by Underdog Woof on this Mac only. */
  dietComplete(request: { system: string; user: string; maxTokens: number }): string;
}

export interface AiReply {
  view: import('../shared/aiProtocol').AiView;
  /** login: the page where the user signs in to ChatGPT; the shell opens it in a tab. */
  authUrl?: string;
}

export type ToShell =
  | { type: 'reply'; id: number; value?: unknown; error?: string }
  /** The agent bridge started (with its address), stopped, or failed. */
  | { type: 'agent'; endpoint?: string; error?: string }
  /** A coding agent called a tool: the shell runs it and answers with a `toolResult`. */
  | { type: 'tool'; id: number; name: string; args: Record<string, unknown> }
  /** The Agent panel's conversation, as it is now (sent on every change). */
  | { type: 'chat'; snapshot: import('../shared/browserAgent').ChatSnapshot }
  /** The central AI provider changed (a sign-in finished, a key was saved, a model picked). */
  | { type: 'ai'; view: import('../shared/aiProtocol').AiView }
  /** Meetings (joinly): how it is now, sent on every change and in answer to every `joinly` message. */
  | { type: 'joinly'; view: import('../shared/joinly').JoinlyView }
  /** A click on the meeting reminder's floating panel (reminderPopup.ts); the panel has closed. */
  | { type: 'reminder'; id: string; action: import('../shared/calendar').ReminderAction }
  /** One part of a message too big to send at once; the parts, joined, are its JSON. */
  | { type: 'chunk'; id: number; index: number; total: number; data: string };

export type ToHost =
  | { type: 'call'; id: number; method: keyof HostMethods; params: unknown[] }
  /** Starts or stops the agent bridge; the token is checked on every request. */
  | { type: 'agent'; enabled: boolean; token: string }
  | { type: 'toolResult'; id: number; result: import('../shared/agentTools').AgentResult }
  /** What the user did in the Agent panel. */
  | ({ type: 'chat' } & import('../shared/browserAgent').ChatAction)
  /** What the user did in the Meetings sheet. `config` is the saved setting, sent with every one. */
  | ({ type: 'joinly'; config: import('../shared/joinly').JoinlyConfig } & import('../shared/joinly').JoinlyOp)
  /** The meeting reminder's floating panel on the pointer's display: this meeting, or none (closes it). */
  | { type: 'reminder'; show?: import('../shared/calendar').ReminderSpec };
