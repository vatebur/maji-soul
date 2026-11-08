import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat } from '../../domain/game/value.ts';
import { biliId, record } from './bilibili-protocol.ts';

// WBI permutation and protocol field references: dsh-bili-live 0e7a393 (MIT).
// Copyright notice is preserved in docs/research/licenses/dsh-bili-live-LICENSE.txt.
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,
  14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export interface BiliAuth { sessdata: string; csrf: string; userId: string; buvid: string | null }
export interface BiliSession { userId: string; buvid: string; mixin: string }
export interface BiliRoom { roomId: string; hosts: string[]; token: string }

export function parseBiliCookie(text: string): BiliAuth {
  requireThat(text.length <= 8192 && !/[\r\n\0]/.test(text.trim()), 'INVALID_BILI_COOKIE');
  const values = new Map<string, string>();
  for (const part of text.trim().split(';')) {
    const index = part.indexOf('='); if (index < 1) continue;
    const name = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (!['SESSDATA','bili_jct','DedeUserID','buvid3'].includes(name)) continue;
    requireThat(!values.has(name) && /^[\x21-\x7e]{1,4096}$/.test(value), 'INVALID_BILI_COOKIE');
    values.set(name, value);
  }
  const sessdata = values.get('SESSDATA'), csrf = values.get('bili_jct'), userId = biliId(values.get('DedeUserID'));
  requireThat(sessdata && csrf && /^[a-fA-F0-9]{32}$/.test(csrf) && userId, 'INVALID_BILI_COOKIE');
  return { sessdata, csrf, userId, buvid: values.get('buvid3') ?? null };
}

export async function loadBiliAuth(path: string): Promise<BiliAuth> {
  let file;
  try { file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw Error('BILI_COOKIE_FILE_UNAVAILABLE'); }
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.size <= 8192, 'INVALID_BILI_COOKIE_FILE');
    requireThat((stat.mode & 0o077) === 0, 'BILI_COOKIE_FILE_PERMISSIONS');
    return parseBiliCookie(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export function signBiliQuery(params: Record<string, string | number>, mixin: string, now = Date.now()): string {
  const values = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) =>
    `${encodeURIComponent(key)}=${encodeURIComponent(String(value).replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`;
}

export class BiliApi {
  #auth: BiliAuth;
  #request: typeof fetch;
  constructor(auth: BiliAuth, request = fetch) { this.#auth = { ...auth }; this.#request = request; }
  async #json(url: string, signal: AbortSignal, body?: string): Promise<Record<string, unknown>> {
    const a = this.#auth;
    const cookie = `SESSDATA=${a.sessdata}; bili_jct=${a.csrf}; DedeUserID=${a.userId}${a.buvid ? `; buvid3=${a.buvid}` : ''}`;
    const response = await this.#request(url, { redirect: 'error', cache: 'no-store', signal,
      headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/', Origin: 'https://live.bilibili.com', Cookie: cookie,
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(body !== undefined ? { method: 'POST', body } : {}) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(`BILI_HTTP_${response.status}`); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength; requireThat(length <= 128 * 1024, 'BILI_RESPONSE_SIZE'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    signal.throwIfAborted();
    let json;
    try { json = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* Never expose response text. */ }
    requireThat(json && Number.isInteger(json.code), 'BILI_RESPONSE_INVALID');
    return json;
  }
  async identity(signal: AbortSignal): Promise<BiliSession> {
    const json = await this.#json('https://api.bilibili.com/x/web-interface/nav', signal), data = record(json.data);
    requireThat(json.code === 0 && data?.isLogin === true, 'BILI_LOGIN_REQUIRED');
    const userId = biliId(data.mid);
    requireThat(userId && userId === this.#auth.userId, 'BILI_ACCOUNT_CHANGED');
    const images = record(data.wbi_img);
    const key = (url: unknown) => typeof url === 'string' ? /\/([a-f0-9]{32})\.[a-z]+(?:\?|$)/.exec(url)?.[1] : undefined;
    const img = key(images?.img_url), sub = key(images?.sub_url);
    requireThat(img && sub, 'BILI_SIGNING_UNAVAILABLE');
    if (!this.#auth.buvid) {
      const finger = await this.#json('https://api.bilibili.com/x/frontend/finger/spi', signal);
      const value = record(finger.data)?.b_3;
      requireThat(finger.code === 0 && typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'BILI_FINGERPRINT_UNAVAILABLE');
      this.#auth.buvid = value;
    }
    return { userId, buvid: this.#auth.buvid, mixin: MIXIN.map(i => (img + sub)[i]).join('').slice(0, 32) };
  }
  async room(input: string, session: BiliSession, signal: AbortSignal): Promise<BiliRoom> {
    requireThat(biliId(input), 'INVALID_BILI_ROOM');
    const info = await this.#json(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${input}`, signal);
    const roomId = biliId(record(info.data)?.room_id);
    requireThat(info.code === 0 && roomId, 'BILI_ROOM_UNAVAILABLE');
    const query = signBiliQuery({ id: roomId, type: 0, web_location: 444.8 }, session.mixin);
    const json = await this.#json(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`, signal);
    requireThat(json.code === 0, json.code === -352 || json.code === -403 ? 'BILI_ACCESS_DENIED' : 'BILI_ROOM_AUTH_FAILED');
    const data = record(json.data), token = data?.token, list = data?.host_list;
    requireThat(typeof token === 'string' && token.length > 0 && token.length <= 8192 && Array.isArray(list), 'BILI_ROOM_RESPONSE_INVALID');
    const hosts: string[] = [];
    for (const value of list.slice(0, 8)) {
      const item = record(value), host = item?.host, port = item?.wss_port;
      if (typeof host === 'string' && /^[a-z0-9-]+\.chat\.bilibili\.com$/.test(host) && (port === 443 || port === 2245))
        hosts.push(`wss://${host}:${port}/sub`);
    }
    requireThat(hosts.length > 0, 'BILI_HOST_UNAVAILABLE');
    return { roomId, hosts, token };
  }
  async send(roomId: string, userId: string, deliveryId: string, text: string, signal: AbortSignal) {
    requireThat(biliId(roomId) && text.trim().length > 0 && [...text].length <= 20, 'INVALID_BILI_REPLY');
    const session = await this.identity(signal);
    requireThat(session.userId === userId, 'BILI_ACCOUNT_CHANGED');
    signal.throwIfAborted();
    const params = { bubble: 0, msg: text, color: 16777215, mode: 1, fontsize: 25,
      rnd: Math.floor(Date.now() / 1000), roomid: roomId, csrf: this.#auth.csrf, csrf_token: this.#auth.csrf };
    const json = await this.#json('https://api.live.bilibili.com/msg/send', signal, signBiliQuery(params, session.mixin));
    if (json.code !== 0) return { deliveryId, status: 'rejected' as const };
    const data = record(json.data);
    let extra;
    try { extra = record(JSON.parse(String(record(data?.mode_info)?.extra))); } catch { /* An ambiguous success is not a published receipt. */ }
    const id = extra?.id_str;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ?
      { deliveryId, status: 'published' as const, receipt: id } : { deliveryId, status: 'uncertain' as const };
  }
}
