// What the end-to-end tests share: a small DevTools protocol client and waiting helpers.
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- browsers a test started: never left running ----------------------------------------------

const reaped = new Set();
/**
 * Registers a browser the test launched, and makes sure it is stopped when the test ends for any
 * reason, a crash or a failed wait included. (A test that threw used to leave its UrAnus Browser window
 * open, on a throwaway profile, where it could be mistaken for the real browser.)
 */
export function reap(child) {
  reaped.add(child);
  child.once('exit', () => reaped.delete(child));
  return child;
}
const stopAll = () => {
  for (const child of reaped) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
};
process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

// ---- a small DevTools protocol client ------------------------------------------------

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async session(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return {
      eval: async (expression) => {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      send: (method, params) => this.send(method, params, sessionId),
    };
  }
  async targets() {
    return (await this.send('Target.getTargets')).targetInfos;
  }
  async waitTarget(match, ms = 90000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const t = (await this.targets()).find(match);
      if (t) return t;
      await wait(250);
    }
    throw new Error('target never appeared');
  }
}

export async function until(fn, what, ms = 90000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch((e) => (console.error('  (retrying)', e.message), undefined));
    if (last) return last;
    await wait(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

