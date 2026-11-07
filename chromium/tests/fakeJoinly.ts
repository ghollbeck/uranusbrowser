// A stand-in for the user's joinly server, for the tests: a small MCP server (Streamable HTTP,
// with sessions, the way joinly's FastMCP serves it) on 127.0.0.1 and a random port, with the
// tools UrAnus Browser uses and joinly's /health. It never opens a browser or a meeting, and records
// every call so tests can say what did and did not reach it.
//
// The shapes are the REAL server's (joinly 0.5.4 on fastmcp 2.10, checked by running its
// server.py with the meeting session faked), not guesses:
//  - a tool that returns a string answers {content:[text], structuredContent:{result:"..."}};
//    get_transcript answers {segments:[{text,start,end,speaker|null,role}]} (seconds since the
//    bot was admitted); get_participants answers {result:[{name,email,infos}]}, its own entry
//    having "You" among the infos;
//  - a failed tool call is isError with the text "Error calling tool 'x': <message>", and the
//    reason for a failed join is hidden: always "Failed to perform 'join'.";
//  - speak_text that someone interrupted is NOT an error: it answers
//    'Interrupted by detected speech. Spoken until now: "..."';
//  - chat messages over 500 characters are refused; the transcript and participants are only
//    there once joined;
//  - POST /mcp redirects (307) to /mcp/;
//  - one controlling client: while a session is open (or still closing, for `lingerMs` after
//    its DELETE) a new connection gets a 200 event stream that simply ends, with no answer.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface FakeSegment {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
  role?: 'participant' | 'assistant';
}

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
  session: string;
  at: number;
}

export class FakeJoinly {
  server!: http.Server;
  port = 0;
  calls: FakeCall[] = [];
  /** MCP sessions opened and closed (joinly makes a whole meeting session per connection). */
  opened = 0;
  closed = 0;
  /** Requests that reached /health. */
  healthHits = 0;
  segments: FakeSegment[] = [];
  participants: Array<{ name: string; email?: string | null; infos?: string[] }> = [];
  /** Tool name to message: that tool answers with an error result, once. */
  fail = new Map<string, string>();
  /** join_meeting waits until `admit()` (or the connection ends). */
  holdJoin = false;
  /** join_meeting waits this long (ms), then fails the way joinly does (or succeeds). */
  joinDelay = 0;
  /** join_meeting fails with joinly's one sentence, after `joinDelay`. */
  failJoin = false;
  /** speak_text answers that someone interrupted. */
  interruptSpeech = false;
  /** speak_text takes this long (ms) to be "said", as the real one blocks until the words are spoken. */
  speakDelay = 0;
  /** speak_text fails (joinly's text is "Error while speaking text"). */
  speakFails = false;
  /** The bot's own name in the transcript when it speaks. */
  botSpeaker = 'UrAnus Browser AI assistant';
  /** Only one session at a time, like joinly's single bot browser. */
  exclusive = true;
  /** How long (ms) the bot browser stays taken after a session's DELETE. */
  lingerMs = 0;
  /** The first answer (initialize) takes this long, as joinly loads its models and browser. */
  initDelay = 0;
  /**
   * Like the real server: resources/subscribe on transcript://live is accepted (although it
   * advertises subscribe:false) and a notification with only the uri follows each finished
   * utterance. false: the subscription is refused, so clients must poll.
   */
  pushes = true;
  /** The settings header (`joinly-settings`) each new session was opened with. */
  settingsHeaders: Array<string | undefined> = [];
  private subscribers = new Set<McpServer>();
  private clock = 0;
  private admitJoin?: () => void;
  /** Answer every request with a redirect to this address. */
  redirectTo?: string;
  /** What /health answers with, when not joinly's own. */
  health: { status: number; body: string } | undefined;
  /** Leave the tools out, to look like some other MCP server. */
  withoutTools: string[] = [];
  private sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  private takenUntil = 0;

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }
  get endpoint() {
    return `${this.url}/mcp/`;
  }
  /**
   * Someone says something: it is in the transcript now and, once "recognised" (the real server
   * notifies when the utterance's speech-to-text is finished), subscribers are told.
   */
  hear(text: string, speaker: string | null = 'Anna Keller', options: { notify?: boolean; role?: 'participant' | 'assistant'; gap?: number } = {}) {
    this.clock += options.gap ?? 2;
    const start = this.clock;
    this.segments.push({ text, start, end: start + 1.5, speaker, role: options.role ?? 'participant' });
    this.clock = start + 1.5;
    if (options.notify !== false) this.pushTalk();
  }
  /** The notification alone. */
  pushTalk() {
    for (const server of this.subscribers) void server.server.sendResourceUpdated({ uri: 'transcript://live' }).catch(() => undefined);
  }
  tools(name: string) {
    return this.calls.filter((c) => c.tool === name);
  }
  admit() {
    this.admitJoin?.();
  }

  /** On a random free port, or the given one (to come back where an earlier one was). */
  static async start(port = 0): Promise<FakeJoinly> {
    const fake = new FakeJoinly();
    fake.server = http.createServer((req, res) => void fake.handle(req, res));
    await new Promise<void>((resolve) => fake.server.listen(port, '127.0.0.1', resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  /** The server vanishes, as if its container was stopped: connections drop, nothing answers. */
  async vanish() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async stop() {
    this.admit();
    await this.vanish().catch(() => undefined);
  }

  private build(): McpServer {
    const mcp = new McpServer({ name: 'fake-joinly', version: '0.0.0' });
    const state = { joined: false };
    if (this.pushes) {
      mcp.server.registerCapabilities({ resources: { subscribe: true } });
      mcp.server.setRequestHandler(SubscribeRequestSchema, async () => {
        this.subscribers.add(mcp);
        return {};
      });
    }
    const session = () => 'session';
    const failed = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });
    /** FastMCP's wording for a failed tool call. */
    const failure = (tool: string, message: string) => failed(`Error calling tool '${tool}': ${message}`);
    const reply = (tool: string, args: Record<string, unknown>, ok: string, data?: unknown) => {
      this.calls.push({ tool, args, session: session(), at: Date.now() });
      const injected = this.fail.get(tool);
      if (injected) {
        this.fail.delete(tool);
        return failure(tool, injected);
      }
      // A tool that returns a string: FastMCP wraps it as {result}. A model: its fields.
      return data === undefined
        ? { content: [{ type: 'text' as const, text: ok }], structuredContent: { result: ok } }
        : { content: [{ type: 'text' as const, text: JSON.stringify(Array.isArray((data as { result?: unknown }).result) ? (data as { result: unknown }).result : data) }], structuredContent: data as Record<string, unknown> };
    };
    const needsMeeting = (tool: string, what: string) => {
      this.calls.push({ tool, args: {}, session: session(), at: Date.now() });
      return failure(tool, what);
    };
    const add = (name: string, description: string, shape: Record<string, z.ZodType>, run: (args: Record<string, any>) => unknown | Promise<unknown>) => {
      if (this.withoutTools.includes(name)) return;
      (mcp.registerTool as (n: string, s: object, cb: (args: Record<string, any>) => Promise<unknown>) => void)(name, { description, inputSchema: shape }, async (args) => run(args));
    };
    add('join_meeting', 'Join a meeting with the given URL and participant name.', { meeting_url: z.string().nullable().optional(), participant_name: z.string().nullable().optional(), passcode: z.string().nullable().optional() }, async (args) => {
      if (this.holdJoin) await new Promise<void>((resolve) => (this.admitJoin = resolve));
      if (this.joinDelay) await new Promise((resolve) => setTimeout(resolve, this.joinDelay));
      if (this.failJoin) {
        this.calls.push({ tool: 'join_meeting', args, session: session(), at: Date.now() });
        // Whatever the cause (403, nobody admitted it, a changed page), joinly's answer is this one sentence.
        return failure('join_meeting', "Failed to perform 'join'.");
      }
      const out = reply('join_meeting', args, 'Joined meeting.');
      if (!('isError' in out && out.isError)) state.joined = true;
      return out;
    });
    add('leave_meeting', 'Leave the current meeting.', {}, () => {
      const out = reply('leave_meeting', {}, 'Left the meeting.');
      state.joined = false;
      return out;
    });
    add('speak_text', 'Speak the given text in the meeting.', { text: z.string() }, (args) => {
      if (this.interruptSpeech) {
        this.calls.push({ tool: 'speak_text', args, session: session(), at: Date.now() });
        const said = String(args.text).split(' ').slice(0, 2).join(' ');
        return { content: [{ type: 'text' as const, text: `Interrupted by detected speech. Spoken until now: "${said}..."` }], structuredContent: { result: `Interrupted by detected speech. Spoken until now: "${said}..."` } };
      }
      if (this.speakFails) {
        this.calls.push({ tool: 'speak_text', args, session: session(), at: Date.now() });
        return failure('speak_text', 'Error while speaking text');
      }
      const out = reply('speak_text', args, 'Finished speaking.');
      const spoken = async () => {
        if (this.speakDelay) await new Promise((resolve) => setTimeout(resolve, this.speakDelay));
        // What the bot says is in the transcript too, with the role assistant.
        this.hear(String(args.text), this.botSpeaker, { role: 'assistant', notify: false, gap: 0.2 });
        return out;
      };
      return spoken();
    });
    add('send_chat_message', 'Send a chat message in the meeting chat.', { message: z.string() }, (args) => {
      const message = String(args.message);
      if (message.length > 500) {
        this.calls.push({ tool: 'send_chat_message', args, session: session(), at: Date.now() });
        return failure('send_chat_message', `Message exceeds the maximum length of 500 characters, got ${message.length}.`);
      }
      return reply('send_chat_message', args, 'Sent message.');
    });
    add('get_transcript', 'Get the transcript of the meeting.', { mode: z.enum(['full', 'first', 'latest']).optional(), minutes: z.number().optional() }, (args) =>
      state.joined ? reply('get_transcript', args, '', { segments: this.segments }) : needsMeeting('get_transcript', 'Not joined any meeting, cannot access transcript.'),
    );
    add('get_participants', 'Get the list of participants in the meeting.', {}, () =>
      state.joined ? reply('get_participants', {}, '', { result: this.participants }) : needsMeeting('get_participants', "Failed to perform 'get_participants'. Currently not in a meeting."),
    );
    add('share_screen', 'Start sharing your screen in the meeting.', { url: z.string() }, (args) => reply('share_screen', args, 'Started sharing screen.'));
    return mcp;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (this.redirectTo) return void res.writeHead(302, { location: this.redirectTo }).end();
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health') {
      this.healthHits++;
      if (this.health) return void res.writeHead(this.health.status, { 'content-type': 'application/json' }).end(this.health.body);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'healthy' }));
    }
    if (path !== '/mcp/') return void res.writeHead(path === '/mcp' ? 307 : 404, path === '/mcp' ? { location: '/mcp/' } : {}).end();
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    const id = req.headers['mcp-session-id'] as string | undefined;
    let entry = id ? this.sessions.get(id) : undefined;
    if (!entry && !id && req.method === 'POST') {
      // joinly builds a whole meeting session for a new connection; its one bot browser can be
      // taken by one session only, and then the opening request just gets an event stream that ends.
      if (this.initDelay) await new Promise((resolve) => setTimeout(resolve, this.initDelay));
      if (this.exclusive && (this.sessions.size > 0 || Date.now() < this.takenUntil)) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': crypto.randomUUID() });
        res.flushHeaders();
        // The server's session task died: the stream is cut short, not finished (uvicorn: "ASGI callable returned without completing response").
        return void setTimeout(() => res.socket?.destroy(), 20);
      }
      const server = this.build();
      this.settingsHeaders.push(req.headers['joinly-settings'] as string | undefined);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          this.opened++;
          this.sessions.set(sid, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId && this.sessions.delete(transport.sessionId)) {
          this.closed++;
          this.subscribers.delete(server);
          this.takenUntil = Date.now() + this.lingerMs;
        }
      };
      await server.connect(transport);
      entry = { transport, server };
    }
    if (!entry) return void res.writeHead(404).end('Session not found');
    await entry.transport.handleRequest(req, res, body);
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
