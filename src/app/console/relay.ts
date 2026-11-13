import { startRelay } from '../../../scripts/ego-obs-relay/server.mjs';

export interface RelayView {
  available: boolean; enabled: boolean; status: 'idle' | 'starting' | 'live' | 'recovering' | 'stopped' | 'faulted';
  obsUrl: string | null; previewUrl: string | null; fps: number;
  dimensions: { width: number; height: number } | null; errorCode: string | null;
  recoveryCount?: number; nextRetryAt?: string | null;
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
  readonly #now: () => number;
  #desired = false;
  #startedAt = 0;
  #retryAt = 0;
  #failures = 0;
  #recoveries = 0;
  constructor(space: string, page: string, port = 17362, launch = startRelay, now = () => Date.now()) {
    if (!/^\d+$/.test(space) || !Number.isSafeInteger(Number(space)) || !/^p\d+$/.test(page)) throw Error('INVALID_CLI_ARGUMENTS');
    this.#space = Number(space); this.#page = page; this.#port = port; this.#launch = launch; this.#now = now;
  }
  get view() { return structuredClone(this.#view); }
  async start() {
    this.#desired = true;
    if (this.#relay?.stats().running) return;
    await this.#relay?.close();
    this.#relay = undefined;
    this.#retryAt = 0;
    this.#failures = 0;
    await this.#startCapture();
  }
  async #startCapture() {
    this.#startedAt = this.#now();
    this.#view = { ...idleRelay(true), enabled: true, status: 'starting', recoveryCount: this.#recoveries, nextRetryAt: null };
    try {
      this.#relay = await this.#launch({ space: this.#space, page: this.#page, port: this.#port, fps: 30, width: 1920, quality: 80 });
      await this.refresh();
    } catch (error) {
      await this.#failed((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'RELAY_PORT_IN_USE' : 'RELAY_START_FAILED');
    }
  }
  async #failed(errorCode: string) {
    await this.#relay?.close();
    this.#relay = undefined;
    this.#recoveries++;
    this.#retryAt = this.#now() + Math.min(60_000, 2000 * 2 ** Math.min(this.#failures++, 5));
    this.#view = { ...this.#view, enabled: this.#desired, status: this.#desired ? 'recovering' : 'stopped', fps: 0,
      recoveryCount: this.#recoveries, nextRetryAt: this.#desired ? new Date(this.#retryAt).toISOString() : null, errorCode };
  }
  async refresh() {
    if (!this.#desired) return;
    if (!this.#relay) {
      if (this.#now() >= this.#retryAt) await this.#startCapture();
      return;
    }
    const stats = this.#relay.stats(), address = this.#relay.address;
    if (!stats.running) { await this.#failed('RELAY_CAPTURE_FAILED'); return; }
    if (!stats.sequence && this.#now() - this.#startedAt >= 30_000 || (stats.frameAgeMs ?? 0) >= 45_000) {
      await this.#failed('RELAY_FRAME_TIMEOUT'); return;
    }
    if (stats.sequence) this.#failures = 0;
    this.#view = { available: true, enabled: true, status: stats.sequence ? 'live' : 'starting',
      obsUrl: `${address}/obs`, previewUrl: `${address}/stream.mjpeg`, fps: stats.fps,
      dimensions: stats.dimensions, errorCode: null, recoveryCount: this.#recoveries, nextRetryAt: null };
  }
  async stop() {
    this.#desired = false;
    this.#retryAt = 0;
    await this.#relay?.close();
    this.#relay = undefined;
    this.#view = { ...idleRelay(true), status: 'stopped' };
  }
  async close() { await this.stop(); }
}
