/**
 * The browser agent's model interface. A provider keeps the conversation in its own format;
 * the chat loop only adds user text and tool results and reads back text and tool calls.
 *
 * The providers themselves live in ai/ (the OpenAI API key, a ChatGPT account through Codex),
 * and the registry (ai/registry.ts) decides which one, and which model, the chat uses.
 */
import type { ModelChoice, ProviderInfo, ToolParameters } from '../shared/browserAgent';

export interface ToolCall {
  callId: string;
  name: string;
  /** The model's JSON arguments, unparsed. */
  arguments: string;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
}

/** One conversation's history, in the provider's own format. */
export interface Conversation {
  addUser(text: string): void;
  addToolResult(callId: string, output: string): void;
}

export interface RespondRequest {
  instructions: string;
  tools: readonly ToolSpec[];
  signal: AbortSignal;
  /** The answer so far, as it streams (providers that stream call it; others don't). */
  onText?(text: string): void;
  /**
   * How hard the model thinks for this message (the composer's Thinking), and, for the OpenAI
   * API provider only, a model of its own. ChatGPT (codex.ts) takes the effort and answers with
   * the model the registry gave it.
   */
  choice?: ModelChoice;
}

export interface ChatProvider {
  readonly id: string;
  /** The model this provider answers with. */
  readonly model?: string;
  info(): Promise<ProviderInfo>;
  newConversation(): Conversation;
  /** Asks the model for its next turn; adds the turn to the conversation. */
  respond(conversation: Conversation, request: RespondRequest): Promise<Turn>;
}

/** A tool as the model sees it: the browser tools and the memory tool alike. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolParameters;
}

/**
 * A failure whose message is safe to show the user (scrubbed of keys). `code` lets a feature
 * put it in its own words: 'auth', 'quota', 'network', 'timeout', 'http', 'incomplete', 'refusal', 'empty'.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
