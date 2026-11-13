import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { ConsoleRuntime } from '../src/app/console/runtime.ts';
import { HealthAnnouncements } from '../src/app/console/health-announcements.ts';
import { idleRelay, LiveRelay, type RelayPort } from '../src/app/console/relay.ts';
import type { AutomationPort, AutomationView } from '../src/app/console/automation.ts';
import { defaultConfig } from '../src/application/live/config.ts';
import { SpeechController, type SpeechContent } from '../src/application/live/speech.ts';
import { deferred } from './helpers.ts';

const command = () => ({ commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: null });
const automationView = (): AutomationView => ({ available: true, enabled: true, status: 'recovering', completedMatches: 0,
  sessionId: null, recoveryCount: 1, lastErrorCode: 'COUNTDOWN_EXPIRED', lastErrorAt: new Date(1000).toISOString() });

test('health notices deduplicate incidents, throttle retries, and describe manual intervention accurately', () => {
  const health = new HealthAnnouncements(), view = automationView();
  const first = health.observe(view, undefined, null, 1000);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.priority, 'system');
  assert.match(first[0]!.text, /正在重建房间/);
  assert.deepEqual(health.observe(view, undefined, null, 2000), []);
  view.recoveryCount = 2;
  view.lastErrorAt = new Date(2000).toISOString();
  assert.deepEqual(health.observe(view, undefined, null, 2000), []);
  view.status = 'playing';
  const recovered = health.observe(view, undefined, null, 61_000);
  assert.equal(recovered.length, 1);
  assert.match(recovered[0]!.text, /已自动恢复/);
  assert.deepEqual(health.observe(view, undefined, null, 121_000), []);
  view.enabled = false; view.status = 'faulted'; view.lastErrorCode = 'LOGIN_REQUIRED';
  const manual = health.observe(view, undefined, null, 122_000);
  assert.equal(manual.length, 1);
  assert.match(manual[0]!.text, /人工处理/);
  assert.doesNotMatch(manual[0]!.text, /正在重建/);
});

test('legacy limits are removed persistently and cannot be configured again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-health-config-'));
  const store = new StorageClient(join(directory, 'state.sqlite'));
  let runtime: ConsoleRuntime | undefined;
  try {
    const config = defaultConfig('test');
    await store.saveConsole(0, { config: { ...config, run: { ...config.run, maxMatches: 1, maxDurationMs: 60_000 } },
      configRevision: 7, run: null }, null);
    runtime = await ConsoleRuntime.open({ store, source: { kind: 'follow', sessionId: 'idle' }, voiceId: 'test', voices: [] });
    assert.deepEqual(runtime.config.run, { defaultMode: 'engine' });
    assert.equal(runtime.configRevision, 8);
    const saved = (await store.readConsole()).body as { config: ReturnType<typeof defaultConfig> };
    assert.deepEqual(saved.config.run, { defaultMode: 'engine' });
    await assert.rejects(runtime.command('config.patch', { ...command(), expectedRevision: 8,
      changes: { run: { maxMatches: 1 } } }), /VALIDATION_FAILED/);
  } finally { await runtime?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('clean relay starts automatically once and an explicit stop survives console restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-health-relay-'));
  const store = new StorageClient(join(directory, 'state.sqlite'));
  let starts = 0, runtime: ConsoleRuntime | undefined;
  const relay: RelayPort = { view: idleRelay(true),
    async start() { starts++; Object.assign(this.view, { enabled: true, status: 'live' }); },
    async stop() { Object.assign(this.view, { enabled: false, status: 'stopped' }); },
    async refresh() {}, async close() { await this.stop(); } };
  const open = () => ConsoleRuntime.open({ store, source: { kind: 'follow', sessionId: 'idle' }, voiceId: 'test', voices: [], relay });
  try {
    runtime = await open();
    await runtime.tick(); await runtime.tick();
    assert.equal(starts, 1);
    assert.equal(relay.view.enabled, true);
    await runtime.command('relay.set', { ...command(), enabled: false });
    await runtime.tick();
    assert.equal(starts, 1);
    await runtime.close(); runtime = await open();
    await runtime.tick();
    assert.equal(starts, 1);
    assert.equal(relay.view.enabled, false);
    await runtime.command('relay.set', { ...command(), enabled: true });
    assert.equal(starts, 2);
  } finally { await runtime?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('relay detects missing frames, retries with backoff and cancels retries on manual stop', async () => {
  let now = 0, starts = 0, closes = 0;
  const relay = new LiveRelay('0', 'p1', 17362, async () => {
    starts++;
    return { address: 'http://127.0.0.1:17362', token: 'private', close: async () => { closes++; },
      stats: () => ({ space: 0, page: 'p1', sequence: 0, bytes: 0, fps: 0, frameAgeMs: null,
        dimensions: null, clients: 0, workerExit: null, running: true }) };
  }, () => now);
  try {
    await relay.start();
    now = 30_000; await relay.refresh();
    assert.equal(relay.view.errorCode, 'RELAY_FRAME_TIMEOUT');
    assert.equal(relay.view.status, 'recovering');
    assert.equal(closes, 1);
    now = 31_999; await relay.refresh(); assert.equal(starts, 1);
    now = 32_000; await relay.refresh(); assert.equal(starts, 2);
    now = 62_000; await relay.refresh();
    assert.equal(relay.view.nextRetryAt, new Date(66_000).toISOString());
    await relay.stop(); now = 100_000; await relay.refresh();
    assert.equal(starts, 2);
    assert.equal(relay.view.enabled, false);
  } finally { await relay.close(); }
});

test('system notices preempt narration playback and still respect manual mute', async () => {
  const playing = deferred(), heard = deferred(), played: string[] = [];
  const config = defaultConfig('test');
  const speech = new SpeechController({ synthesize: async text => text,
    play: async (artifact, signal) => {
      played.push(artifact);
      if (played.length === 1) { playing.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
      else heard.resolve();
    }, release: async () => {},
  }, () => config, () => {});
  const card = (priority: SpeechContent['priority'], text: string): SpeechContent => ({ contentId: randomUUID(), handId: null,
    priority, text, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  try {
    speech.enqueue(card('discard', '先打这一张。')); await playing.promise;
    speech.enqueue(card('recruitment', '欢迎一起玩。'));
    speech.enqueue(card('system', '出牌异常，正在恢复。'));
    await heard.promise;
    assert.equal(played.length, 2);
    assert.match(played[1]!, /出牌异常/);
    await speech.setMuted(true);
    speech.enqueue(card('system', '又出现异常。'));
    await delay(10);
    assert.equal(played.length, 2);
  } finally { await speech.setMuted(true); }
});

test('runtime speaks a recovery notice without any model and avoids duplicate speech on polling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-health-voice-'));
  const store = new StorageClient(join(directory, 'state.sqlite'));
  const automation: AutomationPort = { view: automationView(), async start() {}, async stop() {}, async refresh() {}, async close() {} };
  const played: string[] = [], heard = deferred();
  const runtime = await ConsoleRuntime.open({ store, source: { kind: 'follow', sessionId: 'idle' }, voiceId: 'test', voices: [], automation,
    speech: { synthesize: async text => text, play: async text => { played.push(text); heard.resolve(); }, release: async () => {} } });
  try {
    await runtime.tick(); await heard.promise;
    await runtime.tick(); await runtime.tick();
    assert.equal(played.length, 1);
    assert.match(played[0]!, /自动出牌遇到异常/);
    assert.match(runtime.projections.obs.subtitle!.text, /正在重建房间/);
    assert.equal(runtime.speech.view.muted, false);
  } finally { await runtime.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
