import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('browser metadata probe bounds its queue, drops payloads and removes listeners on restore', () => {
  const context: { window: Record<string, any>; [key: string]: any } = { window: {}, TextDecoder, Uint8Array, ArrayBuffer };
  class FakeSocket extends EventTarget {
    sends = 0;
    send(_data: unknown) { this.sends++; }
  }
  const original = FakeSocket.prototype.send;
  context.WebSocket = FakeSocket;
  const source = readFileSync('scripts/ego-metadata-probe.js','utf8').replace('export function', 'function');
  runInNewContext(source + '\ninstallMetadataProbe();',context);
  const socket = new FakeSocket();
  const name = new TextEncoder().encode('.lq.Lobby.oauth2Login');
  const secret = new TextEncoder().encode('secret-fixture-token');
  const frame = new Uint8Array([2,0,0,10,name.length,...name,18,secret.length,...secret]);
  for(let i=0;i<300;i++) socket.send(frame);
  const state = context.window.__majiProbe.read();
  assert.equal(state.dropped,44);
  assert.equal(state.entries.length,256);
  assert.equal(state.reliableSourceCursor,false);
  assert.equal(JSON.stringify(state).includes('secret-fixture-token'),false);
  assert.equal(socket.sends,300);
  context.window.__majiProbe.restore();
  assert.equal(FakeSocket.prototype.send,original);
  assert.equal(context.window.__majiProbe,undefined);
  socket.send(frame);
  assert.equal(socket.sends,301);
});
