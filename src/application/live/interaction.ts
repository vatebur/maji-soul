import { digest, requireThat } from '../../domain/game/value.ts';
import { array, object, string, timestamp } from '../../schemas/game.ts';
import type { StorageClient } from '../../adapters/storage/client.ts';
import { moderate, type LiveConfig } from './config.ts';
import { historicalAnswer, type DiscardArchive } from './explanation.ts';
import type { SpeechContent } from './speech.ts';
import { formatSpokenText, spokenSentences } from './spoken-text.ts';

export interface BiliPort {
  readonly mode: 'simulated' | 'relay' | 'direct';
  readonly status?: { connection: 'disconnected' | 'connecting' | 'connected' | 'recovering'; roomId: string | null;
    accountId: string | null; receivedCount: number; droppedCount: number; gap: boolean; errorCode: string | null };
  disconnect?(): void;
  read(roomId: string, after: string | null, signal: AbortSignal): Promise<unknown>;
  send(roomId: string, senderId: string, deliveryId: string, text: string, signal: AbortSignal): Promise<unknown>;
}
type DeliveryStore = Pick<StorageClient, 'reserveDelivery' | 'finishDelivery' | 'markViewerSeen'>;
interface Incoming {
  roomId: string; messageId: string; viewerId: string; displayName: string; text: string; sourceAt?: string;
}
function parseIncoming(input: unknown, roomId: string): Incoming {
  const message = object(input, ['roomId','messageId','viewerId','displayName','text'], ['sourceAt']);
  requireThat(message.roomId === roomId, 'BILI_ROOM_MISMATCH');
  string(message.messageId, 256); string(message.viewerId, 128); string(message.displayName, 120); string(message.text, 500);
  if (message.sourceAt !== undefined) timestamp(message.sourceAt);
  return message as unknown as Incoming;
}
export class Interaction {
  #port: BiliPort | undefined;
  #store: DeliveryStore;
  #config: () => LiveConfig;
  #onContent: (card: SpeechContent, speechEpoch: number) => void;
  #speechEpoch: () => number;
  #answer: (question: string, archive: DiscardArchive[], signal: AbortSignal) => Promise<string | null>;
  #roomId: string | null = null;
  #senderId: string | null = null;
  #cursor: string | null = null;
  #connection: 'disconnected' | 'connecting' | 'connected' | 'recovering' = 'disconnected';
  #cancel = new AbortController();
  #pending: { message: Incoming; received: number }[] = [];
  #lastViewer = new Map<string, number>();
  #nextSelectionAt = 0;
  #nextReadAt = 0;
  #backoff = 500;
  #task: Promise<void> | null = null;
  #gap = false;
  #lastDelivery: { deliveryId: string; status: string } | null = null;
  constructor(port: BiliPort | undefined, store: DeliveryStore, config: () => LiveConfig, onContent: (card: SpeechContent, speechEpoch: number) => void,
    answer = async (question: string, archive: DiscardArchive[], _signal: AbortSignal) => historicalAnswer(question, archive),
    speechEpoch = () => 0) {
    this.#port = port; this.#store = store; this.#config = config; this.#onContent = onContent; this.#answer = answer;
    this.#speechEpoch = speechEpoch;
  }
  get gap() { return this.#gap || (this.#port?.status?.gap ?? false); }
  get lastDelivery() { return this.#lastDelivery; }
  get sourceStatus() { return { mode: this.#port?.mode ?? 'unavailable', ...(this.#port?.status ?? {}) }; }
  get view() {
    const settings = this.#config().interaction;
    return { roomId: settings.roomId, connection: this.#port?.status?.connection ?? this.#connection,
      identity: this.#senderId && (!this.#port?.status || this.#port.status.connection === 'connected' &&
        this.#port.status.accountId === this.#senderId) ? 'verified' : this.#port ? 'unknown' : 'unavailable',
      dryRun: settings.dryRun || !this.#port || this.#port.mode === 'simulated', pendingCount: this.#pending.length };
  }
  reset() {
    this.#port?.disconnect?.();
    this.#cancel.abort();
    this.#cancel = new AbortController();
    this.#roomId = this.#senderId = this.#cursor = null;
    this.#connection = 'disconnected';
    this.#pending = [];
    this.#lastViewer.clear();
    this.#nextReadAt = this.#nextSelectionAt = 0;
    this.#backoff = 500;
    this.#gap = false;
    this.#lastDelivery = null;
  }
  refreshPolicy() {
    this.#cancel.abort();
    this.#cancel = new AbortController();
  }
  tick(archive: DiscardArchive[]) {
    const roomId = this.#config().interaction.roomId;
    if (roomId !== this.#roomId) { this.reset(); this.#roomId = roomId; }
    if (!this.#port || !roomId || this.#task) return;
    const port = this.#port, signal = this.#cancel.signal;
    this.#task = this.#poll(port, roomId, signal, archive).catch(() => {
      if (signal.aborted) return;
      this.#connection = 'recovering';
      this.#nextReadAt = Date.now() + this.#backoff;
      this.#backoff = Math.min(15_000, this.#backoff * 2);
    }).finally(() => { this.#task = null; });
  }
  async stop() { this.reset(); await this.#task; }
  async #poll(port: BiliPort, roomId: string, signal: AbortSignal, archive: DiscardArchive[]) {
    if (Date.now() < this.#nextReadAt) return;
    if (this.#connection === 'disconnected') this.#connection = 'connecting';
    const page = object(await port.read(roomId, this.#cursor, AbortSignal.any([signal, AbortSignal.timeout(port.mode === 'direct' ? 15_000 : 4000)])),
      ['roomId','senderId','cursor','gap','messages']);
    signal.throwIfAborted();
    requireThat(page.roomId === roomId && typeof page.gap === 'boolean', 'INVALID_BILI_PAGE');
    string(page.senderId, 128); string(page.cursor, 256);
    array(page.messages, () => {}, 50);
    const messages = page.messages.map(m => parseIncoming(m, roomId));
    if (this.#senderId !== null && page.senderId !== this.#senderId) {
      this.#pending = [];
      this.#lastViewer.clear();
    }
    this.#senderId = page.senderId;
    this.#connection = 'connected';
    this.#gap ||= page.gap;
    this.#backoff = 500;
    this.#nextReadAt = Date.now() + 500;
    for (const message of messages) {
      const now = Date.now(), sourceAt = message.sourceAt ? Date.parse(message.sourceAt) : now;
      if (message.viewerId === this.#senderId || sourceAt > now + 30_000 || sourceAt <= now - 30_000) continue;
      const key = digest(['bili', port.mode, roomId, message.messageId]);
      if (!await this.#store.markViewerSeen(key, new Date().toISOString())) continue;
      signal.throwIfAborted();
      const rules = this.#config().moderation.rules;
      const name = moderate(message.displayName, rules, 50), text = moderate(message.text, rules, 300);
      if (name && text) {
        if (this.#pending.length >= 50) this.#pending.shift();
        this.#pending.push({ message: { ...message, displayName: name, text }, received: Math.min(now, sourceAt) });
      }
    }
    this.#cursor = page.cursor;
    await this.#select(port, roomId, page.senderId, signal, archive);
  }
  async #select(port: BiliPort, roomId: string, sender: string, signal: AbortSignal, archive: DiscardArchive[]) {
    const config = this.#config(), now = Date.now();
    const policy = digest([config.interaction, config.moderation]);
    this.#pending = this.#pending.filter(entry => now - entry.received < 30_000);
    for (const [id, at] of this.#lastViewer) if (now - at > 600_000) this.#lastViewer.delete(id);
    if (now < this.#nextSelectionAt) return;
    while (this.#pending.length) {
      const { message, received } = this.#pending.shift()!;
      if (now - (this.#lastViewer.get(message.viewerId) ?? -Infinity) < config.interaction.viewerCooldownMs) continue;
      const rules = config.moderation.rules;
      const name = moderate(message.displayName, rules, 50), question = moderate(message.text, rules, 300);
      if (!name || !question) continue;
      const speechEpoch = this.#speechEpoch();
      const answer = await this.#answer(question, structuredClone(archive), signal);
      signal.throwIfAborted();
      if (!answer || Date.now() - received >= 30_000) continue;
      const phrase = config.models.commentaryProfile === 'local' ? undefined : config.persona.catchphrases[0];
      const filtered = moderate(`${phrase ? phrase + ' ' : ''}${answer}`, rules);
      const text = filtered && moderate(formatSpokenText(filtered), rules, 4096);
      if (!text) continue;
      const selectedAt = Date.now();
      this.#nextSelectionAt = selectedAt + this.#config().interaction.globalIntervalMs;
      this.#lastViewer.set(message.viewerId, selectedAt);
      const contentId = `answer-${digest([port.mode, roomId, message.messageId])}`;
      const card = { contentId, text, handId: null, priority: 'viewer' as const,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 20_000).toISOString() };
      this.#onContent(card, speechEpoch);
      // Only a selected viewer message can trigger a text reply; playback never sends chat.
      await this.#reply(port, roomId, sender, signal, { ...card, text: spokenSentences(text)[0]! }, policy);
      return;
    }
  }
  async #reply(port: BiliPort, roomId: string, sender: string, signal: AbortSignal, card: SpeechContent, policy: string) {
    const id = `reply-${card.contentId}`;
    if (!await this.#store.reserveDelivery(id, card.createdAt)) return;
    let status: 'published' | 'simulated' | 'blocked' | 'expired' | 'uncertain' | 'failed' = 'blocked';
    const config = this.#config();
    const text = moderate(card.text, config.moderation.rules, Math.min(config.interaction.replyMaxChars, port.mode === 'direct' ? 20 : 100));
    if (Date.now() >= Date.parse(card.expiresAt)) status = 'expired';
    else if (!signal.aborted && policy === digest([config.interaction, config.moderation]) &&
        this.#roomId === roomId && this.#senderId === sender && config.interaction.roomId === roomId && text) {
      if (config.interaction.dryRun || port.mode === 'simulated') status = 'simulated';
      else {
        status = 'uncertain';
        try {
          const result = object(await port.send(roomId, sender, id, text, AbortSignal.any([signal, AbortSignal.timeout(4000)])),
            ['deliveryId','status'], ['receipt']);
          if (result.deliveryId === id && result.status === 'published') {
            string(result.receipt, 256);
            status = 'published';
          } else if (result.deliveryId === id && result.status === 'rejected') status = 'failed';
        } catch { /* A request with unknown effect is never repeated. */ }
      }
    }
    await this.#store.finishDelivery(id, status);
    if (!signal.aborted) this.#lastDelivery = { deliveryId: id, status };
  }
}
