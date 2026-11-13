import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { ConsoleRuntime } from '../src/app/console/runtime.ts';
import { defaultConfig } from '../src/application/live/config.ts';
import { Interaction } from '../src/application/live/interaction.ts';
import { SpeechController, type SpeechContent } from '../src/application/live/speech.ts';
import { formatSpokenText, validSpokenText } from '../src/application/live/spoken-text.ts';
import { invitation } from '../src/application/live/recruitment.ts';
import { actorHarness, deferred } from './helpers.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); }
  assert.fail('spoken output did not complete');
}
const card = (text: string): SpeechContent => ({ contentId: 'test-speech', handId: null, text, priority: 'viewer',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20_000).toISOString() });

test('spoken sentences count mood, Unicode characters and punctuation within the 19-character limit', () => {
  assert.equal(validSpokenText(`[犹豫]${'好'.repeat(14)}。`, 1), true);
  assert.equal(validSpokenText(`[犹豫]${'好'.repeat(15)}。`, 1), false);
  assert.equal(validSpokenText(`[开心]${'😄'.repeat(14)}！`, 1), true);
  assert.equal(validSpokenText('[纠结]先等等。[好奇]晚饭吃啥呀？', 3), true);
  assert.equal(validSpokenText('[纠结]先等等。晚饭吃啥呀？', 3), false);
  assert.equal(validSpokenText('[纠结]先等等', 1), false);
  assert.equal(validSpokenText('[开心]你好！[开心]来啦！', 1), false);
  const fallback = formatSpokenText(invitation('89160', 0));
  assert.equal(validSpokenText(fallback, 20), true);
  assert.match(fallback, /8,9,1,6,0/);
  assert.equal(formatSpokenText(fallback), fallback);
});

test('changing dry-run during delivery reservation cannot send the old simulated viewer reply', async () => {
  const config = defaultConfig('test'), reserved = deferred(), release = deferred();
  config.interaction.roomId = '7';
  let finished = false, sends = 0;
  const interaction = new Interaction({ mode: 'direct',
    read: async () => ({ roomId: '7', senderId: 'host', cursor: '1', gap: false, messages: [
      { roomId: '7', messageId: 'greeting', viewerId: 'viewer', displayName: '访客', text: '你好' },
    ] }),
    send: async () => { sends++; throw Error('must not send'); },
  }, { reserveDelivery: async () => { reserved.resolve(); await release.promise; return true; },
    finishDelivery: async (_id, status) => { assert.equal(status, 'blocked'); finished = true; return null; }, markViewerSeen: async () => true },
  () => config, () => {}, async () => '[开心]这条只是预演。');
  try {
    interaction.tick([]); await reserved.promise;
    config.interaction.dryRun = false;
    release.resolve(); await until(() => finished);
    assert.equal(sends, 0);
  } finally { release.resolve(); await interaction.stop(); }
});

test('runtime keeps strategy and recruitment audio out of chat while viewer replies stay independent', async t => {
  for (const kind of ['strategy', 'recruitment', 'viewer'] as const) await t.test(kind, async () => {
    const h = await actorHarness(4), generated = deferred(), synthesized = deferred(), audio = deferred<string>();
    const playing = deferred(), sent: string[] = [], played: string[] = [];
    let read = 0;
    const text = kind === 'strategy' ? '[纠结]这手先别贪啦。[好奇]晚饭都吃啥呀?' :
      kind === 'recruitment' ? '[期待]快来一起玩吧。' : '[开心]来啦,一起看牌!';
    const runtime = await ConsoleRuntime.open({ store: h.store, voiceId: 'test', voices: [],
      source: { kind: 'follow', sessionId: h.actor.projection.sessionId },
      speech: { synthesize: async input => { synthesized.resolve(); assert.equal(input, text); return audio.promise; },
        play: async artifact => { played.push(artifact); await playing.promise; }, release: async () => {} },
      commentary: { generate: async () => null,
        summarizeStrategy: async () => { generated.resolve(); return { summary: text }; },
        answerChat: async () => { generated.resolve(); return { reply: text }; } },
      bili: { mode: 'direct', read: async () => ({ roomId: '7', senderId: 'host', cursor: String(++read), gap: false,
        messages: kind === 'viewer' && read === 1 ? [
          { roomId: '7', messageId: 'greeting', viewerId: 'viewer', displayName: '名字很长的观众', text: '你好呀，今天吃了什么呢？' },
        ] : [] }),
      send: async (_room, _sender, deliveryId, chunk) => {
        sent.push(chunk); return { deliveryId, status: 'published', receipt: `receipt-${sent.length}` };
      } },
    });
    try {
      await runtime.command('config.patch', { commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: null,
        expectedRevision: 0, changes: { models: { commentaryProfile: 'local' },
          interaction: { roomId: '7', dryRun: false, globalIntervalMs: 1000 } } });
      if (kind === 'strategy') await h.actor.ingest({ ...h.fixture.events[4]!, receivedAt: new Date().toISOString() });
      await runtime.tick();
      if (kind === 'recruitment') {
        generated.resolve(); runtime.speech.enqueue({ ...card(text), priority: 'recruitment' });
      }
      await generated.promise; await synthesized.promise;
      if (kind === 'viewer') await until(() => sent.length === 1);
      assert.deepEqual(sent, kind === 'viewer' ? [text] : [], 'only viewer replies send text, even before playback');
      audio.resolve(text);
      await until(() => played.length === 1);
      assert.deepEqual(played, [text]);
      assert.deepEqual(sent, kind === 'viewer' ? [text] : []);
      assert.doesNotMatch(sent.join(''), /名字很长|今天吃了/);
      assert.equal(runtime.speech.busy, true);
      playing.resolve(); await until(() => !runtime.speech.busy);
      await runtime.tick(); assert.equal(played.length, 1);
      assert.deepEqual(sent, kind === 'viewer' ? [text] : []);
    } finally { audio.resolve(text); playing.resolve(); await runtime.close(); await h.cleanup(); }
  });
});

test('cancelled, failed and expired synthesis never plays audio', async t => {
  for (const scenario of ['cancelled', 'failed', 'expired'] as const) await t.test(scenario, async () => {
    const config = defaultConfig('test'), entered = deferred(), result = deferred<string>();
    const played: string[] = [];
    const controller = new SpeechController({ synthesize: async () => {
      entered.resolve(); return result.promise;
    }, play: async artifact => { played.push(artifact); }, release: async () => {} }, () => config, () => {});
    try {
      const content = card('[犹豫]再等等看吧。');
      controller.enqueue(content); await entered.promise;
      if (scenario === 'cancelled') controller.clearPending();
      if (scenario === 'expired') content.expiresAt = new Date(0).toISOString();
      if (scenario === 'failed') result.reject(Error('synthesis failed')); else result.resolve('audio');
      await until(() => !controller.busy);
      assert.deepEqual(played, []);
    } finally { result.resolve('audio'); await controller.setMuted(true); }
  });
});
