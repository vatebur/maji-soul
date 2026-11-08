import type { StrategyRequest } from './strategy-narration.ts';
import type { StorageClient } from '../../adapters/storage/client.ts';
import { digest, requireThat } from '../../domain/game/value.ts';
import { moderate, type LiveConfig } from './config.ts';
import { historicalAnswer, locateHistoricalDiscard, type DiscardArchive } from './explanation.ts';
import { renderCommentary, validateCommentary, type CommentaryContext, type CommentaryRecord } from './commentary-contract.ts';

export interface CommentaryRequest {
  purpose: 'explanation' | 'viewer-answer';
  context: CommentaryContext;
  persona: LiveConfig['persona'];
  personaChoices: string[];
  question?: string;
}
export interface CommentaryPort {
  summarizeStrategy?(request: StrategyRequest, signal: AbortSignal): Promise<unknown>;
  generate(request: CommentaryRequest, signal: AbortSignal): Promise<unknown>;
  answerChat?(request: { question: string; persona: LiveConfig['persona']; recentDiscards: string[] }, signal: AbortSignal): Promise<unknown>;
}
type Settings = () => { config: LiveConfig; revision: number };
type Store = Pick<StorageClient, 'readCommentaryContext' | 'saveCommentary'>;
type Job = { entry: DiscardArchive; expiresAt: number; question: string | null; generation: number;
  resolve: (result: CommentaryRecord | null) => void; controller: AbortController; dispose: () => void };

export function commentaryText(entry: DiscardArchive, record: CommentaryRecord | null = entry.commentary): string {
  return record ? record.factText + record.personaText : entry.factText;
}

export class CommentaryService {
  readonly available: boolean;
  #provider: CommentaryPort | undefined;
  #store: Store;
  #settings: () => { config: LiveConfig; revision: number };
  #onChange: () => void;
  #generation = 0;
  #pending: Job[] = [];
  #active: Job | null = null;
  #task: Promise<void> | null = null;
  #chats = new Map<AbortController, Promise<string | null>>();
  #closed = false;
  #timeoutMs: number;
  #last: { source: 'llm' | 'fact-template'; code: string | null; archiveId: string; finishedAt: string } | null = null;

  constructor(store: Store, provider: CommentaryPort | undefined, settings: Settings, onChange: () => void,
    timeoutMs = 8000) {
    requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30_000, 'INVALID_COMMENTARY_TIMEOUT');
    this.#store = store; this.#provider = provider; this.available = !!provider;
    this.#settings = settings; this.#onChange = onChange; this.#timeoutMs = timeoutMs;
  }
  get view() {
    return { enabled: this.#settings().config.models.commentaryProfile === 'local', available: this.available,
      pendingCount: this.#pending.length, busy: this.#active !== null || this.#chats.size > 0, last: this.#last };
  }
  explain(entry: DiscardArchive, expiresAt: string): Promise<CommentaryRecord | null> {
    return this.#submit(entry, Date.parse(expiresAt), null);
  }
  async answer(question: string, archive: DiscardArchive[], signal: AbortSignal): Promise<string | null> {
    const found = locateHistoricalDiscard(question, archive);
    if ((found === null || found === '请指明要回顾的弃牌。') &&
        this.#settings().config.models.commentaryProfile === 'local' && this.#provider?.answerChat) {
      return this.#answerChat(question, archive, signal);
    }
    if (typeof found === 'string' || found === null) return found;
    const result = await this.#submit(found, Date.now() + 20_000, question, signal);
    signal.throwIfAborted();
    if (!result) {
      // A late confirmation can change the linked decision without a new game event.
      const context = found.commentary ? await this.#store.readCommentaryContext(found.id).catch(() => null) : null;
      signal.throwIfAborted();
      return found.commentary && found.commentary.contextHash === context?.contextHash ?
        `回顾，${commentaryText(found)}${found.commentary.limitations.join('')}` : historicalAnswer(question, archive);
    }
    return `回顾，${commentaryText(found, result)}${result.limitations.join('')}`;
  }
  invalidate() {
    this.#generation++;
    for (const controller of this.#chats.keys()) controller.abort();
    for (const job of this.#pending.splice(0)) { job.controller.abort(); job.dispose(); job.resolve(null); }
    this.#active?.controller.abort();
    this.#onChange();
  }
  async close() { this.#closed = true; this.invalidate(); await Promise.all([this.#task, ...this.#chats.values()]); }

  #answerChat(question: string, archive: DiscardArchive[], callerSignal: AbortSignal): Promise<string | null> {
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal, AbortSignal.timeout(this.#timeoutMs)]);
    const { config } = this.#settings();
    const policy = digest([config.models, config.persona, config.moderation]);
    const task = (async () => {
      try {
        if (this.#task) await abortable(this.#task, signal);
        signal.throwIfAborted();
        requireThat(!this.#closed, 'COMMENTARY_CANCELLED');
        const input = moderate(question, config.moderation.rules, 300);
        if (!input) return null;
        const raw = await abortable(this.#provider!.answerChat!({ question: input, persona: config.persona,
          recentDiscards: archive.slice(0, 3).map(entry => entry.factText) }, signal), signal);
        signal.throwIfAborted();
        requireThat(!this.#closed && policy === digest([
          this.#settings().config.models, this.#settings().config.persona, this.#settings().config.moderation,
        ]), 'COMMENTARY_CANCELLED');
        requireThat(raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
          Object.keys(raw).length === 1 && 'reply' in raw && typeof raw.reply === 'string' &&
          [...raw.reply].length > 0 && [...raw.reply].length <= 20, 'INVALID_COMMENTARY_CHAT');
        return moderate((raw as { reply: string }).reply, config.moderation.rules, 20);
      } catch {
        return null;
      }
    })().finally(() => { this.#chats.delete(controller); this.#schedule(); });
    this.#chats.set(controller, task);
    this.#active?.controller.abort();
    return task;
  }

  #submit(entry: DiscardArchive, expiresAt: number, question: string | null, signal?: AbortSignal): Promise<CommentaryRecord | null> {
    if (this.#closed || this.#settings().config.models.commentaryProfile !== 'local' || !this.#provider ||
        !Number.isFinite(expiresAt) || expiresAt <= Date.now() || signal?.aborted) return Promise.resolve(null);
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const promise = new Promise<CommentaryRecord | null>(resolve => {
      const job: Job = { entry: structuredClone(entry), expiresAt, question, generation: this.#generation, controller, resolve,
        dispose: () => signal?.removeEventListener('abort', cancel) };
      if (this.#pending.length >= 16) {
        const index = this.#pending.findIndex(item => item.question === null);
        const dropped = this.#pending.splice(Math.max(0, index), 1)[0]!;
        dropped.controller.abort(); dropped.dispose(); dropped.resolve(null);
      }
      this.#pending.push(job);
    });
    this.#schedule();
    return promise;
  }
  #schedule() {
    if (this.#task || this.#chats.size || this.#closed || !this.#pending.length) return;
    const viewer = this.#pending.findIndex(job => job.question !== null);
    const job = this.#pending.splice(Math.max(0, viewer), 1)[0]!;
    this.#active = job;
    this.#task = this.#run(job).then(job.resolve, () => job.resolve(null)).finally(() => {
      job.dispose(); this.#active = null; this.#task = null;
      this.#onChange(); this.#schedule();
    });
    this.#onChange();
  }
  async #run(job: Job): Promise<CommentaryRecord | null> {
    const { config, revision } = this.#settings();
    const policy = digest([config.models, config.persona, config.moderation]);
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(Math.max(1, Math.min(this.#timeoutMs, job.expiresAt - Date.now())))]);
    const check = () => {
      signal.throwIfAborted();
      const current = this.#settings().config;
      requireThat(!this.#closed && job.generation === this.#generation && Date.now() < job.expiresAt &&
        policy === digest([current.models, current.persona, current.moderation]), 'COMMENTARY_CANCELLED');
    };
    try {
      check();
      const context = await this.#store.readCommentaryContext(job.entry.id);
      check();
      requireThat(context, 'COMMENTARY_CONTEXT_MISSING');
      const personaChoices = config.persona.catchphrases.map(text => moderate(text, config.moderation.rules, 100)).filter((t): t is string => t !== null);
      const persona = { ...config.persona, name: moderate(config.persona.name, config.moderation.rules, 50) ?? '麻将搭子',
        style: moderate(config.persona.style, config.moderation.rules, 2000) ?? '', catchphrases: personaChoices };
      const request: CommentaryRequest = { purpose: job.question === null ? 'explanation' : 'viewer-answer', context, persona, personaChoices };
      if (job.question !== null) {
        const question = moderate(job.question, config.moderation.rules, 300);
        requireThat(question, 'COMMENTARY_INPUT_FILTERED');
        request.question = question;
      }
      const raw = await abortable(this.#provider!.generate(request, signal), signal);
      check();
      const selection = validateCommentary(raw, context, personaChoices);
      const rendered = renderCommentary(context, selection);
      requireThat(moderate(rendered.factText + rendered.personaText, config.moderation.rules), 'COMMENTARY_OUTPUT_FILTERED');
      const record = job.question === null ? await this.#store.saveCommentary({ id: job.entry.id, contextHash: context.contextHash,
        selection, personaChoices, configRevision: revision, at: new Date().toISOString() }) :
        { ...rendered, source: 'llm' as const, contextHash: context.contextHash, decisionId: context.decision?.id ?? null,
          claims: selection.claims, configRevision: revision, profileId: 'local' as const, createdAt: new Date().toISOString() };
      check();
      this.#last = { source: 'llm', archiveId: job.entry.id, code: null, finishedAt: new Date().toISOString() };
      return record;
    } catch (error) {
      // External error messages can contain URLs, credentials, or model content.
      const message = error instanceof Error ? error.message : '';
      const code = signal.aborted ? job.controller.signal.aborted ? 'COMMENTARY_CANCELLED' : 'MODEL_TIMEOUT' :
        /^(INVALID_COMMENTARY_[A-Z_]+|COMMENTARY_[A-Z_]+|INVALID_MODEL_[A-Z_]+|MODEL_RESPONSE_TOO_LARGE|MODEL_HTTP_[0-9]{3}|LIVE_CAPACITY_RESERVED)$/.test(message) ? message : 'COMMENTARY_UNAVAILABLE';
      this.#last = { source: 'fact-template', code, archiveId: job.entry.id, finishedAt: new Date().toISOString() };
      return null;
    }
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(Error('COMMENTARY_CANCELLED'));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
