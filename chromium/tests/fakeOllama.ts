// A stand-in for the local Ollama, for the tests: /api/tags and a streaming /api/chat (NDJSON,
// one JSON object per line, `message.content` pieces then `done:true`), on 127.0.0.1 and a
// random port. It records every request body, so tests can say what the model was (and was
// not) told, and its answers arrive with scripted delays, so timing can be measured.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OllamaRequest {
  path: string;
  body: any;
}

export class FakeOllama {
  server!: http.Server;
  port = 0;
  models = ['qwen3:4b', 'qwen3:1.7b', 'gemma4:12b'];
  requests: OllamaRequest[] = [];
  /** The pieces of the next answers (one list per call); the last is reused. */
  answers: string[][] = [['Sure, ', 'I can ', 'help with ', 'that. ', 'Just ', 'ask.']];
  /** ms before the first piece, and between pieces. */
  firstTokenDelay = 0;
  tokenDelay = 0;
  /** Every /api/chat answers with this status. */
  failStatus?: number;
  /** Every request is answered with a redirect to this address. */
  redirectTo?: string;
  private calls = 0;

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }
  chats() {
    return this.requests.filter((r) => r.path === '/api/chat' && r.body.stream !== false);
  }
  warmups() {
    return this.requests.filter((r) => r.path === '/api/chat' && r.body.stream === false);
  }

  static async start(): Promise<FakeOllama> {
    const fake = new FakeOllama();
    fake.server = http.createServer((req, res) => void fake.handle(req, res));
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (this.redirectTo) return void res.writeHead(302, { location: this.redirectTo }).end();
    const path = (req.url ?? '').split('?')[0];
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : undefined;
    this.requests.push({ path, body });
    if (path === '/api/tags') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: this.models.map((name) => ({ name, model: name })) }));
    if (path !== '/api/chat') return void res.writeHead(404).end();
    if (this.failStatus) return void res.writeHead(this.failStatus).end('{"error":"boom"}');
    if (body.stream === false) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'Hi' }, done: true }));
    const pieces = this.answers[Math.min(this.calls++, this.answers.length - 1)];
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let closed = false;
    res.on('close', () => (closed = true));
    await new Promise((r) => setTimeout(r, this.firstTokenDelay));
    for (const piece of pieces) {
      if (closed) return;
      res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: piece }, done: false })}\n`);
      if (this.tokenDelay) await new Promise((r) => setTimeout(r, this.tokenDelay));
    }
    if (!closed) res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true })}\n`);
  }
}
