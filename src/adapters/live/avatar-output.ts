import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SpeechPlaybackContext, SpeechPort } from '../../application/live/speech.ts';
import { SPOKEN_MOODS } from '../../application/live/spoken-text.ts';

export type AvatarParameters = Record<string, { min: number; max: number; default: number; name?: string }>;
export type AvatarFrame = { time: number; duration: number; label?: string; parameters: Record<string, number> };
export type AvatarPlanner = (input: { text: string; moods: readonly string[]; durationSec: number; parameters: AvatarParameters;
  characterName: string; characterProfile: string }, signal: AbortSignal) => Promise<{ parameterPlan: AvatarFrame[]; provider: string }>;
export interface AvatarIdentity { rendererId: string; leaseId: string }
export interface AvatarAck extends AvatarIdentity {
  speechId: string;
  playbackEpoch: number;
  status: 'ready' | 'started' | 'ended' | 'cancelled' | 'failed';
  durationSec?: number;
}
export interface AvatarCommand {
  speechId: string;
  playbackEpoch: number;
  phase: 'prepare' | 'play' | 'stop';
  audioUrl: string;
  text: string;
  moods: string[];
  parameterPlan: AvatarFrame[];
  durationSec?: number;
}
type Lease = AvatarIdentity & { expiresAt: number; parameters: AvatarParameters };
type Playback = {
  context: SpeechPlaybackContext; command: AvatarCommand; artifact: string; audioId: string;
  leaseId: string; started: boolean; planning: boolean; stopReason: string | null;
  resolve(): void; reject(error: Error): void; clean(): void; controller: AbortController;
  deadline: number;
};

export class AvatarError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = 'AvatarError'; this.status = status; this.code = code; }
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
export function validateAvatarParameters(value: unknown): AvatarParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AvatarError(422, 'INVALID_AVATAR_PARAMETERS');
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 1024) throw new AvatarError(422, 'INVALID_AVATAR_PARAMETERS');
  const result: AvatarParameters = Object.create(null);
  for (const [id, parameter] of entries) {
    if (id.length < 1 || id.length > 128 || /[\x00-\x1f]/.test(id) || ['__proto__','constructor','prototype'].includes(id) ||
      !parameter || typeof parameter !== 'object' || Array.isArray(parameter)) throw new AvatarError(422, 'INVALID_AVATAR_PARAMETERS');
    const p = parameter as Record<string, unknown>;
    if (Object.keys(p).some(key => !['min','max','default','name'].includes(key)) ||
      typeof p.min !== 'number' || typeof p.max !== 'number' || typeof p.default !== 'number' ||
      ![p.min,p.max,p.default].every(Number.isFinite) || p.min > p.max || p.default < p.min || p.default > p.max ||
      Math.max(Math.abs(p.min), Math.abs(p.max)) > 1_000_000 ||
      p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 256)) throw new AvatarError(422, 'INVALID_AVATAR_PARAMETERS');
    result[id] = { min: p.min, max: p.max, default: p.default, ...(typeof p.name === 'string' ? { name: p.name } : {}) };
  }
  return result;
}

/** A single leased browser owns playback. Polls carry current state, never a replay queue. */
export class AvatarOutput {
  readonly speech: SpeechPort;
  #lease: Lease | null = null;
  #playback: Playback | null = null;
  #closed = false;
  #timer: NodeJS.Timeout;
  #now: () => number;
  #leaseMs: number;
  #startTimeoutMs: number;
  #planTimeoutMs: number;
  #planner: AvatarPlanner | undefined;
  #name: string;
  #profile: string;
  #last: { speechId: string; outcome: string; provider?: string } | null = null;

  constructor(synthesis: Pick<SpeechPort, 'synthesize' | 'release'>, options: {
    planner?: AvatarPlanner; characterName?: string; characterProfile?: string;
    now?: () => number; leaseMs?: number; startTimeoutMs?: number; planTimeoutMs?: number;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 4000;
    this.#startTimeoutMs = options.startTimeoutMs ?? 12_000;
    this.#planTimeoutMs = options.planTimeoutMs ?? 4500;
    this.#planner = options.planner;
    this.#name = options.characterName ?? '雀魂主播';
    this.#profile = options.characterProfile ?? '中文麻将直播解说，动作自然克制，按口播的心情表达。';
    this.#timer = setInterval(() => this.sweep(), 100).unref();
    this.speech = {
      reportsStarted: true,
      synthesize: async (text, voiceId, signal) => {
        this.sweep();
        if (!this.#lease || this.#closed) throw new AvatarError(503, 'AVATAR_RENDERER_UNAVAILABLE');
        return synthesis.synthesize(text, voiceId, signal);
      },
      play: (artifact, signal, context) => this.#play(artifact, signal, context),
      release: artifact => synthesis.release(artifact),
    };
  }
  get status() {
    this.sweep();
    return { connected: this.#lease !== null, plannerAvailable: !!this.#planner,
      phase: this.#playback?.command.phase ?? 'idle', speaking: this.#playback?.started ?? false, last: this.#last };
  }
  #leaseView(lease: Lease) {
    return { leaseId: lease.leaseId, leaseMs: this.#leaseMs, serverNow: this.#now(), expiresAt: lease.expiresAt };
  }
  claim(input: { rendererId: string; parameters: unknown }) {
    this.sweep();
    if (this.#closed) throw new AvatarError(503, 'AVATAR_CLOSED');
    if (!validId(input.rendererId)) throw new AvatarError(422, 'INVALID_RENDERER_ID');
    if (this.#lease) {
      if (this.#lease.rendererId === input.rendererId) return this.#leaseView(this.#lease);
      throw new AvatarError(409, 'AVATAR_ALREADY_CLAIMED');
    }
    const parameters = validateAvatarParameters(input.parameters);
    this.#lease = { rendererId: input.rendererId, leaseId: randomUUID(), expiresAt: this.#now() + this.#leaseMs, parameters };
    return this.#leaseView(this.#lease);
  }
  #identity(input: AvatarIdentity) {
    this.sweep();
    if (!this.#lease || this.#lease.leaseId !== input.leaseId || this.#lease.rendererId !== input.rendererId)
      throw new AvatarError(409, 'AVATAR_LEASE_EXPIRED');
    return this.#lease;
  }
  poll(input: AvatarIdentity) {
    const lease = this.#identity(input);
    lease.expiresAt = this.#playback?.command.phase === 'stop' ?
      Math.min(this.#now() + this.#leaseMs, this.#playback.deadline) : this.#now() + this.#leaseMs;
    return { ...this.#leaseView(lease), command: this.#playback?.command ?? null };
  }
  release(input: AvatarIdentity) {
    this.#identity(input);
    this.#finish('AVATAR_RELEASED');
    this.#lease = null;
    return { ok: true };
  }
  ack(input: AvatarAck) {
    const lease = this.#identity(input), work = this.#playback;
    if (!work || work.leaseId !== lease.leaseId || input.speechId !== work.command.speechId || input.playbackEpoch !== work.command.playbackEpoch)
      throw new AvatarError(409, 'AVATAR_PLAYBACK_EXPIRED');
    if (input.status === 'ready') {
      if (work.command.phase !== 'prepare') return { ok: true };
      if (!Number.isFinite(input.durationSec) || input.durationSec! <= 0 || input.durationSec! > 120)
        throw new AvatarError(422, 'INVALID_AUDIO_DURATION');
      if (!work.planning) {
        work.planning = true;
        work.command.durationSec = input.durationSec!;
        void this.#plan(work, lease.parameters, input.durationSec!);
      }
    } else if (input.status === 'started') {
      if (work.command.phase === 'prepare') throw new AvatarError(409, 'AVATAR_NOT_READY');
      if (work.command.phase === 'play' && !work.started) {
        work.started = true;
        work.deadline = this.#now() + ((work.command.durationSec ?? 60) + 10) * 1000;
        work.context.onStarted();
      }
    } else if (input.status === 'ended') {
      if (work.command.phase === 'stop') this.#finish(work.stopReason ?? 'AVATAR_CANCELLED');
      else if (!work.started) throw new AvatarError(409, 'AVATAR_NOT_STARTED');
      else this.#finish();
    } else if (input.status === 'cancelled' || input.status === 'failed') {
      this.#finish(work.stopReason ?? (input.status === 'cancelled' ? 'AVATAR_CANCELLED' : 'AVATAR_PLAYBACK_FAILED'));
    } else throw new AvatarError(422, 'INVALID_AVATAR_ACK');
    return { ok: true };
  }
  async #plan(work: Playback, parameters: AvatarParameters, durationSec: number) {
    let provider = 'vad-facs';
    const deadline = AbortSignal.timeout(Math.min(this.#planTimeoutMs, Math.max(1, work.deadline - this.#now())));
    const signal = AbortSignal.any([work.controller.signal, deadline]);
    try {
      if (this.#planner) {
        // Even an uncooperative provider cannot keep an utterance in prepare forever.
        const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Error('AVATAR_PLAN_TIMEOUT')), { once: true }));
        const result = await Promise.race([this.#planner({ text: work.context.text, moods: work.command.moods, durationSec,
          parameters, characterName: this.#name, characterProfile: this.#profile }, signal), aborted]);
        if (this.#playback !== work || work.command.phase !== 'prepare' || work.controller.signal.aborted) return;
        work.command.parameterPlan = result.parameterPlan;
        provider = result.provider;
      }
    } catch { /* Local expression, idle and audio lip sync remain available. */ }
    if (this.#playback !== work || work.command.phase !== 'prepare' || work.controller.signal.aborted) return;
    if (this.#now() >= work.deadline) { this.#stop('AVATAR_START_TIMEOUT'); return; }
    work.command.phase = 'play';
    this.#last = { speechId: work.command.speechId, outcome: 'prepared', provider };
  }
  #play(artifact: string, signal: AbortSignal, context?: SpeechPlaybackContext): Promise<void> {
    this.sweep();
    signal.throwIfAborted();
    if (!context) return Promise.reject(new AvatarError(422, 'AVATAR_CONTEXT_REQUIRED'));
    if (!this.#lease || this.#closed) return Promise.reject(new AvatarError(503, 'AVATAR_RENDERER_UNAVAILABLE'));
    if (this.#playback) return Promise.reject(new AvatarError(409, 'AVATAR_BUSY'));
    const audioId = randomUUID(), lease = this.#lease;
    return new Promise<void>((resolve, reject) => {
      const abort = () => this.#stop('AVATAR_CANCELLED');
      const moods = [...context.text.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]!).filter(m => SPOKEN_MOODS.some(known => known === m));
      this.#playback = { context, artifact, audioId, leaseId: lease.leaseId, started: false, planning: false, stopReason: null,
        deadline: Math.min(this.#now() + this.#startTimeoutMs, Date.parse(context.expiresAt)), controller: new AbortController(),
        resolve, reject, clean: () => signal.removeEventListener('abort', abort),
        command: { speechId: context.speechId, playbackEpoch: context.playbackEpoch, phase: 'prepare',
          audioUrl: `/api/avatar/audio/${audioId}?rendererId=${encodeURIComponent(lease.rendererId)}&leaseId=${lease.leaseId}`,
          text: context.text.replace(/\[[^\]]*\]/g, ''), moods, parameterPlan: [] } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async audio(input: AvatarIdentity, id: string) {
    const lease = this.#identity(input), work = this.#playback;
    if (!work || work.audioId !== id || work.leaseId !== lease.leaseId || work.command.phase === 'stop') throw new AvatarError(404, 'AVATAR_AUDIO_NOT_FOUND');
    const bytes = await readFile(work.artifact);
    if (bytes.byteLength > 8 * 1024 * 1024) throw new AvatarError(413, 'AVATAR_AUDIO_TOO_LARGE');
    this.#identity(input);
    if (this.#playback !== work || work.controller.signal.aborted) throw new AvatarError(404, 'AVATAR_AUDIO_NOT_FOUND');
    return bytes;
  }
  #stop(reason: string) {
    const work = this.#playback;
    if (!work || work.command.phase === 'stop') return;
    work.controller.abort();
    work.stopReason = reason;
    // prepare cannot emit audio; once play is dispatched wait for a stop receipt or the watchdog lease.
    if (work.command.phase === 'prepare') { this.#finish(reason); return; }
    work.command.phase = 'stop';
    work.deadline = this.#now() + this.#leaseMs;
  }
  #finish(error?: string) {
    const work = this.#playback;
    if (!work) return;
    this.#playback = null;
    work.controller.abort(); work.clean();
    this.#last = { speechId: work.command.speechId, outcome: error ?? 'completed',
      ...(this.#last?.speechId === work.command.speechId && this.#last.provider ? { provider: this.#last.provider } : {}) };
    if (error) work.reject(new AvatarError(503, error)); else work.resolve();
  }
  sweep() {
    if (this.#lease && this.#now() >= this.#lease.expiresAt) {
      this.#finish('AVATAR_LEASE_EXPIRED'); this.#lease = null;
    }
    const work = this.#playback;
    if (work && this.#now() >= work.deadline) {
      if (work.command.phase === 'stop') {
        // Revoke the owner as well: it must observe expiry before another renderer can claim.
        // The deadline follows the final stop poll, so never outlive the last renewed lease.
        if (!this.#lease || this.#now() >= this.#lease.expiresAt) this.#finish(work.stopReason ?? 'AVATAR_CANCELLED');
      } else this.#stop(work.started ? 'AVATAR_END_TIMEOUT' : 'AVATAR_START_TIMEOUT');
    }
  }
  close() {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#finish('AVATAR_CLOSED'); this.#lease = null;
  }
}
