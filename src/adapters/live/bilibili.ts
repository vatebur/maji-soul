import { randomUUID } from 'node:crypto';
import type { BiliPort } from '../../application/live/interaction.ts';
import { requireThat } from '../../domain/game/value.ts';
import { BiliApi, type BiliAuth, type BiliRoom, type BiliSession } from './bilibili-api.ts';
import { biliId, decodeBiliPackets, encodeBiliPacket, normalizeBiliMessage, record, type BiliMessage } from './bilibili-protocol.ts';

export interface BiliSocket {
  binaryType: string; readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: string, listener: EventListener): void;
}
type Api = Pick<BiliApi, 'identity' | 'room' | 'send'>;
const codeOf = (error: unknown) => error instanceof Error && /^BILI_[A-Z0-9_]{1,60}$/.test(error.message) ? error.message : 'BILI_CONNECTION_FAILED';

/** A single authenticated stream. Only Interaction owns outbound delivery policy. */
export class BilibiliDirect implements BiliPort {
  readonly mode = 'direct' as const;
  #api: Api;
  #socketFactory: (url: string) => BiliSocket;
  #socket: BiliSocket | null = null;
  #controller = new AbortController();
  #generation = 0;
  #connecting: Promise<void> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #connection: NonNullable<BiliPort['status']>['connection'] = 'disconnected';
  #requestedRoom: string | null = null;
  #room: BiliRoom | null = null;
  #session: BiliSession | null = null;
  #cursorEpoch = randomUUID();
  #sequence = 0;
  #messages: { sequence: number; message: BiliMessage }[] = [];
  #received = 0;
  #dropped = 0;
  #gap = false;
  #error: string | null = null;
  #blocked: string | null = null;
  #everConnected = false;
  #hostIndex = 0;

  constructor(auth: BiliAuth, options: { api?: Api; socketFactory?: (url: string) => BiliSocket } = {}) {
    this.#api = options.api ?? new BiliApi(auth);
    this.#socketFactory = options.socketFactory ?? (url => new WebSocket(url));
  }
  get status(): NonNullable<BiliPort['status']> {
    return { connection: this.#connection, roomId: this.#room?.roomId ?? null, accountId: this.#session?.userId ?? null,
      receivedCount: this.#received, droppedCount: this.#dropped, gap: this.#gap, errorCode: this.#error };
  }
  disconnect() {
    this.#generation++; this.#controller.abort(); this.#controller = new AbortController();
    const socket = this.#socket; this.#socket = null;
    try { socket?.close(); } catch { /* teardown is idempotent */ }
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null; this.#connection = 'disconnected';
    this.#requestedRoom = null; this.#room = null; this.#session = null;
    this.#messages = []; this.#sequence = 0; this.#cursorEpoch = randomUUID();
    this.#received = this.#dropped = this.#hostIndex = 0;
    this.#gap = this.#everConnected = false; this.#error = this.#blocked = null;
  }
  async read(roomId: string, after: string | null, signal: AbortSignal) {
    requireThat(biliId(roomId), 'INVALID_BILI_ROOM'); signal.throwIfAborted();
    if (this.#requestedRoom !== roomId) { this.disconnect(); this.#requestedRoom = roomId; }
    if (this.#blocked) throw Error(this.#blocked);
    if (this.#connection !== 'connected') {
      if (!this.#connecting) this.#connecting = this.#connect(roomId, signal).finally(() => { this.#connecting = null; });
      await this.#connecting;
    }
    signal.throwIfAborted();
    requireThat(this.#requestedRoom === roomId && this.#connection === 'connected' && this.#session, 'BILI_CONNECTION_CHANGED');
    let sequence = 0;
    if (after !== null) {
      const [epoch, value, extra] = after.split('.');
      if (epoch !== this.#cursorEpoch || extra !== undefined || !/^\d{1,16}$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) > this.#sequence)
        this.#gap = true;
      else sequence = Number(value);
    }
    if (sequence < (this.#messages[0]?.sequence ?? this.#sequence + 1) - 1) this.#gap = true;
    const batch = this.#messages.filter(m => m.sequence > sequence).slice(0, 50);
    return { roomId, senderId: this.#session.userId, cursor: `${this.#cursorEpoch}.${batch.at(-1)?.sequence ?? this.#sequence}`,
      gap: this.#gap, messages: batch.map(item => structuredClone(item.message)) };
  }
  async send(roomId: string, senderId: string, deliveryId: string, text: string, signal: AbortSignal) {
    requireThat(roomId === this.#requestedRoom && this.#connection === 'connected' && this.#room &&
      senderId === this.#session?.userId, 'BILI_CONNECTION_CHANGED');
    // Disconnect / room changes revoke in-flight identity checks before the POST.
    return this.#api.send(this.#room.roomId, senderId, deliveryId, text, AbortSignal.any([signal, this.#controller.signal]));
  }
  async #connect(roomId: string, callerSignal: AbortSignal) {
    const generation = ++this.#generation;
    const signal = AbortSignal.any([callerSignal, this.#controller.signal, AbortSignal.timeout(12_000)]);
    const current = () => generation === this.#generation && roomId === this.#requestedRoom;
    this.#connection = this.#everConnected ? 'recovering' : 'connecting';
    try {
      const session = await this.#api.identity(signal);
      const room = await this.#api.room(roomId, session, signal);
      signal.throwIfAborted(); requireThat(current(), 'BILI_CONNECTION_CHANGED');
      this.#session = session; this.#room = room;
      const socket = this.#socketFactory(room.hosts[this.#hostIndex++ % room.hosts.length]!);
      this.#socket = socket; socket.binaryType = 'arraybuffer';
      const valid = () => current() && this.#socket === socket;
      await new Promise<void>((resolve, reject) => {
        let settled = false, processing = Promise.resolve(), pending = 0, lastHeartbeat = Date.now();
        const fail = (code: string) => {
          if (!valid()) return;
          this.#socket = null; this.#connection = 'recovering'; this.#gap ||= this.#everConnected; this.#error = code;
          if (code === 'BILI_WS_AUTH_REJECTED') this.#blocked = code;
          if (this.#heartbeat) clearInterval(this.#heartbeat); this.#heartbeat = null;
          try { socket.close(); } catch { /* already closed */ }
          signal.removeEventListener('abort', abort);
          if (!settled) { settled = true; reject(Error(code)); }
          this.#controller.abort(); this.#controller = new AbortController();
        };
        const abort = () => {
          if (valid()) fail('BILI_CONNECTION_CANCELLED');
          else if (!settled) { settled = true; reject(Error('BILI_CONNECTION_CANCELLED')); }
        };
        signal.addEventListener('abort', abort, { once: true });
        socket.addEventListener('open', () => {
          if (!valid() || signal.aborted) { abort(); return; }
          socket.send(new Uint8Array(encodeBiliPacket(7, { uid: Number(session.userId), roomid: Number(room.roomId),
            protover: 3, platform: 'web', type: 2, key: room.token, buvid: session.buvid })));
        });
        socket.addEventListener('close', () => fail('BILI_DISCONNECTED'));
        socket.addEventListener('error', () => fail('BILI_SOCKET_FAILED'));
        socket.addEventListener('message', event => {
          if (!valid()) return;
          const data: unknown = (event as MessageEvent).data;
          if (!(data instanceof ArrayBuffer) || data.byteLength > 1024 * 1024 || ++pending > 8) { fail('BILI_PACKET_BACKLOG'); return; }
          processing = processing.then(async () => {
            const packets = await decodeBiliPackets(Buffer.from(data));
            for (const packet of packets) {
              if (!valid()) return;
              if (packet.operation === 8) {
                const auth = record(JSON.parse(packet.body.toString('utf8')));
                if (auth?.code !== 0) { fail('BILI_WS_AUTH_REJECTED'); return; }
                if (settled) continue;
                this.#connection = 'connected'; this.#everConnected = true; this.#error = null;
                settled = true; signal.removeEventListener('abort', abort);
                this.#heartbeat = setInterval(() => {
                  if (!valid()) return;
                  if (Date.now() - lastHeartbeat >= 90_000) { fail('BILI_HEARTBEAT_TIMEOUT'); return; }
                  try { socket.send(new Uint8Array(encodeBiliPacket(2))); } catch { fail('BILI_SOCKET_FAILED'); }
                }, 30_000).unref();
                resolve();
              } else if (packet.operation === 3) lastHeartbeat = Date.now();
              else if (packet.operation === 5 && this.#connection === 'connected') {
                try {
                  const message = normalizeBiliMessage(JSON.parse(packet.body.toString('utf8')), roomId);
                  if (message) {
                    this.#received++;
                    this.#messages.push({ sequence: ++this.#sequence, message });
                    if (this.#messages.length > 256) this.#messages.shift();
                  }
                } catch { this.#dropped++; this.#gap = true; this.#error = 'BILI_MESSAGE_UNSUPPORTED'; }
              }
            }
          }).catch(() => fail('BILI_PACKET_INVALID')).finally(() => { pending--; });
        });
        if (signal.aborted) abort();
      });
    } catch (error) {
      if (current()) {
        this.#connection = 'recovering'; this.#error = codeOf(error);
        if (/^BILI_(LOGIN_REQUIRED|ACCOUNT_CHANGED|ACCESS_DENIED|WS_AUTH_REJECTED|HTTP_40[13]|HTTP_429)$/.test(this.#error))
          this.#blocked = this.#error;
      }
      throw Error(codeOf(error));
    }
  }
}
