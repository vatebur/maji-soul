import { requireThat } from '../../domain/game/value.ts';
import type { BiliPort } from '../../application/live/interaction.ts';

export function biliRelay(address: string, token: string, request = fetch): BiliPort {
  const base = new URL(address);
  requireThat(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.pathname === '/' &&
    !base.username && !base.password && !base.search && !base.hash && token.length >= 16 && token.length <= 512 &&
    /^[\x21-\x7e]+$/.test(token), 'INVALID_BILI_RELAY');
  const json = async (path: string, signal: AbortSignal, payload?: object) => {
    const response = await request(new URL(path, base), {
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      redirect: 'error', cache: 'no-store', signal,
      ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
    });
    requireThat(response.ok && response.body, 'BILI_RELAY_HTTP_FAILED');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        requireThat(size <= 128 * 1024, 'BILI_RELAY_BODY_TOO_LARGE');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
  return {
    mode: 'relay',
    read(roomId, after, signal) {
      const query = new URLSearchParams({ roomId });
      if (after !== null) query.set('after', after);
      return json(`/v1/messages?${query}`, signal);
    },
    send: (roomId, senderId, deliveryId, text, signal) => json('/v1/replies', signal, { roomId, senderId, deliveryId, text }),
  };
}

export function simulatedBili(questions: string[]): BiliPort {
  return {
    mode: 'simulated',
    async read(roomId, after) {
      const index = Number(after ?? 0), text = questions[index];
      return { roomId, senderId: 'rehearsal-host', gap: false, cursor: String(index + (text === undefined ? 0 : 1)),
        messages: text === undefined ? [] : [{ roomId, messageId: `demo-${index}`, viewerId: `viewer-${index}`, displayName: '模拟观众', text }] };
    },
    async send() { throw Error('SIMULATED_BILI'); },
  };
}
