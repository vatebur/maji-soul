import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBroker } from '../src/application/decision/model-broker.ts';
import { decodeEnvelope } from '../src/adapters/majsoul/wrapper.ts';
import { probeCompletion } from '../src/adapters/llm/chat-completions.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('live work cannot consume the reserved decision slot; slots release on failure', async () => {
  const broker = new ModelBroker(2);
  const { promise, resolve } = Promise.withResolvers<void>();
  const live = broker.run('live', () => promise);
  await assert.rejects(broker.run('live', async () => {}), /LIVE_CAPACITY_RESERVED/);
  assert.equal(await broker.run('decision', async () => 'decision'), 'decision');
  resolve(); await live;
  await assert.rejects(broker.run('decision', async () => { throw new Error('failure'); }));
  assert.equal(await broker.run('decision', async () => 1), 1);
  await assert.rejects(new ModelBroker(1).run('live', async () => {}), /LIVE_CAPACITY_RESERVED/);
});

test('transport envelope preserves binary payload, refuses truncation and unknown types', () => {
  const name = new TextEncoder().encode('.lq.FastTest.syncGame');
  const wire = new Uint8Array([2, 255, 1, 10, name.length, ...name, 18, 2, 0, 255]);
  const decoded = decodeEnvelope(wire);
  assert.equal(decoded.name, '.lq.FastTest.syncGame');
  assert.equal(decoded.requestId, 511);
  assert.deepEqual([...decoded.data], [0,255]);
  assert.throws(() => decodeEnvelope(wire.slice(0,-1)), /TRUNCATED_WRAPPER/);
  assert.throws(() => decodeEnvelope(new Uint8Array([2])), /TRUNCATED_FRAME/);
  assert.throws(() => decodeEnvelope(new Uint8Array([4])), /UNKNOWN_FRAME_TYPE/);
});

test('model adapter rejects free text, unknown candidates and extra fields; deadline cancels HTTP', async () => {
  let content = '{"actionId":"probe-discard"}', delay = false;
  const server = createServer((_req,res) => {
    if (delay) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture', apiKey: 'fixture', responseFormat: 'none' as const, timeoutMs: 500 };
  try {
    await probeCompletion(config);
    for (const invalid of ['plain text','{"actionId":"unknown"}','{"actionId":"probe-discard","extra":true}']) {
      content = invalid; await assert.rejects(probeCompletion(config), /INVALID_MODEL/);
    }
    delay = true;
    await assert.rejects(probeCompletion({ ...config, timeoutMs: 20 }), { name: 'TimeoutError' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
