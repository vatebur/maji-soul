import { randomUUID } from 'node:crypto';
import { moderate, type LiveConfig } from './config.ts';

export interface SpeechPort {
  synthesize(text: string, voiceId: string, signal: AbortSignal): Promise<string>;
  play(artifact: string, signal: AbortSignal): Promise<void>;
  release(artifact: string): Promise<void>;
}
export interface SpeechContent {
  contentId: string;
  handId: string | null;
  text: string;
  createdAt: string;
  expiresAt: string;
  priority: 'discard' | 'viewer';
}
type Work = { id: string; entries: SpeechContent[]; controller: AbortController };
type Outcome = 'completed' | 'cancelled' | 'failed' | 'expired';

export class SpeechController {
  #port: SpeechPort | undefined;
  #config: () => LiveConfig;
  #onChange: () => void;
  #pending: SpeechContent[] = [];
  #work: Work | null = null;
  #playing: Work | null = null;
  #task: Promise<void> | null = null;
  #muted = false;
  #queueEpoch = 0;
  #playbackEpoch = 0;
  #handId: string | null = null;
  #last: { speechId: string; contentIds: string[]; outcome: Outcome; finishedAt: string } | null = null;
  constructor(port: SpeechPort | undefined, config: () => LiveConfig, onChange: () => void) {
    this.#port = port; this.#config = config; this.#onChange = onChange;
  }
  get last() { return this.#last; }
  get busy() { return this.#task !== null; }
  get view() {
    return { muted: this.#muted, queueEpoch: this.#queueEpoch, playbackEpoch: this.#playbackEpoch,
      playingSpeechId: this.#playing?.id ?? null, pendingCount: this.#pending.length + (this.#work && !this.#work.controller.signal.aborted ? 1 : 0) };
  }
  enqueue(content: SpeechContent) {
    if (!this.#port || this.#muted || Date.parse(content.expiresAt) <= Date.now()) return;
    if (this.#pending.length >= 24) {
      const discard = this.#pending.findIndex(c => c.priority === 'discard');
      if (discard < 0 && content.priority === 'discard') return;
      this.#pending.splice(Math.max(0, discard), 1);
    }
    this.#pending.push(content);
    if (content.priority === 'viewer' && this.#work?.entries.every(c => c.priority === 'discard')) this.#invalidateSynthesis(true);
    this.#onChange();
    this.#schedule();
  }
  setHand(handId: string | null) {
    if (handId === this.#handId) return;
    this.#handId = handId;
    if (this.#work?.entries.some(c => c.priority === 'discard')) this.#invalidateSynthesis(true);
  }
  refreshPolicy() {
    this.#invalidateSynthesis(true);
    if (this.#playing) { this.#playbackEpoch++; this.#playing.controller.abort(); }
    this.#onChange();
  }
  clearPending() {
    const count = this.#pending.length + (this.#work && !this.#work.controller.signal.aborted ? this.#work.entries.length : 0);
    this.#pending = [];
    this.#invalidateSynthesis(false);
    this.#onChange();
    return count;
  }
  async setMuted(muted: boolean) {
    if (this.#muted === muted) {
      if (muted) await this.#task;
      return 0;
    }
    this.#muted = muted;
    if (!muted) { this.#onChange(); return 0; }
    const count = this.clearPending() + (this.#playing?.entries.length ?? 0);
    this.#playbackEpoch++;
    this.#playing?.controller.abort();
    await this.#task;
    this.#onChange();
    return count;
  }
  #invalidateSynthesis(requeue: boolean) {
    this.#queueEpoch++;
    if (this.#work && !this.#work.controller.signal.aborted) {
      if (requeue) this.#pending = [...this.#work.entries, ...this.#pending].slice(0, 24);
      this.#work.controller.abort();
    }
  }
  #schedule() {
    if (this.#task || !this.#port || this.#muted || !this.#pending.length) return;
    this.#task = Promise.resolve().then(() => this.#next(this.#port!)).finally(() => {
      this.#task = null;
      this.#onChange();
      this.#schedule();
    });
  }
  async #next(port: SpeechPort) {
    this.#pending = this.#pending.filter(c => Date.parse(c.expiresAt) > Date.now());
    const viewer = this.#pending.findIndex(c => c.priority === 'viewer');
    const entries = viewer < 0 ? this.#pending.splice(0, 4) : this.#pending.splice(viewer, 1);
    if (!entries.length) return;
    const config = this.#config(), epoch = this.#queueEpoch;
    const text = moderate(entries.map(c => c.priority === 'discard' && c.handId !== this.#handId ?
      `上一局回顾，${c.text}` : c.text).join(''), config.moderation.rules);
    if (!text) return;
    const work = { id: randomUUID(), entries, controller: new AbortController() }, signal = work.controller.signal;
    this.#work = work;
    this.#onChange();
    let artifact: string | undefined, outcome: Outcome = 'failed';
    try {
      artifact = await port.synthesize(text, config.speech.voiceId, signal);
      if (epoch !== this.#queueEpoch || signal.aborted || this.#muted) { outcome = 'cancelled'; return; }
      if (entries.some(c => Date.parse(c.expiresAt) <= Date.now())) { outcome = 'expired'; return; }
      this.#work = null;
      this.#playing = work;
      this.#playbackEpoch++;
      this.#onChange();
      await port.play(artifact, signal);
      outcome = signal.aborted ? 'cancelled' : 'completed';
    } catch { outcome = signal.aborted ? 'cancelled' : 'failed'; }
    finally {
      this.#work = this.#playing = null;
      this.#last = { speechId: work.id, contentIds: entries.map(c => c.contentId), outcome, finishedAt: new Date().toISOString() };
      if (artifact) await port.release(artifact).catch(() => {});
    }
  }
}
