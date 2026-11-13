import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AvatarOutput, validateAvatarParameters, type AvatarAck, type AvatarIdentity, type AvatarPlanner } from '../src/adapters/live/avatar-output.ts';
import { SpeechController, type SpeechContent, type SpeechPlaybackContext } from '../src/application/live/speech.ts';
import { defaultConfig } from '../src/application/live/config.ts';
import { deferred } from './helpers.ts';

const parameters = { ParamAngleX: { min: -30, max: 30, default: 0 }, ParamMouthOpenY: { min: 0, max: 1, default: 0 } };
const card = (text: string, priority: SpeechContent['priority'] = 'viewer'): SpeechContent => ({
  contentId: randomUUID(), handId: null, priority, text, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
});
async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail('avatar state did not settle');
}
async function harness(options: { planner?: AvatarPlanner; leaseMs?: number; startTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'maji-avatar-')), artifact = join(directory, 'audio.mp3');
  const bytes = Buffer.from('test audio bytes');
  await writeFile(artifact, bytes);
  let now = Date.now(), syntheses = 0, starts = 0;
  const released: string[] = [];
  const output = new AvatarOutput({ synthesize: async () => { syntheses++; return artifact; }, release: async file => { released.push(file); } },
    { ...options, now: () => now });
  const identity = () => {
    const lease = output.claim({ rendererId: 'renderer-1', parameters });
    return { rendererId: 'renderer-1', leaseId: lease.leaseId };
  };
  const context = (id = 'speech-1', playbackEpoch = 1): SpeechPlaybackContext => ({ speechId: id, playbackEpoch,
    text: '[开心]一起玩吧。[期待]会有好牌吗？', expiresAt: new Date(now + 30_000).toISOString(), onStarted: () => { starts++; } });
  const ack = (owner: AvatarIdentity, status: AvatarAck['status'], id = 'speech-1', epoch = 1) => output.ack({ ...owner,
    speechId: id, playbackEpoch: epoch, status, ...(status === 'ready' ? { durationSec: 2.5 } : {}) });
  return { output, artifact, bytes, identity, context, ack, released, get syntheses() { return syntheses; }, get starts() { return starts; },
    advance(ms: number) { now += ms; output.sweep(); }, async cleanup() { output.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('avatar refuses synthesis without a renderer and permits only one leased owner', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.output.speech.synthesize('你好', 'voice', new AbortController().signal), /AVATAR_RENDERER_UNAVAILABLE/);
    assert.equal(h.syntheses, 0);
    const owner = h.identity();
    assert.equal(h.identity().leaseId, owner.leaseId);
    assert.throws(() => h.output.claim({ rendererId: 'renderer-2', parameters }), /AVATAR_ALREADY_CLAIMED/);
    assert.throws(() => h.output.poll({ ...owner, rendererId: 'renderer-2' }), /AVATAR_LEASE_EXPIRED/);
    assert.throws(() => h.output.release({ ...owner, leaseId: 'wrong' }), /AVATAR_LEASE_EXPIRED/);
    h.output.release(owner);
    assert.notEqual(h.output.claim({ rendererId: 'renderer-2', parameters }).leaseId, owner.leaseId);
  } finally { await h.cleanup(); }
});

test('avatar validates actual model parameter bounds before granting ownership', () => {
  for (const invalid of [null, [], {}, { bad: { min: 1, max: -1, default: 0 } },
    { bad: { min: 0, max: 1, default: 2 } }, { bad: { min: 0, max: Infinity, default: 0 } },
    { bad: { min: 0, max: 1, default: 0, unrecognized: true } },
    { bad: Object.assign([], { min: 0, max: 1, default: 0 }) },
    JSON.parse('{"__proto__":{"min":0,"max":1,"default":0}}')])
    assert.throws(() => validateAvatarParameters(invalid), /INVALID_AVATAR_PARAMETERS/);
  assert.deepEqual({ ...validateAvatarParameters(parameters) }, parameters);
});

test('avatar scopes audio and plans from approved text and decoded duration before actual-start acknowledgement', async () => {
  const planned = deferred<{ parameterPlan: { time: number; duration: number; parameters: Record<string, number> }[]; provider: string }>();
  let request: Parameters<AvatarPlanner>[0] | undefined;
  const h = await harness({ planner: async input => { request = input; return planned.promise; } });
  const owner = h.identity(), abort = new AbortController();
  const playing = h.output.speech.play(h.artifact, abort.signal, h.context());
  try {
    const command = h.output.poll(owner).command!;
    assert.equal(command.phase, 'prepare');
    assert.equal(h.starts, 0);
    assert.equal(command.text, '一起玩吧。会有好牌吗？');
    assert.deepEqual(command.moods, ['开心', '期待']);
    const audioId = new URL(command.audioUrl, 'http://localhost').pathname.split('/').at(-1)!;
    assert.deepEqual(await h.output.audio(owner, audioId), h.bytes);
    await assert.rejects(h.output.audio({ ...owner, leaseId: 'obsolete' }, audioId), /AVATAR_LEASE_EXPIRED/);
    await assert.rejects(h.output.audio(owner, 'unknown'), /AVATAR_AUDIO_NOT_FOUND/);
    assert.throws(() => h.ack(owner, 'started'), /AVATAR_NOT_READY/);
    h.ack(owner, 'ready');
    assert.equal(request?.durationSec, 2.5);
    assert.equal(request?.text, h.context().text);
    assert.deepEqual({ ...request?.parameters }, parameters);
    assert.equal(h.output.poll(owner).command?.phase, 'prepare');
    planned.resolve({ provider: 'openai-compatible', parameterPlan: [{ time: 0, duration: 2, parameters: { ParamAngleX: 10 } }] });
    await eventually(() => h.output.status.phase === 'play');
    assert.equal(h.starts, 0);
    assert.throws(() => h.ack(owner, 'ended'), /AVATAR_NOT_STARTED/);
    h.ack(owner, 'started'); h.ack(owner, 'started');
    assert.equal(h.starts, 1);
    h.ack(owner, 'ended'); await playing;
    assert.equal(h.output.status.last?.outcome, 'completed');
    assert.equal(h.output.poll(owner).command, null);
    assert.throws(() => h.ack(owner, 'ended'), /AVATAR_PLAYBACK_EXPIRED/);
    await assert.rejects(h.output.audio(owner, audioId), /AVATAR_AUDIO_NOT_FOUND/);
  } finally { planned.resolve({ provider: 'vad-facs', parameterPlan: [] }); abort.abort(); h.output.close(); await playing.catch(() => {}); await h.cleanup(); }
});

test('avatar cancel during prepare aborts the planner and rejects its late result without issuing play', async () => {
  const planned = deferred<{ parameterPlan: []; provider: string }>();
  let planningSignal: AbortSignal | undefined;
  const h = await harness({ planner: async (_input, signal) => { planningSignal = signal; return planned.promise; } });
  const owner = h.identity(), abort = new AbortController();
  const playing = h.output.speech.play(h.artifact, abort.signal, h.context());
  const cancelled = assert.rejects(playing, /AVATAR_CANCELLED/);
  try {
    h.ack(owner, 'ready'); abort.abort(); await cancelled;
    assert.equal(planningSignal?.aborted, true);
    planned.resolve({ parameterPlan: [], provider: 'openai-compatible' });
    await delay(0);
    assert.equal(h.output.poll(owner).command, null);
    assert.equal(h.starts, 0);
  } finally { planned.resolve({ parameterPlan: [], provider: 'vad-facs' }); abort.abort(); await h.cleanup(); }
});

test('avatar cancellation after play dispatch waits for a stop acknowledgement and late ended cannot become success', async () => {
  const h = await harness(), owner = h.identity(), abort = new AbortController();
  const playing = h.output.speech.play(h.artifact, abort.signal, h.context());
  let settled = false;
  const cancelled = assert.rejects(playing, /AVATAR_CANCELLED/).then(() => { settled = true; });
  try {
    h.ack(owner, 'ready'); h.ack(owner, 'started'); abort.abort();
    assert.equal(h.output.poll(owner).command?.phase, 'stop');
    await delay(0); assert.equal(settled, false);
    h.ack(owner, 'ended'); await cancelled;
    assert.equal(h.output.status.last?.outcome, 'AVATAR_CANCELLED');
    assert.equal(h.output.poll(owner).command, null);
  } finally { h.output.close(); await cancelled; await h.cleanup(); }
});

test('avatar expires a silent owner, completes cancellation, and rejects old callbacks after a new claim', async () => {
  const h = await harness({ leaseMs: 1000 }), owner = h.identity(), abort = new AbortController();
  const playing = h.output.speech.play(h.artifact, abort.signal, h.context());
  const cancelled = assert.rejects(playing, /AVATAR_LEASE_EXPIRED/);
  try {
    h.ack(owner, 'ready'); h.ack(owner, 'started'); abort.abort();
    h.output.poll(owner); h.advance(1001); await cancelled;
    const next = h.output.claim({ rendererId: 'renderer-2', parameters });
    assert.notEqual(next.leaseId, owner.leaseId);
    assert.throws(() => h.ack(owner, 'ended'), /AVATAR_LEASE_EXPIRED/);
    assert.equal(h.output.poll({ rendererId: 'renderer-2', leaseId: next.leaseId }).command, null);
  } finally { h.output.close(); await cancelled; await h.cleanup(); }
});

test('speech controller keeps browser prepare pending and clear cancels it before actual audio starts', async () => {
  const h = await harness(), owner = h.identity();
  const speech = new SpeechController(h.output.speech, () => defaultConfig('voice'), () => {});
  try {
    speech.enqueue(card('[开心]一起玩吧。'));
    await eventually(() => h.output.status.phase === 'prepare');
    assert.equal(speech.view.playingSpeechId, null);
    assert.equal(speech.clearPending(), 1);
    await eventually(() => !speech.busy);
    assert.equal(speech.last?.outcome, 'cancelled');
    assert.equal(h.output.poll(owner).command, null);
    assert.deepEqual(h.released, [h.artifact]);
  } finally { h.output.close(); await speech.setMuted(true); await h.cleanup(); }
});

test('speech controller preserves started avatar audio on clear and waits for mute receipt before releasing it', async () => {
  const h = await harness(), owner = h.identity();
  const speech = new SpeechController(h.output.speech, () => defaultConfig('voice'), () => {});
  try {
    speech.enqueue(card('[开心]一起玩吧。'));
    await eventually(() => h.output.status.phase === 'prepare');
    const command = h.output.poll(owner).command!;
    h.ack(owner, 'ready', command.speechId, command.playbackEpoch);
    assert.equal(speech.view.playingSpeechId, null);
    h.ack(owner, 'started', command.speechId, command.playbackEpoch);
    assert.equal(speech.view.playingSpeechId, command.speechId);
    speech.enqueue(card('[期待]下一句再说吧。'));
    assert.equal(speech.clearPending(), 1);
    assert.equal(h.output.poll(owner).command?.phase, 'play');
    let muted = false;
    const muting = speech.setMuted(true).then(() => { muted = true; });
    await delay(0);
    assert.equal(muted, false);
    assert.deepEqual(h.released, []);
    assert.equal(h.output.poll(owner).command?.phase, 'stop');
    h.ack(owner, 'cancelled', command.speechId, command.playbackEpoch);
    await muting;
    assert.equal(speech.last?.outcome, 'cancelled');
    assert.deepEqual(h.released, [h.artifact]);
    assert.equal(speech.view.playingSpeechId, null);
  } finally { h.output.close(); await speech.setMuted(true); await h.cleanup(); }
});
