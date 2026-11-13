import type { BrowserPagePort } from '../../ports/browser.ts';
import { setTimeout as delay } from 'node:timers/promises';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Listener = (parameters: any) => void;

/** Debugging access is deliberately local; use an SSH tunnel for remote operation. */
export function browserEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw Error('INVALID_BROWSER_ENDPOINT'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('INVALID_BROWSER_ENDPOINT');
  return url.origin;
}

/** An explicitly configured Chromium page, independent of any desktop browser SDK. */
export class ChromiumPage implements BrowserPagePort {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #disconnected = new AbortController();
  readonly #pressed = new Map<string, { at: number; documentEpoch: number; acknowledged: Promise<any> }>();
  #documentEpoch = 0;
  #sequence = 0;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { this.close(); return; }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Error('BROWSER_COMMAND_FAILED'));
        else pending.resolve(message.result);
      } else {
        if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) this.#invalidateInput();
        for (const listener of this.#listeners.get(message.method) ?? []) {
          try { listener(message.params); }
          catch { this.close(); break; }
        }
      }
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close());
  }

  static async connect(endpoint: string) {
    const origin = browserEndpoint(endpoint);
    let targets: any;
    try {
      const response = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw Error();
      targets = await response.json();
    } catch { throw Error('BROWSER_UNAVAILABLE'); }
    if (!Array.isArray(targets)) throw Error('BROWSER_UNAVAILABLE');
    const games = targets.filter(target => target.type === 'page' && typeof target.url === 'string' &&
      target.url.startsWith('https://game.maj-soul.com/'));
    if (games.length !== 1) throw Error(games.length ? 'GAME_PAGE_AMBIGUOUS' : 'GAME_PAGE_NOT_FOUND');
    let address: URL;
    try { address = new URL(games[0].webSocketDebuggerUrl); } catch { throw Error('BROWSER_UNAVAILABLE'); }
    const expected = new URL(origin);
    if (address.protocol !== 'ws:' || address.host !== expected.host || address.username || address.password ||
        !address.pathname.startsWith('/devtools/page/')) throw Error('INVALID_BROWSER_ENDPOINT');
    const socket = new WebSocket(address);
    const page = new ChromiumPage(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(Error('BROWSER_CONNECT_TIMEOUT')); }, 5000);
        const cleanup = () => {
          clearTimeout(timer); socket.removeEventListener('open', opened);
          socket.removeEventListener('error', failed); socket.removeEventListener('close', failed);
        };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(Error('BROWSER_UNAVAILABLE')); };
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('close', failed, { once: true });
      });
      await page.cdp('Page.enable');
      return page;
    } catch (error) { page.close(); throw error; }
  }

  #invalidateInput() { this.#documentEpoch++; this.#pressed.clear(); }

  async cdp(method: string, parameters: any = {}): Promise<any> {
    // PNG remains lossless. Prefer faster encoding so a software-rendered
    // Linux frame spends less of the operation's bounded verification window
    // in compression; explicit caller preferences and other formats survive.
    if (method === 'Page.captureScreenshot' && (parameters.format === undefined || parameters.format === 'png') &&
        parameters.optimizeForSpeed === undefined) parameters = { ...parameters, optimizeForSpeed: true };
    if (method === 'Page.reload' || method === 'Page.navigate') this.#invalidateInput();
    if (method !== 'Input.dispatchMouseEvent') return this.#request(method, parameters);
    if (parameters.type === 'mouseMoved') {
      const documentEpoch = this.#documentEpoch;
      const result = await this.#request(method, parameters);
      // Unity samples pointer coordinates on its render loop. Let it observe
      // the new position before the caller checks its final fence and presses.
      // A navigation during that frame gap invalidates the pending gesture.
      try { await delay(100, undefined, { signal: this.#disconnected.signal }); }
      catch { throw Error('BROWSER_DISCONNECTED'); }
      if (documentEpoch !== this.#documentEpoch) throw Error('BROWSER_INPUT_SCOPE_CHANGED');
      return result;
    }
    const button = parameters.button ?? 'none';
    if (parameters.type === 'mousePressed') {
      // CDP defaults `buttons` to zero even on mousePressed. Unity polls the
      // held-button mask, so its canvas otherwise sees no active pointer press.
      if (parameters.buttons === undefined) parameters = { ...parameters,
        buttons: ({ left: 1, right: 2, middle: 4, back: 8, forward: 16 } as Record<string, number>)[button] ?? 0 };
      const press = { at: 0, documentEpoch: this.#documentEpoch, acknowledged: Promise.resolve<any>(undefined) };
      press.acknowledged = this.#request(method, parameters).then(result => { press.at = performance.now(); return result; });
      this.#pressed.set(button, press);
      try { return await press.acknowledged; }
      catch (error) { if (this.#pressed.get(button) === press) this.#pressed.delete(button); throw error; }
    }
    if (parameters.type === 'mouseReleased') {
      if (parameters.buttons === undefined) parameters = { ...parameters, buttons: 0 };
      const press = this.#pressed.get(button);
      if (press) {
        parameters = { ...parameters };
        // Native Unity input is sampled per frame. Keep the button down across
        // frames without delaying mousePressed after the caller's final fence.
        // An old mouse-up must never reach a replacement document.
        // Start the hold after Chromium acknowledges the press, so slow CDP
        // dispatch cannot consume the entire interval before Unity receives it.
        await press.acknowledged;
        if (this.#closed) throw Error('BROWSER_DISCONNECTED');
        if (press.documentEpoch !== this.#documentEpoch || this.#pressed.get(button) !== press)
          throw Error('BROWSER_INPUT_SCOPE_CHANGED');
        const remaining = 100 - (performance.now() - press.at);
        if (remaining > 0) {
          try { await delay(Math.ceil(remaining), undefined, { signal: this.#disconnected.signal }); }
          catch { throw Error('BROWSER_DISCONNECTED'); }
        }
        if (press.documentEpoch !== this.#documentEpoch || this.#pressed.get(button) !== press)
          throw Error('BROWSER_INPUT_SCOPE_CHANGED');
        this.#pressed.delete(button);
      }
    }
    return this.#request(method, parameters);
  }

  #request(method: string, parameters: any): Promise<any> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('BROWSER_DISCONNECTED'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id); reject(Error('BROWSER_COMMAND_TIMEOUT'));
        // An expired command may still have effects. Invalidate this connection;
        // recovery must reload the page before creating another executor.
        this.close();
      }, 15_000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params: parameters })); }
      catch { this.close(); }
    });
  }

  async evaluate(source: string | ((argument: any) => any), argument?: any) {
    const expression = typeof source === 'string' ? source : `(${source.toString()})(${JSON.stringify(argument) ?? 'undefined'})`;
    const result = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 12_000 });
    if (result.exceptionDetails) throw Error('BROWSER_EVALUATION_FAILED');
    return result.result?.value;
  }

  on(method: string, listener: Listener) {
    const listeners = this.#listeners.get(method) ?? new Set<Listener>();
    this.#listeners.set(method, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(method); };
  }

  async reload() {
    if (this.#closed) throw Error('BROWSER_DISCONNECTED');
    let remove = () => {}, timer: NodeJS.Timeout | undefined;
    let disconnected = () => {};
    const loaded = new Promise<void>((resolve, reject) => {
      remove = this.on('Page.loadEventFired', () => resolve());
      disconnected = () => reject(Error('BROWSER_DISCONNECTED'));
      this.#disconnected.signal.addEventListener('abort', disconnected, { once: true });
      timer = setTimeout(() => reject(Error('BROWSER_RELOAD_TIMEOUT')), 45_000);
    });
    // Attach a handler before issuing reload so a transport failure cannot leave
    // an unobserved rejected load promise behind.
    void loaded.catch(() => {});
    try { await this.cdp('Page.reload'); await loaded; }
    finally { clearTimeout(timer); remove(); this.#disconnected.signal.removeEventListener('abort', disconnected); }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#invalidateInput();
    this.#disconnected.abort();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer); pending.reject(Error('BROWSER_DISCONNECTED'));
    }
    this.#pending.clear(); this.#listeners.clear();
    this.#socket.close();
  }
}
