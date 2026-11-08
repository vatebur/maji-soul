import { inflate, brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { requireThat } from '../../domain/game/value.ts';

const unzip = promisify(inflate), unbrotli = promisify(brotliDecompress);
const MAX_BYTES = 1024 * 1024;
export interface BiliPacket { operation: number; body: Buffer }
export interface BiliMessage {
  roomId: string; messageId: string; viewerId: string; displayName: string; text: string; sourceAt: string;
}

export function encodeBiliPacket(operation: number, value: object | string = ''): Buffer {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), result = Buffer.alloc(16 + body.length);
  result.writeUInt32BE(result.length, 0); result.writeUInt16BE(16, 4); result.writeUInt16BE(1, 6);
  result.writeUInt32BE(operation, 8); result.writeUInt32BE(1, 12); body.copy(result, 16);
  return result;
}

/** A WebSocket message may contain multiple packets, including compressed packet batches. */
export async function decodeBiliPackets(input: Buffer): Promise<BiliPacket[]> {
  requireThat(input.length > 0 && input.length <= MAX_BYTES, 'BILI_PACKET_SIZE');
  const packets: BiliPacket[] = [];
  let remaining = 2 * MAX_BYTES, count = 0;
  const decode = async (buffer: Buffer, depth: number): Promise<void> => {
    requireThat(depth <= 3, 'BILI_PACKET_DEPTH');
    for (let offset = 0; offset < buffer.length;) {
      requireThat(buffer.length - offset >= 16 && ++count <= 1024, 'BILI_PACKET_HEADER');
      const length = buffer.readUInt32BE(offset), header = buffer.readUInt16BE(offset + 4), version = buffer.readUInt16BE(offset + 6);
      const operation = buffer.readUInt32BE(offset + 8);
      requireThat(header === 16 && length >= header && length <= MAX_BYTES && offset + length <= buffer.length, 'BILI_PACKET_HEADER');
      const body = buffer.subarray(offset + header, offset + length);
      offset += length;
      if (version === 2 || version === 3) {
        requireThat(remaining > 0, 'BILI_PACKET_SIZE');
        const inflated = await (version === 2 ? unzip : unbrotli)(body, { maxOutputLength: remaining });
        remaining -= inflated.length;
        await decode(inflated, depth + 1);
      } else {
        requireThat(version === 0 || version === 1, 'BILI_PACKET_VERSION');
        packets.push({ operation, body });
      }
    }
  };
  await decode(input, 0);
  return packets;
}

export const biliId = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
};
export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** No fabricated viewer identity or locally generated message ID for privacy-masked payloads. */
export function normalizeBiliMessage(payload: unknown, roomId: string): BiliMessage | null {
  const data = record(payload);
  if (typeof data?.cmd !== 'string' || !/^DANMU_MSG(?::|$)/.test(data.cmd)) return null;
  const info = data.info;
  requireThat(Array.isArray(info) && Array.isArray(info[0]) && Array.isArray(info[2]), 'BILI_MESSAGE_INVALID');
  const meta = info[0], user = info[2], viewerId = biliId(user[0]);
  const extraText = record(meta[15])?.extra;
  requireThat(typeof extraText === 'string' && extraText.length <= 65536, 'BILI_MESSAGE_ID_MISSING');
  let extra: Record<string, unknown> | null = null;
  try { extra = record(JSON.parse(extraText)); } catch { /* Missing identity fails closed below. */ }
  const messageId = extra?.id_str;
  requireThat(typeof messageId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(messageId), 'BILI_MESSAGE_ID_MISSING');
  requireThat(viewerId, 'BILI_VIEWER_ID_MISSING');
  requireThat(typeof info[1] === 'string' && info[1].length > 0 && info[1].length <= 500 &&
    typeof user[1] === 'string' && user[1].length > 0 && user[1].length <= 120, 'BILI_MESSAGE_INVALID');
  const stamp = meta[4];
  requireThat(typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp >= 1_000_000_000 && stamp < 10_000_000_000_000, 'BILI_MESSAGE_TIME_INVALID');
  const time = stamp < 10_000_000_000 ? stamp * 1000 : stamp;
  return { roomId, messageId, viewerId, displayName: user[1], text: info[1], sourceAt: new Date(time).toISOString() };
}
