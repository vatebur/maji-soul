import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AvatarAudioPlayback, leaseDeadline, type AvatarCommand, type AvatarPlaybackStatus, type AvatarResetReason } from '../src/app/console/avatar-playback.ts';
import { deferred } from './helpers.ts';

const command = (id = 'speech-1', playbackEpoch = 1): AvatarCommand => ({ speechId: id, playbackEpoch,
  phase: 'prepare', audioUrl: '/api/avatar/audio/test', text: '[开心]一起玩吧。', moods: ['开心'], parameterPlan: [] });

function harness(options: { duration?: number; fetchAudio?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer> } = {}) {
  const statuses: AvatarPlaybackStatus[] = [], starts: { at: number; duration: number }[] = [], resets: number[] = [];
  const resetReasons: AvatarResetReason[] = [];
  const sources: { onended: (() => void) | null; startAt: number | null; stopAt: number | null; stopped: boolean; disconnected: boolean;
    buffer: unknown; connect: () => void; disconnect: () => void; start: (at: number) => void; stop: (at?: number) => void }[] = [];
  let fetches = 0;
  const context = {
    currentTime: 10, state: 'running', destination: {},
    createAnalyser: () => ({ fftSize: 1024, smoothingTimeConstant: 0, connect() {}, disconnect() {},
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.5) }),
    decodeAudioData: async () => ({ duration: options.duration ?? 2.5 }),
    createBufferSource() {
      const source = { onended: null as (() => void) | null, startAt: null as number | null, stopAt: null as number | null, stopped: false, disconnected: false,
        buffer: null as unknown, connect() {}, disconnect() { this.disconnected = true; },
        start(at: number) { this.startAt = at; }, stop(at?: number) {
          this.stopAt = at ?? context.currentTime;
          if (this.stopAt <= context.currentTime) { this.stopped = true; this.onended?.(); }
        } };
      sources.push(source); return source;
    },
    async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; },
  };
  const playback = new AvatarAudioPlayback({ context: context as unknown as AudioContext,
    onStart: (_command, at, duration) => starts.push({ at, duration }), onReset: (at, reason) => { resets.push(at); resetReasons.push(reason); },
    onStatus: (_command, status) => statuses.push(status),
    fetchAudio: async (url, signal) => { fetches++; return options.fetchAudio?.(url, signal) ?? new ArrayBuffer(8); } });
  return { playback, context, statuses, starts, resets, resetReasons, sources, get fetches() { return fetches; } };
}

test('avatar prepares once, starts on the running audio clock and never replays a completed command', async () => {
  const h = harness(), c = command();
  try {
    const preparation = h.playback.prepare(c);
    assert.equal(h.playback.prepare(c), preparation);
    assert.equal(await preparation, 2.5);
    assert.equal(h.fetches, 1);
    await h.playback.play({ ...c, phase: 'play' });
    await h.playback.play({ ...c, phase: 'play' });
    assert.equal(h.sources.length, 1);
    assert.equal(h.sources[0]!.startAt, 10);
    assert.deepEqual(h.starts, [{ at: 10, duration: 2.5 }]);
    await delay(25);
    assert.deepEqual(h.statuses, [], 'dispatch is not proof that audio has started');
    h.context.currentTime = 10.1;
    await delay(25);
    assert.deepEqual(h.statuses, ['started']);
    h.playback.sample();
    assert.equal(h.playback.audioLevelAnalyzer.getLevel(), 0.5);
    assert.equal(h.playback.audioLevelAnalyzer.getPeak(), 0.5);
    h.context.currentTime = 12.5;
    h.sources[0]!.onended!();
    assert.deepEqual(h.statuses, ['started', 'ended']);
    assert.equal(h.playback.playing, false);
    assert.equal(h.playback.audioLevelAnalyzer.getLevel(), 0);
    assert.equal(h.resets.at(-1), 12.5);
    assert.deepEqual(h.resetReasons, ['ended']);
    assert.equal(h.sources[0]!.disconnected, true);
    await h.playback.play(c);
    await assert.rejects(h.playback.prepare(c), /AVATAR_ALREADY_FINISHED/);
    assert.equal(h.sources.length, 1);
  } finally { h.playback.close(); }
});

test('avatar stop closes audio and mouth and cannot turn a late ended event into success', async () => {
  const h = harness(), c = command();
  try {
    await h.playback.prepare(c); await h.playback.play(c);
    const lateEnded = h.sources[0]!.onended!;
    h.playback.sample();
    h.playback.stop();
    lateEnded();
    assert.deepEqual(h.statuses, ['cancelled']);
    assert.equal(h.sources[0]!.stopped, true);
    assert.equal(h.playback.audioLevelAnalyzer.getLevel(), 0);
    assert.equal(h.playback.audioLevelAnalyzer.isAvailable(), false);
    assert.deepEqual(h.resetReasons, ['cancelled']);
    assert.equal(h.playback.hasFinished(c), true);
    await h.playback.play(c);
    assert.equal(h.sources.length, 1);
  } finally { h.playback.close(); }
});

test('avatar cancellation rejects audio arriving after its playback revision was revoked', async () => {
  const audio = deferred<ArrayBuffer>();
  let fetchSignal: AbortSignal | undefined;
  const h = harness({ fetchAudio: async (_url, signal) => { fetchSignal = signal; return audio.promise; } });
  try {
    const prepared = h.playback.prepare(command());
    h.playback.stop();
    assert.equal(fetchSignal?.aborted, true);
    audio.resolve(new ArrayBuffer(8));
    await assert.rejects(prepared, /AVATAR_PREPARE_CANCELLED/);
    assert.equal(h.playback.key, null);
    assert.equal(h.sources.length, 0);
    assert.deepEqual(h.statuses, []);
  } finally { audio.resolve(new ArrayBuffer(8)); h.playback.close(); }
});

test('avatar does not report ready for invalid or unbounded audio', async t => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 121]) await t.test(String(duration), async () => {
    const h = harness({ duration });
    try {
      await assert.rejects(h.playback.prepare(command()), /AVATAR_INVALID_AUDIO/);
      assert.equal(h.sources.length, 0);
      assert.equal(h.playback.key, null);
    } finally { h.playback.close(); }
  });
});

test('avatar lease watchdog uses a conservative monotonic deadline including slow round trips', () => {
  const lease = { leaseMs: 4000, serverNow: 1_000_000, expiresAt: 1_004_000 };
  assert.equal(leaseDeadline(lease, 100, 350), 4100);
  assert.equal(leaseDeadline({ ...lease, expiresAt: 1_002_000 }, 100, 350), 2100);
  assert.equal(leaseDeadline(lease, 100, 5100), 5100, 'already expired replies cannot extend playback');
  assert.equal(leaseDeadline({ ...lease, expiresAt: 2_000_000 }, 100, 350), 4100, 'server expiry cannot exceed the granted TTL');
});

test('avatar schedules lease expiry on the audio thread and treats a late native cutoff event as cancellation', async t => {
  let monotonic = 1000;
  t.mock.method(performance, 'now', () => monotonic);
  const h = harness({ duration: 20 }), c = command();
  try {
    h.playback.setLeaseDeadline(monotonic + 4000);
    await h.playback.prepare(c); await h.playback.play(c);
    assert.equal(h.sources[0]!.stopAt, 14);
    assert.equal(h.sources[0]!.stopped, false, 'scheduling a future cutoff does not stop current audio');
    // The browser audio thread stops at 14 while JS is frozen; JS handles ended after the full buffer would end.
    monotonic = 40_000; h.context.currentTime = 49;
    h.sources[0]!.onended!();
    assert.deepEqual(h.statuses, ['started', 'cancelled']);
    assert.deepEqual(h.resetReasons, ['cancelled']);
    assert.equal(h.playback.playing, false);
    assert.equal(h.playback.audioLevelAnalyzer.getLevel(), 0);
    assert.equal(h.playback.hasFinished(c), true);
  } finally { h.playback.close(); }
});

test('preparing and cancelling unplayed audio leaves the continuous idle animation alone', async () => {
  const h = harness();
  try {
    h.playback.stop();
    await h.playback.prepare(command());
    h.playback.stop();
    assert.deepEqual(h.resets, []);
    assert.deepEqual(h.statuses, ['cancelled']);
    await h.playback.prepare(command('next'));
    await h.playback.play(command('next'));
    h.playback.stop('failed');
    assert.deepEqual(h.resetReasons, ['failed']);
  } finally { h.playback.close(); }
});

test('avatar lease renewal replaces a previous native cutoff and preserves natural completion', async t => {
  let monotonic = 1000;
  t.mock.method(performance, 'now', () => monotonic);
  const h = harness({ duration: 5 }), c = command();
  try {
    h.playback.setLeaseDeadline(5000);
    await h.playback.prepare(c); await h.playback.play(c);
    assert.equal(h.sources[0]!.stopAt, 14);
    monotonic = 2500; h.context.currentTime = 11.5;
    h.playback.setLeaseDeadline(6500);
    assert.equal(h.sources[0]!.stopAt, 15.5);
    assert.equal(h.sources[0]!.stopped, false);
    h.context.currentTime = 15;
    h.sources[0]!.onended!();
    assert.deepEqual(h.statuses, ['started', 'ended']);
  } finally { h.playback.close(); }
});
