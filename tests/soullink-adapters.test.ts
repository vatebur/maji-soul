import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSoullinkFishVoice, fishSpeechConfig } from '../src/adapters/live/soullink-fish-voice.ts';
import { createSoullinkMotionPlanner, soullinkMotionConfig } from '../src/adapters/live/soullink-motion.ts';

const motionConfig = { apiKey: 'private-motion-key', baseURL: 'https://example.invalid/v1', model: 'test-motion', timeoutMs: 1000 };
const input = { text: '[开心]这手牌很有机会。[紧张]先防一下这家。', moods: ['开心', '紧张'], durationSec: 2,
  parameters: { ParamAngleX: { min: -30, max: 30, default: 0 }, ParamMouthOpenY: { min: 0, max: 1, default: 0 } } };
const signal = () => new AbortController().signal;

function completion(value: unknown): Response {
  return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(value) } }] });
}

test('real Soullink planner maps existing narration to bounded model frames without claiming mouth ownership', async () => {
  const calls: unknown[] = [];
  const plan = createSoullinkMotionPlanner(motionConfig, async (url, options) => {
    assert.equal(url, 'https://example.invalid/v1/chat/completions');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer private-motion-key');
    const request = JSON.parse(options?.body as string);
    calls.push(request);
    assert.equal(request.model, 'test-motion');
    assert.ok(request.messages.some((message: { content: string }) => message.content.includes('这手牌很有机会')));
    assert.ok(JSON.stringify(request.messages).includes('[开心]') && JSON.stringify(request.messages).includes('[紧张]'));
    const direction = request.messages.find((message: { role: string }) => message.role === 'system').content as string;
    assert.ok(direction.includes('头部、身体、视线和适量手臂动作'));
    assert.ok(direction.includes('已知口播情绪顺序：["开心","紧张"]'));
    assert.equal(request.response_format, undefined);
    return completion({ parameterPlan: [
      { parameters: { ParamAngleX: 999, ParamMouthOpenY: 1, Unknown: 3 }, label: 'private-motion-key' },
      { parameters: { ParamAngleX: -999, ParamMouthOpenY: 0 }, label: 'provider debug data' },
    ] });
  });
  const result = await plan(input, signal());
  assert.equal(calls.length, 1, 'uses the SDK single-stage planner for existing narration');
  assert.equal(result.provider, 'openai-compatible');
  assert.deepEqual(result.parameterPlan.map(beat => ({ ...beat, parameters: { ...beat.parameters } })), [
    { time: 0, duration: .9, label: 'speech-1', parameters: { ParamAngleX: 30 } },
    { time: 1, duration: .9, label: 'speech-2', parameters: { ParamAngleX: -30 } },
  ]);
  assert.ok(!JSON.stringify(result).includes('private-motion-key'));
});

test('motion failures and oversized responses return only a safe fallback', async t => {
  for (const kind of ['http', 'large', 'invalid'] as const) await t.test(kind, async () => {
    let requests = 0;
    const plan = createSoullinkMotionPlanner(motionConfig, async () => {
      requests++;
      return kind === 'http' ? new Response('private-motion-key provider trace', { status: 401 }) : kind === 'large' ?
        new Response('x'.repeat(131073)) : completion({ motionPlan: [] });
    });
    assert.deepEqual(await plan(input, signal()), { provider: 'vad-facs', parameterPlan: [], fallbackReason: 'planner_unavailable' });
    assert.equal(requests, 1, 'a rejected or malformed response cannot trigger duplicate format retries');
  });
});

test('optional motion reasoning effort is sent only when configured and rejects invalid values', async () => {
  const config = soullinkMotionConfig({ MAJI_AI_BASE_URL: 'https://example.invalid/v1', MAJI_AI_API_KEY: 'key', MAJI_AI_MODEL: 'model',
    MAJI_LIVE2D_AI_REASONING_EFFORT: 'low' })!;
  let effort: unknown;
  await createSoullinkMotionPlanner(config, async (_url, options) => {
    effort = JSON.parse(options!.body as string).reasoning_effort;
    return completion({ parameterPlan: [{ parameters: { ParamAngleX: 3 } }, { parameters: { ParamAngleX: 0 } }] });
  })(input, signal());
  assert.equal(effort, 'low');
  assert.throws(() => soullinkMotionConfig({ MAJI_AI_BASE_URL: 'https://example.invalid/v1', MAJI_AI_API_KEY: 'key', MAJI_AI_MODEL: 'model',
    MAJI_LIVE2D_AI_REASONING_EFFORT: 'unbounded' }), /INVALID_LIVE2D_REASONING_EFFORT/);
});

test('single-stage planning distributes up to eight targets across the clip with prompt pose transitions', async t => {
  for (const [durationSec, expectedFrames, tokenBudget, transitionSec] of [
    [.05, 1, 900, .05], [3, 2, 900, .9], [12.5, 5, 1300, .9], [120, 8, 2080, .9],
  ] as const) {
    await t.test(`${durationSec}s`, async () => {
      let requests = 0;
      const plan = createSoullinkMotionPlanner({ ...motionConfig, responseFormat: 'json_object' }, async (_url, options) => {
        requests++;
        const request = JSON.parse(options?.body as string);
        assert.deepEqual(request.response_format, { type: 'json_object' });
        assert.equal(request.max_tokens, tokenBudget);
        const motion = JSON.parse(request.messages.find((message: { role: string }) => message.role === 'user').content);
        assert.equal(motion.frameCount, expectedFrames);
        return completion({ parameterPlan: Array.from({ length: expectedFrames }, (_, index) => ({
          parameters: { ParamAngleX: index % 2 ? -8 : 8 },
        })) });
      });
      const result = await plan({ ...input, durationSec }, signal());
      assert.equal(result.provider, 'openai-compatible');
      assert.equal(requests, 1);
      const interval = durationSec / expectedFrames;
      assert.deepEqual(result.parameterPlan.map(({ time, duration }) => ({ time, duration })),
        Array.from({ length: expectedFrames }, (_, index) => ({ time: index * interval, duration: transitionSec })));
    });
  }
});

test('longer plans preserve validated body, gaze and hand channels while rejecting unknown and mouth channels', async () => {
  const parameters = { ...input.parameters, ParamBodyAngleX: { min: -10, max: 10, default: 0 },
    ParamEyeBallX: { min: -.8, max: .8, default: 0 }, LArm: { min: -.25, max: .25, default: 0 } };
  const plan = createSoullinkMotionPlanner(motionConfig, async () => completion({ parameterPlan: Array.from({ length: 6 }, (_, index) => ({
    parameters: { ParamAngleX: index % 2 ? 10 : -10, ParamBodyAngleX: 20, ParamEyeBallX: -2, LArm: 1,
      ParamMouthOpenY: 1, UncalibratedClothingSwitch: 1 },
  })) }));
  const result = await plan({ ...input, durationSec: 15, parameters }, signal());
  assert.equal(result.provider, 'openai-compatible');
  assert.equal(result.parameterPlan.length, 6);
  for (const beat of result.parameterPlan) {
    assert.equal(beat.parameters.ParamBodyAngleX, 10);
    assert.equal(beat.parameters.ParamEyeBallX, -.8);
    assert.equal(beat.parameters.LArm, .25);
    assert.equal(beat.parameters.ParamMouthOpenY, undefined);
    assert.equal(beat.parameters.UncalibratedClothingSwitch, undefined);
  }
});

test('motion planning has one bounded deadline and cancellation stops network retries', async t => {
  for (const cause of ['timeout', 'cancelled'] as const) await t.test(cause, async () => {
    const controller = new AbortController();
    let requests = 0;
    const plan = createSoullinkMotionPlanner({ ...motionConfig, timeoutMs: 25 }, async (_url, options) => {
      requests++;
      return await new Promise<Response>((_resolve, reject) => {
        const requestSignal = options?.signal;
        if (requestSignal?.aborted) reject(new Error('private-motion-key'));
        else requestSignal?.addEventListener('abort', () => reject(new Error('private-motion-key')), { once: true });
      });
    });
    // Keep the event loop alive while the production AbortSignal timeout is pending.
    const timer = setTimeout(() => controller.abort(), cause === 'cancelled' ? 5 : 200);
    try {
      assert.deepEqual(await plan(input, controller.signal), { provider: 'vad-facs', parameterPlan: [], fallbackReason: cause });
      assert.equal(requests, 1);
    } finally { clearTimeout(timer); }
  });
});

test('absent model service or model parameters stays local, and config can reuse existing model settings', async () => {
  const neverFetch: typeof fetch = async () => { throw new Error('unexpected network'); };
  assert.deepEqual(await createSoullinkMotionPlanner(undefined, neverFetch)(input, signal()),
    { provider: 'vad-facs', parameterPlan: [], fallbackReason: 'not_configured' });
  assert.equal((await createSoullinkMotionPlanner(motionConfig, neverFetch)({ ...input, parameters: {} }, signal())).fallbackReason, 'no_parameters');
  assert.equal((await createSoullinkMotionPlanner(motionConfig, neverFetch)({ ...input, durationSec: NaN }, signal())).fallbackReason, 'invalid_input');
  assert.deepEqual(soullinkMotionConfig({ MAJI_AI_BASE_URL: 'https://example.invalid/v1/', MAJI_AI_API_KEY: 'key', MAJI_AI_MODEL: 'model',
    MAJI_LIVE2D_AI_BASE_URL: '', MAJI_LIVE2D_AI_API_KEY: ' ', MAJI_LIVE2D_AI_MODEL: '', MAJI_LIVE2D_AI_TIMEOUT_MS: '' }),
    { baseURL: 'https://example.invalid/v1', apiKey: 'key', model: 'model', timeoutMs: 12000, responseFormat: 'none' });
  assert.equal(soullinkMotionConfig({ MAJI_AI_BASE_URL: 'https://example.invalid/v1', MAJI_AI_API_KEY: 'key', MAJI_AI_MODEL: 'model',
    MAJI_AI_RESPONSE_FORMAT: 'json_object', MAJI_LIVE2D_AI_RESPONSE_FORMAT: '' })?.responseFormat, 'json_object');
  assert.equal(soullinkMotionConfig({}), undefined);
  assert.throws(() => soullinkMotionConfig({ MAJI_AI_BASE_URL: 'https://user:secret@example.invalid', MAJI_AI_API_KEY: 'key', MAJI_AI_MODEL: 'model' }), /INVALID_LIVE2D_MODEL_URL/);
});

test('Soullink TtsClient Fish provider returns exact existing cloud audio and keeps known narrator cues', async () => {
  const voiceId = 'c5c17c9709384ba9a4b294662a2af0b1';
  const config = fishSpeechConfig({ FISH_API_KEY: 'private-fish-key', FISH_REFERENCE_ID: voiceId });
  const fixture = await readFile(new URL('./fixtures/fish-speech.mp3', import.meta.url));
  const voice = createSoullinkFishVoice(config, async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/tts');
    const request = JSON.parse(options?.body as string);
    assert.equal(request.text, '[开心]摸到了！');
    assert.equal(request.reference_id, voiceId);
    assert.equal((options?.headers as Record<string, string>).model, 's2.1-pro-free');
    return new Response(fixture, { headers: { 'Content-Type': 'audio/mpeg' } });
  }, signal());
  const result = await voice.synthesize('[开心]摸到了！[untrusted cue]', { emotion: 'happy' });
  assert.deepEqual(Buffer.from(result.bytes!), fixture);
  assert.equal(result.url, undefined);
});

test('Fish byte provider cancels rejected response bodies without leaking provider details', async () => {
  const config = fishSpeechConfig({ FISH_API_KEY: 'private-fish-key', FISH_REFERENCE_ID: 'c5c17c9709384ba9a4b294662a2af0b1' });
  let cancelled = false;
  const voice = createSoullinkFishVoice(config, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '999999999' } }), signal());
  await assert.rejects(voice.synthesize('你好。', {}), /^Error: FISH_SYNTHESIS_FAILED$/);
  assert.equal(cancelled, true);
});
