/**
 * The background side of the shell's messaging. Every UrAnus Browser page (sidebar, Settings, …)
 * connects a port named "anus"; commands are fire-and-forget, invokes get a reply, and
 * events go out to every connected page. Feature modules register their own handlers, so
 * they never need to touch one shared switch.
 */
import type { Message } from './protocol';

type Handler = (...args: any[]) => unknown;

const commands = new Map<string, Handler>();
const ports = new Set<chrome.runtime.Port>();
/** The window each page said it is in. */
const portWindows = new WeakMap<chrome.runtime.Port, number>();
let beforeCommand: ((windowId: number, name: string) => unknown) | undefined;

/** Runs (and is awaited) before each command from a page that said its window. */
export function beforeWindowCommand(fn: (windowId: number, name: string) => unknown) {
  beforeCommand = fn;
}

/** Adds handlers by name; a name registered twice is a bug, so it throws. */
export function handle(handlers: Record<string, Handler>) {
  for (const [name, fn] of Object.entries(handlers)) {
    if (commands.has(name)) throw new Error(`UrAnus Browser shell: "${name}" is handled twice`);
    commands.set(name, fn);
  }
}

/**
 * Runs a registered command from the background itself (a keyboard shortcut, say), as if a
 * page had sent it. A command nobody handles yet is reported, not thrown.
 */
export function call(name: string, ...args: unknown[]): unknown {
  const fn = commands.get(name);
  if (!fn) return void console.warn(`UrAnus Browser shell: "${name}" isn't in the Chromium build yet`);
  return fn(...args);
}

/**
 * Runs a command another module registered, as if a page had sent it (a feature asking for
 * DevTools, say). Returns false when nothing handles that name yet.
 */
export function run(name: string, ...args: unknown[]) {
  const fn = commands.get(name);
  if (!fn) return false;
  void Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => console.error(`UrAnus Browser shell: "${name}" failed`, err));
  return true;
}

/** Sends an event to every open UrAnus Browser page. */
export function broadcast(name: string, ...args: unknown[]) {
  const message: Message = { type: 'event', name, args };
  for (const port of ports) port.postMessage(message);
}

/** Calls fn whenever a page connects (to send it the current state, say). */
const connectListeners: Array<(port: chrome.runtime.Port) => void> = [];
export function onConnect(fn: (port: chrome.runtime.Port) => void) {
  connectListeners.push(fn);
}

/** Starts taking connections; messages wait until `ready` (handlers registered) resolves. */
export function listen(ready: Promise<unknown>) {
  chrome.runtime.onConnect.addListener(async (port) => {
    if (port.name !== 'anus') return;
    // Only UrAnus Browser's own pages: not content scripts in web pages (whose origin is the site's),
    // since this port runs commands, the Agent panel's approvals among them.
    if (port.sender?.origin && port.sender.origin !== new URL(chrome.runtime.getURL('')).origin) {
      port.disconnect();
      return;
    }
    // Buffer what arrives while the background is still loading.
    const early: Message[] = [];
    const buffer = (m: Message) => void early.push(m);
    port.onMessage.addListener(buffer);
    await ready;
    port.onMessage.removeListener(buffer);
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    const dispatch = async (message: Message) => {
      if (message.type === 'ping') return;
      if (message.type === 'window') return void portWindows.set(port, message.id);
      if (message.type !== 'cmd' && message.type !== 'invoke') return;
      const windowId = portWindows.get(port);
      if (windowId !== undefined) await Promise.resolve(beforeCommand?.(windowId, message.name)).catch(() => undefined);
      const fn = commands.get(message.name);
      if (!fn) {
        console.warn(`UrAnus Browser shell: "${message.name}" isn't in the Chromium build yet`);
        if (message.type === 'invoke') port.postMessage({ type: 'result', id: message.id, value: undefined } satisfies Message);
        return;
      }
      try {
        const value = await fn(...message.args);
        if (message.type === 'invoke') port.postMessage({ type: 'result', id: message.id, value } satisfies Message);
      } catch (err) {
        console.error(`UrAnus Browser shell: "${message.name}" failed`, err);
        if (message.type === 'invoke') port.postMessage({ type: 'result', id: message.id, error: String(err) } satisfies Message);
      }
    };
    port.onMessage.addListener(dispatch);
    for (const fn of connectListeners) fn(port);
    for (const m of early) void dispatch(m);
  });
}
