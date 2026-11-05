export interface Clock { wallTimeMs(): number; monotonicMs(): number }
export const systemClock: Clock = { wallTimeMs: () => Date.now(), monotonicMs: () => performance.now() };
export const isoNow = (clock: Clock) => new Date(clock.wallTimeMs()).toISOString();
export class ReplayClock implements Clock {
  #wall: number; #mono = 0;
  constructor(at: string) { this.#wall = Date.parse(at); if (!Number.isFinite(this.#wall)) throw new Error('INVALID_REPLAY_TIME'); }
  wallTimeMs() { return this.#wall; }
  monotonicMs() { return this.#mono; }
  advanceTo(at: string) {
    const next = Date.parse(at);
    if (!Number.isFinite(next) || next < this.#wall) throw new Error('REPLAY_TIME_REVERSED');
    this.#mono += next - this.#wall; this.#wall = next;
  }
  advanceBy(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('INVALID_TIME_ADVANCE');
    this.#wall += ms; this.#mono += ms;
  }
}
