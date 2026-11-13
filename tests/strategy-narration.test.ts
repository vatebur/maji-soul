import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { StrategyNarrator } from '../src/application/live/strategy-narration.ts';
import { defaultConfig } from '../src/application/live/config.ts';
import type { StrategyRequest } from '../src/application/live/strategy-narration.ts';
import type { SpeechContent } from '../src/application/live/speech.ts';
import type { GameState } from '../src/domain/game/types.ts';
import { actorHarness, deferred } from './helpers.ts';

const card = (): SpeechContent => ({ contentId: 'summary', handId: 'hand', text: '逐动作事实', priority: 'discard',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20_000).toISOString() });
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail('narration did not complete');
}

test('strategy narration coalesces observations, throttles requests, and suppresses duplicate summaries', async () => {
  const h = await actorHarness(4);
  const state = h.actor.projection.state!;
  const config = defaultConfig('test'); config.models.commentaryProfile = 'local';
  const requests: StrategyRequest[] = [], spoken: string[] = [];
  const narrator = new StrategyNarrator({ generate: async () => null, summarizeStrategy: async input => {
    requests.push(input); return { summary: '[纠结]先理理这手牌吧。' };
  } }, () => config, () => 0, c => spoken.push(c.text), { mergeMs: 10, intervalMs: 80, timeoutMs: 100 });
  try {
    narrator.update(state, ['旧局面'], card());
    narrator.update({ ...state, stateVersion: state.stateVersion + 1 }, ['新局面'], card());
    await until(() => spoken.length === 1);
    assert.equal(requests.length, 1); assert.deepEqual(requests[0]!.recentDiscards, ['新局面']);
    narrator.update(state, ['第三次'], card());
    await delay(20); assert.equal(requests.length, 1);
    await until(() => requests.length === 2);
    assert.equal(spoken.length, 1);
  } finally { await narrator.close(); await h.cleanup(); }
});

test('failed, disabled, filtered, expired and revoked strategy summaries never speak raw actions', async t => {
  for (const scenario of ['disabled', 'missing', 'failure', 'malformed', 'oversized', 'long-sentence', 'no-mood', 'unknown-mood', 'missing-mood', 'filtered', 'expired', 'revoked', 'hand-change', 'timeout'] as const) {
    await t.test(scenario, async () => {
      const config = defaultConfig('test');
      if (scenario !== 'disabled') config.models.commentaryProfile = 'local';
      config.moderation.rules = [{ id: 'hidden', match: 'literal', pattern: '隐藏', action: 'drop' }];
      const entered = deferred(), reply = deferred<unknown>(), spoken: string[] = [];
      let epoch = 0;
      const narrator = new StrategyNarrator(scenario === 'missing' ? undefined : {
        generate: async () => null, summarizeStrategy: async () => {
          entered.resolve();
          if (scenario === 'failure') throw Error('unavailable');
          return reply.promise;
        },
      }, () => config, () => epoch, c => spoken.push(c.text), { mergeMs: 1, intervalMs: 1, timeoutMs: 20 });
      const state = { sessionId: 'session', handId: 'hand' } as GameState;
      try {
        narrator.update(state, [], scenario === 'expired' ? { ...card(), expiresAt: new Date(0).toISOString() } : card());
        if (['disabled', 'missing', 'expired'].includes(scenario)) await delay(30);
        else {
          await entered.promise;
          if (scenario === 'revoked') epoch++;
          if (scenario === 'hand-change') narrator.invalidate();
          if (scenario === 'timeout') await delay(30);
          reply.resolve(scenario === 'malformed' ? { factText: '摸切五万。' } : { summary:
            scenario === 'oversized' ? '长'.repeat(161) :
            scenario === 'long-sentence' ? `[纠结]${'长'.repeat(15)}。` :
            scenario === 'no-mood' ? '先留着连张吧。' :
            scenario === 'unknown-mood' ? '[改配置]先留着连张吧。' :
            scenario === 'missing-mood' ? '[纠结]先留着吧。再等等看。' :
            scenario === 'filtered' ? '[难受]隐藏。' : '[犹豫]先留着连张吧。' });
          await delay(10);
        }
        assert.deepEqual(spoken, []);
      } finally { reply.resolve(null); await narrator.close(); }
    });
  }
});

test('strategy generation waits up to 300 seconds and refreshes playback expiry after a slow result', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const timeouts: number[] = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return originalTimeout(ms); });
  const config = defaultConfig('test'); config.models.commentaryProfile = 'local';
  const entered = deferred(), reply = deferred<unknown>(), spoken: SpeechContent[] = [];
  const narrator = new StrategyNarrator({ generate: async () => null, summarizeStrategy: async () => {
    entered.resolve(); return reply.promise;
  } }, () => config, () => 0, content => spoken.push(content));
  try {
    narrator.update({ sessionId: 'synthetic', handId: 'hand' } as GameState, [], card());
    await entered.promise;
    assert.deepEqual(timeouts, [300_000]);
    t.mock.timers.tick(299_000);
    reply.resolve({ summary: '[纠结]先理理这手牌吧。' });
    await until(() => spoken.length === 1);
    assert.equal(Date.parse(spoken[0]!.createdAt), Date.now());
    assert.equal(Date.parse(spoken[0]!.expiresAt), Date.now() + 20_000);
  } finally { reply.resolve(null); await narrator.close(); }
});

test('strategy HTTP timeout stays at 300 seconds despite a shorter shared model setting', async t => {
  const { commentaryProvider } = await import('../src/adapters/llm/commentary.ts');
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ summary: '可以考虑保留连张。' }) } }],
  })));
  const provider = commentaryProvider({ baseUrl: 'http://model.test', model: 'synthetic', apiKey: 'synthetic',
    responseFormat: 'none', timeoutMs: 15_000 });
  const result = await provider.summarizeStrategy!({ state: { sessionId: 'synthetic', handId: 'hand' } as GameState,
    recentDiscards: [], persona: defaultConfig('test').persona }, new AbortController().signal);
  assert.deepEqual(result, { summary: '可以考虑保留连张。' });
  assert.deepEqual(timeouts, [300_000]);
});

test('changing the configured interval reschedules pending work without cancelling an active summary', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const config = defaultConfig('test'); config.models.commentaryProfile = 'local';
  const reply = deferred<unknown>(), spoken: string[] = [];
  let requests = 0;
  const narrator = new StrategyNarrator({ generate: async () => null, summarizeStrategy: async () => {
    requests++; return requests === 1 ? reply.promise : { summary: '[好奇]晚饭都吃啥呀？' };
  } }, () => config, () => 0, c => spoken.push(c.text), { mergeMs: 1, timeoutMs: 1000 });
  const state = { sessionId: 'session', handId: 'hand' } as GameState;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    narrator.update(state, [], card());
    t.mock.timers.tick(1); await flush(); assert.equal(requests, 1);
    narrator.update(state, [], card());
    config.models.commentaryIntervalMs = 1000;
    narrator.refreshInterval();
    reply.resolve({ summary: '[无奈]搭子今天请假啦。' });
    await flush(); assert.deepEqual(spoken, ['[无奈]搭子今天请假啦。']);
    t.mock.timers.tick(999); await flush(); assert.equal(requests, 1);
    t.mock.timers.tick(1); await flush(); assert.equal(requests, 2);
    narrator.update(state, [], card());
    config.models.commentaryIntervalMs = 3000;
    narrator.refreshInterval();
    t.mock.timers.tick(1000); await flush(); assert.equal(requests, 2);
    t.mock.timers.tick(2000); await flush(); assert.equal(requests, 3);
  } finally { reply.resolve(null); await narrator.close(); }
});

test('narration interval is validated, persisted, and defaults safely for older saved settings', async () => {
  const { patchConfig } = await import('../src/application/live/config.ts');
  const { ConsoleRuntime } = await import('../src/app/console/runtime.ts');
  const config = defaultConfig('test');
  assert.equal(config.models.commentaryIntervalMs, 15_000);
  for (const invalid of [0, 999, 300_001, 1500.5, NaN, '15000']) {
    assert.throws(() => patchConfig(config, { models: { commentaryIntervalMs: invalid } }, []));
  }
  for (const valid of [1000, 30_000, 300_000]) {
    assert.equal(patchConfig(config, { models: { commentaryIntervalMs: valid } }, []).next.models.commentaryIntervalMs, valid);
  }
  const h = await actorHarness(4);
  const open = () => ConsoleRuntime.open({ store: h.store, voiceId: 'test', voices: [],
    source: { kind: 'follow', sessionId: h.actor.projection.sessionId } });
  let runtime = await open();
  try {
    const { randomUUID } = await import('node:crypto');
    await runtime.command('config.patch', { commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: null,
      expectedRevision: runtime.configRevision, changes: { models: { commentaryIntervalMs: 30_000 } } });
    await runtime.close();
    runtime = await open();
    assert.equal(runtime.config.models.commentaryIntervalMs, 30_000);
    await runtime.close();
    const saved = await h.store.readConsole();
    const legacy = JSON.parse(JSON.stringify(saved.body));
    delete legacy.config.models.commentaryIntervalMs;
    await h.store.saveConsole(saved.revision, legacy, null);
    runtime = await open();
    assert.equal(runtime.config.models.commentaryIntervalMs, 15_000);
    const persisted = (await h.store.readConsole()).body as { config: { models: { commentaryIntervalMs: number } } };
    assert.equal(persisted.config.models.commentaryIntervalMs, 15_000);
  } finally { await runtime.close(); await h.cleanup(); }
});
