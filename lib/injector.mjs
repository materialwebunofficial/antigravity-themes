// Talks to a running Antigravity over the Chrome DevTools Protocol on
// 127.0.0.1: Antigravity opens that port itself on every launch. Nothing is
// sent anywhere else, and no app file is changed: the theme lives in the
// open windows, and a script registered for each window's next document
// brings it back after a reload while the connection lasts.
import { readFileSync } from 'node:fs';
import { portFile } from './paths.mjs';

const TARGET_TYPES = new Set(['page', 'webview', 'iframe']);

export function readPort() {
  const file = portFile();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${file} was not found. Is Antigravity running?`);
  }
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${file} holds no port.`);
  return port;
}

export async function listTargets(port) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`);
  } catch {
    throw new Error(`Antigravity does not answer on port ${port}. Is it running?`);
  }
  const targets = await res.json();
  return targets.filter((t) => TARGET_TYPES.has(t.type) && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'));
}

export class Session {
  constructor(target) {
    this.target = target;
    this.nextId = 0;
    this.pending = new Map();
    this.scriptId = null;
    this.pageEnabled = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error(`cannot connect to ${this.target.url}`));
      this.ws.onclose = () => {
        for (const { reject: fail } of this.pending.values()) fail(new Error('connection closed'));
        this.pending.clear();
        this.onclose?.();
      };
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const call = msg.id && this.pending.get(msg.id);
        if (!call) return;
        this.pending.delete(msg.id);
        if (msg.error) call.reject(new Error(msg.error.message));
        else call.resolve(msg.result);
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Now, and on every new document in this window while connected. Chromium
  // runs scripts registered for new documents only once the Page domain is
  // enabled on this connection.
  async apply(source) {
    if (!this.pageEnabled) {
      await this.send('Page.enable');
      this.pageEnabled = true;
    }
    if (this.scriptId) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId });
    ({ identifier: this.scriptId } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }));
    await this.evaluate(source);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result?.value;
  }

  close() {
    this.ws.close();
  }
}

// Runs one script in every open window and closes again
export async function evaluateEverywhere(script, port = readPort()) {
  const results = [];
  for (const target of await listTargets(port)) {
    const session = new Session(target);
    try {
      await session.open();
      results.push({ url: target.url, value: await session.evaluate(script) });
    } catch (err) {
      results.push({ url: target.url, error: err.message });
    } finally {
      session.close();
    }
  }
  return results;
}

// The long-running part: themes every window Antigravity opens, keeps the
// theme across reloads, follows the port when the app restarts, and waits
// while it is closed. getSource() is read again when reload() is called.
export function watch({ getSource, log = () => {} }) {
  const sessions = new Map();   // target id -> Session
  let port = null;
  let source = getSource();
  let waiting = false;

  function followPort() {
    const next = readPort();
    if (next === port) return;
    for (const session of sessions.values()) session.close();
    sessions.clear();
    if (port !== null) log(`Antigravity restarted (port ${next})`);
    port = next;
  }

  async function attachNew() {
    for (const target of await listTargets(port)) {
      if (sessions.has(target.id)) continue;
      const session = new Session(target);
      sessions.set(target.id, session);
      session.onclose = () => sessions.delete(target.id);
      try {
        await session.open();
        await session.apply(source);
        log(`themed ${target.type} ${target.url}`);
      } catch (err) {
        log(`${target.url}: ${err.message}`);
        sessions.delete(target.id);
      }
    }
  }

  async function tick() {
    try {
      followPort();
      await attachNew();
      if (waiting) log(`Antigravity found on port ${port}`);
      waiting = false;
    } catch (err) {
      if (!waiting) log(`waiting for Antigravity (${err.message})`);
      waiting = true;
    }
  }

  const timer = setInterval(tick, 2000);
  tick();
  return {
    async reload() {
      source = getSource();
      for (const session of sessions.values()) {
        try { await session.apply(source); } catch (err) { log(`reload failed for ${session.target.url}: ${err.message}`); }
      }
      log(`reloaded into ${sessions.size} window(s)`);
    },
    stop() {
      clearInterval(timer);
      for (const session of sessions.values()) session.close();
    },
  };
}
