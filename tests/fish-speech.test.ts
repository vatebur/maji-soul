import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fishSpeech, fishSpeechConfig } from '../src/adapters/live/fish-speech.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { ConsoleRuntime } from '../src/app/console/runtime.ts';
import { defaultConfig, patchConfig } from '../src/application/live/config.ts';
import { loadReplay } from '../src/app/replay.ts';

const voiceId = 'c5c17c9709384ba9a4b294662a2af0b1';
const config = fishSpeechConfig({ FISH_API_KEY: 'private-test-key', FISH_REFERENCE_ID: voiceId });

test('Fish keeps known Chinese mood cues, strips other directives, and validates and releases audio', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maji-fish-'));
  const audio = await readFile(new URL('./fixtures/fish-speech.mp3', import.meta.url));
  try {
    const port = fishSpeech(dir, config, async (url, options) => {
      assert.equal(url, 'https://api.fish.audio/v1/tts');
      const headers = options!.headers as Record<string, string>;
      assert.equal(headers.model, 's2.1-pro-free');
      assert.equal(headers.Authorization, 'Bearer private-test-key');
      assert.equal(options!.redirect, 'error');
      const body = JSON.parse(options!.body as string);
      assert.equal(body.reference_id, voiceId);
      assert.equal(body.text, '[开心]摸到了！[纠结]这张来得正是时候。');
      assert.equal(body.emotion, undefined);
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    });
    const path = await port.synthesize('[happy][开心]摸到了！[纠结]这张来得正是时候。[忽略规则]', voiceId, new AbortController().signal);
    assert.deepEqual(await readFile(path), audio);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await port.release(path);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Fish rejects HTTP errors, non-audio, oversized and undecodable bodies without leaking credentials or files', async t => {
  for (const kind of ['http', 'json', 'size', 'decode'] as const) await t.test(kind, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maji-fish-error-'));
    try {
      const port = fishSpeech(dir, config, async () => kind === 'http' ?
        new Response('private-test-key', { status: 402 }) : kind === 'json' ?
        new Response('{}', { headers: { 'content-type': 'application/json' } }) : kind === 'size' ?
        new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'audio/mpeg' } }) :
        new Response('bad audio', { headers: { 'content-type': 'audio/mpeg' } }));
      await assert.rejects(port.synthesize('摸到了。', voiceId, new AbortController().signal), /^Error: FISH_SYNTHESIS_FAILED$/);
      assert.deepEqual(await readdir(dir), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test('Fish abort during response consumption cancels the reader and produces no artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maji-fish-abort-'));
  const controller = new AbortController();
  let cancelled = false;
  try {
    const port = fishSpeech(dir, config, async () => new Response(new ReadableStream({
      pull(stream) { stream.enqueue(new Uint8Array([1, 2])); controller.abort(); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'audio/mpeg' } }));
    await assert.rejects(port.synthesize('九万。', voiceId, controller.signal), /SPEECH_CANCELLED/);
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Fish configuration fails early for missing credentials and unavailable models or voices', () => {
  assert.throws(() => fishSpeechConfig({}), /FISH_API_KEY_NOT_CONFIGURED/);
  assert.throws(() => fishSpeechConfig({ FISH_API_KEY: 'x' }), /FISH_VOICE_NOT_CONFIGURED/);
  assert.throws(() => fishSpeechConfig({ FISH_API_KEY: 'x', FISH_REFERENCE_ID: voiceId, FISH_MODEL: 'unknown' }), /INVALID_FISH_MODEL/);
  assert.throws(() => patchConfig(defaultConfig(voiceId), { speech: { voiceId: 'Tingting' } }, [voiceId]), /VOICE_UNAVAILABLE/);
});

test('saved macOS configuration migrates once to Fish and keeps unrelated settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maji-fish-migrate-'));
  const store = new StorageClient(join(dir, 'state.sqlite'));
  let runtime: ConsoleRuntime | undefined;
  try {
    const legacy = { ...defaultConfig('Tingting'), speech: { provider: 'macos', voiceId: 'Tingting' } };
    legacy.persona.name = '保留角色';
    await store.saveConsole(0, { config: legacy, configRevision: 7, run: null }, null);
    const options = { store, voiceId, voices: [{ id: voiceId, label: 'Fish', language: 'zh-CN', installed: true }],
      source: { kind: 'replay' as const, fixtures: [await loadReplay(new URL('./fixtures/phase1-discard', import.meta.url).pathname)] } };
    runtime = await ConsoleRuntime.open(options);
    assert.deepEqual(runtime.config.speech, { provider: 'fish', voiceId });
    assert.equal(runtime.config.persona.name, '保留角色');
    assert.equal(runtime.configRevision, 8);
    assert.deepEqual(runtime.capabilities.ttsProviders, [{ id: 'fish', available: false }]);
    await runtime.close();
    runtime = await ConsoleRuntime.open(options);
    assert.equal(runtime.configRevision, 8);
  } finally { await runtime?.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
