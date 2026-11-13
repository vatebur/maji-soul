/** The audio and animation clocks share one AudioContext, including cancellation. */
export interface AvatarCommand {
  speechId: string;
  playbackEpoch: number;
  phase: 'prepare' | 'play' | 'stop';
  audioUrl: string;
  text: string;
  moods: string[];
  parameterPlan: Array<{ time: number; duration: number; parameters: Record<string, number>; label?: string }>;
  durationSec?: number;
}
export type AvatarPlaybackStatus = 'started' | 'ended' | 'cancelled' | 'failed';
export type AvatarResetReason = Exclude<AvatarPlaybackStatus, 'started'>;
export const commandKey = (command: Pick<AvatarCommand, 'speechId' | 'playbackEpoch'>) => `${command.speechId}:${command.playbackEpoch}`;

export class AvatarAudioPlayback {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  #samples: Float32Array<ArrayBuffer>;
  #prepared: { key: string; command: AvatarCommand; buffer: AudioBuffer } | null = null;
  #active: { key: string; command: AvatarCommand; source: AudioBufferSourceNode; started: boolean;
    startTime: number; naturalEndTime: number; cutoffTime: number } | null = null;
  #pending: { key: string; controller: AbortController; promise: Promise<number> } | null = null;
  #revision = 0;
  #leaseDeadline = Infinity;
  #finished = new Set<string>();
  #level = 0;
  #peak = 0;
  #onStart: (command: AvatarCommand, time: number, duration: number) => void;
  #onReset: (time: number, reason: AvatarResetReason) => void;
  #onStatus: (command: AvatarCommand, status: AvatarPlaybackStatus) => void;
  #fetchAudio: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;

  constructor(options: {
    context: AudioContext;
    onStart: (command: AvatarCommand, time: number, duration: number) => void;
    onReset: (time: number, reason: AvatarResetReason) => void;
    onStatus: (command: AvatarCommand, status: AvatarPlaybackStatus) => void;
    fetchAudio: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  }) {
    this.context = options.context;
    this.#onStart = options.onStart;
    this.#onReset = options.onReset;
    this.#onStatus = options.onStatus;
    this.#fetchAudio = options.fetchAudio;
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.#samples = new Float32Array(this.analyser.fftSize);
    this.analyser.connect(this.context.destination);
  }
  get key() { return this.#active?.key ?? this.#prepared?.key ?? this.#pending?.key ?? null; }
  get playing() { return this.#active !== null; }
  get finishedKeyCount() { return this.#finished.size; }
  hasFinished(command: AvatarCommand) { return this.#finished.has(commandKey(command)); }
  get audioLevelAnalyzer() {
    return {
      getLevel: () => this.#level,
      getPeak: () => this.#peak,
      isAvailable: () => this.#active !== null && this.context.state === 'running',
      reset: () => { this.#level = this.#peak = 0; },
    };
  }
  setLeaseDeadline(deadline: number) {
    this.#leaseDeadline = deadline;
    this.#scheduleAudioCutoff();
  }
  #scheduleAudioCutoff() {
    if (!this.#active || !Number.isFinite(this.#leaseDeadline)) return;
    const remaining = Math.max(0, (this.#leaseDeadline - performance.now()) / 1000);
    // WebAudio enforces this even while JavaScript timers/RAF are suspended.
    this.#active.cutoffTime = this.context.currentTime + remaining;
    this.#active.source.stop(this.#active.cutoffTime);
  }
  sample() {
    if (!this.#active || this.context.state !== 'running') { this.#level = this.#peak = 0; return; }
    this.analyser.getFloatTimeDomainData(this.#samples);
    let square = 0, peak = 0;
    for (const value of this.#samples) { square += value * value; peak = Math.max(peak, Math.abs(value)); }
    this.#level = Math.min(1, Math.sqrt(square / this.#samples.length));
    this.#peak = Math.min(1, peak);
  }
  prepare(command: AvatarCommand): Promise<number> {
    const key = commandKey(command);
    if (this.#finished.has(key)) return Promise.reject(Error('AVATAR_ALREADY_FINISHED'));
    if (this.#prepared?.key === key) return Promise.resolve(this.#prepared.buffer.duration);
    if (this.#pending?.key === key) return this.#pending.promise;
    this.stop();
    const revision = ++this.#revision, controller = new AbortController();
    const promise = this.#fetchAudio(command.audioUrl, controller.signal)
      .then(bytes => this.context.decodeAudioData(bytes))
      .then(buffer => {
        if (revision !== this.#revision || controller.signal.aborted) throw Error('AVATAR_PREPARE_CANCELLED');
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 120) throw Error('AVATAR_INVALID_AUDIO');
        this.#prepared = { key, command, buffer };
        return buffer.duration;
      }).finally(() => { if (this.#pending?.key === key) this.#pending = null; });
    this.#pending = { key, controller, promise };
    return promise;
  }
  async play(command: AvatarCommand) {
    const key = commandKey(command);
    if (this.#finished.has(key) || this.#active?.key === key) return;
    if (this.#prepared?.key !== key) throw Error('AVATAR_AUDIO_NOT_PREPARED');
    const revision = this.#revision;
    if (this.context.state !== 'running') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.context.resume(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('AVATAR_AUDIO_BLOCKED')), 1200); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    if (revision !== this.#revision || this.#prepared?.key !== key) return;
    if (this.context.state !== 'running') throw Error('AVATAR_AUDIO_BLOCKED');
    const buffer = this.#prepared.buffer, source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const when = this.context.currentTime;
    const active = { key, command, source, started: false, startTime: when, naturalEndTime: when + buffer.duration, cutoffTime: Infinity };
    this.#active = active;
    const started = () => {
      if (this.#active !== active || active.started) return;
      active.started = true;
      this.#onStatus(command, 'started');
    };
    source.onended = () => {
      if (this.#active !== active) return;
      if (Math.min(this.context.currentTime, active.cutoffTime) > active.startTime) started();
      this.#active = this.#prepared = null;
      source.disconnect();
      this.#markFinished(key);
      this.#level = this.#peak = 0;
      // The event callback can run long after a native cutoff while JS is suspended.
      const outcome = active.cutoffTime + 0.02 < active.naturalEndTime ? 'cancelled' : 'ended';
      this.#onReset(this.context.currentTime, outcome);
      this.#onStatus(command, outcome);
    };
    source.start(when);
    this.#scheduleAudioCutoff();
    this.#onStart(command, when, buffer.duration);
    // Report started only after the running audio clock has advanced past start.
    const observeStart = () => {
      if (this.#active !== active) return;
      if (this.context.state !== 'running') { this.stop('failed'); return; }
      if (this.context.currentTime > when) started();
      else setTimeout(observeStart, 10);
    };
    setTimeout(observeStart, 10);
  }
  stop(status: 'cancelled' | 'failed' = 'cancelled') {
    this.#revision++;
    this.#pending?.controller.abort();
    const current = this.#active, command = current?.command ?? this.#prepared?.command;
    this.#pending = this.#active = this.#prepared = null;
    if (current) { current.source.onended = null; current.source.stop(); current.source.disconnect(); }
    this.#level = this.#peak = 0;
    if (current) this.#onReset(this.context.currentTime, status);
    if (command) { this.#markFinished(commandKey(command)); this.#onStatus(command, status); }
    return command !== undefined;
  }
  #markFinished(key: string) {
    this.#finished.add(key);
    if (this.#finished.size > 128) this.#finished.delete(this.#finished.values().next().value!);
  }
  close() { this.stop(); this.analyser.disconnect(); void this.context.close(); }
}

/** Lease deadlines use monotonic time and subtract the full request round trip. */
export function leaseDeadline(response: { leaseMs: number; serverNow: number; expiresAt: number }, sent: number, received: number) {
  const remaining = Math.min(response.leaseMs, response.expiresAt - response.serverNow) - Math.max(0, received - sent);
  return received + Math.max(0, remaining);
}
