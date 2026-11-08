import type { GameState } from '../../domain/game/types.ts';
import type { CommentaryPort } from './commentary.ts';
import { digest } from '../../domain/game/value.ts';
import { moderate, type LiveConfig } from './config.ts';
import type { SpeechContent } from './speech.ts';

export const STRATEGY_TIMEOUT_MS = 300_000;

export interface StrategyRequest {
  state: GameState;
  recentDiscards: string[];
  persona: LiveConfig['persona'];
}
type Pending = { request: StrategyRequest; card: SpeechContent; epoch: number };

/** Coalesce new observations; never turn a failed summary into action-by-action audio. */
export class StrategyNarrator {
  #pending: Pending | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | null = null;
  #task: Promise<void> | null = null;
  #lastStarted = 0;
  #lastText = '';
  #scope = '';
  private provider: CommentaryPort | undefined;
  private config: () => LiveConfig;
  private epoch: () => number;
  private emit: (card: SpeechContent) => void;
  private timing: { mergeMs: number; intervalMs?: number; timeoutMs: number };
  constructor(provider: CommentaryPort | undefined, config: () => LiveConfig,
    epoch: () => number, emit: (card: SpeechContent) => void,
    timing: { mergeMs: number; intervalMs?: number; timeoutMs: number } = { mergeMs: 1200, timeoutMs: STRATEGY_TIMEOUT_MS }) {
    this.provider = provider; this.config = config; this.epoch = epoch; this.emit = emit; this.timing = timing;
  }

  update(state: GameState, recentDiscards: string[], card: SpeechContent) {
    if (!this.provider?.summarizeStrategy || this.config().models.commentaryProfile !== 'local') return;
    const scope = `${state.sessionId}:${state.handId}`;
    if (scope !== this.#scope) { this.invalidate(); this.#scope = scope; this.#lastText = ''; this.#lastStarted = 0; }
    this.#pending = { request: structuredClone({ state, recentDiscards, persona: this.config().persona }), card, epoch: this.epoch() };
    this.#schedule();
  }
  invalidate() {
    clearTimeout(this.#timer); this.#timer = undefined; this.#pending = null; this.#controller?.abort();
  }
  refreshInterval() {
    clearTimeout(this.#timer); this.#timer = undefined;
    this.#schedule();
  }
  async close() { this.invalidate(); await this.#task; }
  #schedule() {
    if (this.#timer || this.#task || !this.#pending) return;
    const wait = Math.max(this.timing.mergeMs, this.#lastStarted + (this.timing.intervalMs ?? this.config().models.commentaryIntervalMs) - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const pending = this.#pending; this.#pending = null;
      if (!pending || pending.epoch !== this.epoch() || Date.parse(pending.card.expiresAt) <= Date.now()) return;
      this.#lastStarted = Date.now();
      this.#task = this.#run(pending).finally(() => { this.#task = null; this.#schedule(); });
    }, wait);
    this.#timer.unref();
  }
  async #run({ request, card, epoch }: Pending) {
    const controller = new AbortController(); this.#controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timing.timeoutMs)]);
    const config = this.config(), policy = digest([config.models.commentaryProfile, config.persona, config.moderation]);
    try {
      // Race the provider so an implementation ignoring cancellation cannot hold shutdown open.
      const raw = await new Promise<unknown>((resolve, reject) => {
        const cancel = () => reject(Error('STRATEGY_CANCELLED'));
        signal.addEventListener('abort', cancel, { once: true });
        this.provider!.summarizeStrategy!(request, signal).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', cancel));
        if (signal.aborted) cancel();
      });
      if (signal.aborted || epoch !== this.epoch() ||
          policy !== digest([this.config().models.commentaryProfile, this.config().persona, this.config().moderation])) return;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 ||
          !('summary' in raw) || typeof raw.summary !== 'string' || [...raw.summary].length > 160) return;
      const text = moderate(raw.summary, config.moderation.rules, 160);
      if (!text || text === this.#lastText) return;
      this.#lastText = text;
      // Generation may outlive the input card; give the completed summary its own playback window.
      const now = Date.now();
      this.emit({ ...card, text, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 20_000).toISOString() });
    } catch { /* Keep the factual archive; skip failed narration. */ }
    finally { if (this.#controller === controller) this.#controller = null; }
  }
}
