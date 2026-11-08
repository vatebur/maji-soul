import { startRelay } from '../../../scripts/ego-obs-relay/server.mjs';

export interface RelayView {
  available: boolean; enabled: boolean; status: 'idle' | 'starting' | 'live' | 'stopped' | 'faulted';
  obsUrl: string | null; previewUrl: string | null; fps: number;
  dimensions: { width: number; height: number } | null; errorCode: string | null;
}
export interface RelayPort {
  readonly view: RelayView;
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}
export const idleRelay = (available = false): RelayView => ({ available, enabled: false, status: 'idle',
  obsUrl: null, previewUrl: null, fps: 0, dimensions: null, errorCode: null });

/** Owns only the capture service, independently of the game's automation worker. */
export class LiveRelay implements RelayPort {
  #relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  #view = idleRelay(true);
  readonly #space: number;
  readonly #page: string;
  readonly #port: number;
  readonly #launch: typeof startRelay;
  constructor(space: string, page: string, port = 17362, launch = startRelay) {
    if (!/^\d+$/.test(space) || !Number.isSafeInteger(Number(space)) || !/^p\d+$/.test(page)) throw Error('INVALID_CLI_ARGUMENTS');
    this.#space = Number(space); this.#page = page; this.#port = port; this.#launch = launch;
  }
  get view() { return structuredClone(this.#view); }
  async start() {
    if (this.#relay?.stats().running) return;
    await this.#relay?.close();
    this.#relay = undefined;
    this.#view = { ...idleRelay(true), enabled: true, status: 'starting' };
    try {
      this.#relay = await this.#launch({ space: this.#space, page: this.#page, port: this.#port, fps: 30, width: 1920, quality: 80 });
      await this.refresh();
    } catch (error) {
      this.#view = { ...idleRelay(true), status: 'faulted', errorCode:
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'RELAY_PORT_IN_USE' : 'RELAY_START_FAILED' };
    }
  }
  async refresh() {
    if (!this.#relay) return;
    const stats = this.#relay.stats(), address = this.#relay.address;
    this.#view = { available: true, enabled: stats.running,
      status: !stats.running ? 'faulted' : stats.sequence ? 'live' : 'starting',
      obsUrl: `${address}/obs`, previewUrl: `${address}/stream.mjpeg`, fps: stats.fps,
      dimensions: stats.dimensions, errorCode: stats.running ? null : 'RELAY_CAPTURE_FAILED' };
  }
  async stop() {
    await this.#relay?.close();
    this.#relay = undefined;
    this.#view = { ...idleRelay(true), status: 'stopped' };
  }
  async close() { await this.stop(); }
}
