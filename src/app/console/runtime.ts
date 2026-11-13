import { invitation, invitationCount } from '../../application/live/recruitment.ts';
import { randomUUID } from 'node:crypto';
import type { StorageClient } from '../../adapters/storage/client.ts';
import type { DecisionMode, GameObservation, GameProjection } from '../../domain/game/types.ts';
import { canonical, digest, requireThat } from '../../domain/game/value.ts';
import { boolean, integer, object, oneOf, string, timestamp } from '../../schemas/game.ts';
import { defaultConfig, moderate, patchConfig, type LiveConfig } from '../../application/live/config.ts';
import { CommentaryService, commentaryText, type CommentaryPort } from '../../application/live/commentary.ts';
import { StrategyNarrator } from '../../application/live/strategy-narration.ts';
import type { DiscardArchive } from '../../application/live/explanation.ts';
import { Interaction, type BiliPort } from '../../application/live/interaction.ts';
import { SpeechController, type SpeechContent, type SpeechPort } from '../../application/live/speech.ts';
import type { loadReplay } from '../replay.ts';
import type { AutomationPort } from './automation.ts';
import { idleRelay, type RelayPort } from './relay.ts';
import { prepareRehearsal } from './rehearsal.ts';
import { HealthAnnouncements } from './health-announcements.ts';

type Fixture = Awaited<ReturnType<typeof loadReplay>>;
export type ConsoleSource = { kind: 'replay'; fixtures: Fixture[] } | { kind: 'follow'; sessionId: string };
type RunStatus = 'running' | 'paused' | 'stopping' | 'stopped' | 'faulted';
type Run = { id: string; status: RunStatus; controlEpoch: number; startedAt: string; sourceKey: string; matchIndex: number;
  completedMatches: number; stopAfterMatch: boolean; pendingMode: DecisionMode; pauseReason?: string };
type RuntimeState = { config: LiveConfig; configRevision: number; run: Run | null; relayEnabled?: boolean; displayReset?: { sourceKey: string; sessionIds: string[] } };
type Projection = Awaited<ReturnType<StorageClient['readProjection']>>;
type CommandName = keyof typeof fields;
type Command = {
  commandId: string; name: CommandName; sessionId: string | null;
  status: 'succeeded' | 'failed' | 'uncertain'; acceptedAt: string; updatedAt: string; completedAt?: string;
  result?: object; error?: ReturnType<typeof apiError>;
};

const fields = {
  'control.start': ['expectedConfigRevision'],
  'control.pause': ['sessionId'],
  'control.resume': ['sessionId', 'expectedControlEpoch'],
  'control.stop-after-match': ['sessionId'],
  'control.next-mode': ['sessionId', 'expectedControlEpoch', 'mode'],
  'control.end': ['sessionId', 'expectedControlEpoch'],
  'display.reset': ['sessionId'],
  'automation.set': ['sessionId', 'enabled'],
  'relay.set': ['sessionId', 'enabled'],
  'speech.clear': ['sessionId'],
  'speech.mute': ['sessionId', 'muted'],
  'config.patch': ['sessionId', 'expectedRevision', 'changes'],
} as const;
const configEffects = {
  run: 'immediate', persona: 'next-generation', moderation: 'immediate', interaction: 'immediate',
  speech: 'next-synthesis', models: 'next-generation', output: 'immediate', retention: 'next-cleanup',
} as const;

export const apiError = (code: string, effect: 'none' | 'applied' | 'unknown' = 'none',
  retry: 'none' | 'after-refresh' | 'after-recovery' = 'none') => ({ code, message: code, effect, retry });
export class ConsoleError extends Error {
  readonly status: number;
  readonly detail: ReturnType<typeof apiError>;
  constructor(status: number, code: string, effect?: 'none' | 'applied' | 'unknown', retry?: 'none' | 'after-refresh' | 'after-recovery') {
    super(code); this.status = status; this.detail = apiError(code, effect, retry);
  }
}
function requestBody(name: CommandName, input: unknown) {
  const p = object(input, ['commandId','issuedAt', ...fields[name]], name === 'control.pause' ? ['reason'] : []);
  string(p.commandId, 128); timestamp(p.issuedAt);
  if (Object.hasOwn(p, 'sessionId') && (p.sessionId !== null || name.startsWith('control.'))) string(p.sessionId, 128);
  for (const key of ['expectedRevision','expectedControlEpoch','expectedConfigRevision'])
    if (Object.hasOwn(p, key)) integer(p[key], 0, Number.MAX_SAFE_INTEGER);
  if (p.reason !== undefined) string(p.reason, 200);
  if (name === 'control.next-mode') oneOf(p.mode, ['engine','llm']);
  if (name === 'speech.mute') boolean(p.muted);
  if (name === 'automation.set' || name === 'relay.set') boolean(p.enabled);
  return p as Record<string, unknown> & { commandId: string; issuedAt: string };
}
export function commandName(path: string, method: string): CommandName | null {
  const name = method === 'PATCH' && path === '/api/config' ? 'config.patch' :
    method === 'POST' && /^\/api\/(control|speech|automation|relay|display)\/[a-z-]+$/.test(path) ? path.slice(5).replace('/', '.') : '';
  return Object.hasOwn(fields, name) ? name as CommandName : null;
}

export class ConsoleRuntime {
  readonly store: StorageClient;
  readonly source: ConsoleSource;
  readonly voices: { id: string; label: string; language: string; installed: boolean }[];
  readonly audioEnabled: boolean;
  readonly biliSendingEnabled: boolean;
  readonly speech: SpeechController;
  readonly interaction: Interaction;
  readonly commentary: CommentaryService;
  readonly narration: StrategyNarrator;
  readonly automation: AutomationPort | undefined;
  readonly relay: RelayPort | undefined;
  #state: RuntimeState;
  #version: number;
  #sourceKey: string;
  #replays: ReturnType<typeof prepareRehearsal>[];
  #tail: Promise<unknown> = Promise.resolve();
  #game: Projection = null;
  #archive: DiscardArchive[] = [];
  #archiveSession: string | null = null;
  #knownDiscards = new Set<string>();
  #recent: unknown[] = [];
  #subtitle: SpeechContent | null = null;
  #answer: SpeechContent | null = null;
  #nextCleanupAt = 0;
  #closed = false;
  #errorCode: string | null = null;
  #revisionAt = new Date().toISOString();
  #signature = '';
  #onChange = () => {};
  #recruitKey: string | null = null;
  #invitationIndex = 0;
  #usedInvitations = new Set<string>();
  #relayInitialized = false;
  #health = new HealthAnnouncements();

  private constructor(options: RuntimeOptions, version: number, saved: RuntimeState | null) {
    this.automation = options.automation;
    this.relay = options.relay;
    this.store = options.store; this.source = options.source; this.voices = options.voices;
    this.#sourceKey = digest(options.source.kind === 'replay' ?
      options.source.fixtures.map(f => [f.manifest.eventsSha256, f.manifest.sessionId, f.manifest.reducerVersion]) : ['follow', options.source.sessionId]);
    this.#version = version;
    this.#replays = options.source.kind === 'replay' ? options.source.fixtures.map(prepareRehearsal) : [];
    this.#state = saved ?? { configRevision: 0, run: null, config: defaultConfig(options.voiceId) };
    this.audioEnabled = !!options.speech;
    this.biliSendingEnabled = !!options.bili && options.bili.mode !== 'simulated';
    this.speech = new SpeechController(options.speech, () => this.config, () => this.#changed());
    this.commentary = new CommentaryService(this.store, options.commentary, () => ({ config: this.config, revision: this.configRevision }), () => this.#changed());
    this.narration = new StrategyNarrator(options.commentary, () => this.config, () => this.speech.view.queueEpoch, card => {
      if (this.#closed || this.#errorCode || this.automation?.view.status === 'recruiting' || card.handId !== this.#game?.projection.state?.handId ||
          this.#game?.recoveryRequired || this.#game?.projection.state?.trust !== 'trusted' ||
          this.#game?.projection.handStatus !== 'playing') return;
      if (this.#subtitle?.priority !== 'system' || Date.parse(this.#subtitle.expiresAt) <= Date.now()) this.#subtitle = card;
      this.speech.enqueue(card);
      this.#changed();
    });
    this.interaction = new Interaction(options.bili, this.store, () => this.config, (card, speechEpoch) => {
      this.#answer = card;
      if (speechEpoch === this.speech.view.queueEpoch) this.speech.enqueue(card);
      this.#changed();
    }, (question, archive, signal) => this.commentary.answer(question, archive, signal), () => this.speech.view.queueEpoch);
  }
  static async open(options: RuntimeOptions) {
    const { revision, body } = await options.store.readConsole();
    const runtime = new ConsoleRuntime(options, revision, body as RuntimeState | null);
    if (Object.hasOwn(runtime.config.run, 'maxMatches') || Object.hasOwn(runtime.config.run, 'maxDurationMs')) {
      await runtime.#save({ ...runtime.#state, configRevision: runtime.configRevision + 1,
        config: { ...runtime.config, run: { defaultMode: runtime.config.run.defaultMode } } });
    }
    if (runtime.config.models.commentaryIntervalMs === undefined) {
      await runtime.#save({ ...runtime.#state, configRevision: runtime.configRevision + 1,
        config: { ...runtime.config, models: { ...runtime.config.models,
          commentaryIntervalMs: defaultConfig(options.voiceId).models.commentaryIntervalMs } } });
    }
    if (runtime.config.speech.provider !== 'fish' ||
      options.voices.length > 0 && !options.voices.some(v => v.id === runtime.config.speech.voiceId)) {
      await runtime.#save({ ...runtime.#state, configRevision: runtime.configRevision + 1,
        config: { ...runtime.config, speech: { provider: 'fish', voiceId: options.voiceId } } });
    }
    const run = runtime.#state.run;
    if (run && run.status !== 'stopped') {
      requireThat(runtime.#sourceKey === run.sourceKey, 'REPLAY_SOURCE_CHANGED');
      await runtime.#save({ ...runtime.#state, run: { ...run, status: 'paused',
        controlEpoch: run.controlEpoch + 1, pauseReason: 'PROCESS_RECOVERY' } });
      await options.store.openReplaySession(runtime.#gameSession(run), run.id, run.startedAt);
    }
    runtime.#recent = await options.store.recentCommands();
    await runtime.#readGame(true);
    return runtime;
  }
  get config() { return this.#state.config; }
  get configRevision() { return this.#state.configRevision; }
  get sessionId() { return this.#state.run?.status !== 'stopped' ? this.#state.run?.id ?? null : null; }
  get gameSessionId() {
    const run = this.#state.run;
    if (this.source.kind !== 'follow') return run ? this.#gameSession(run) : null;
    const session = this.automation?.view.sessionId ?? this.source.sessionId;
    const reset = this.#state.displayReset;
    return reset?.sourceKey === this.#sourceKey && reset.sessionIds.includes(session) ? null : session;
  }
  #gameSession(run: Run) { return `${run.id}-match-${run.matchIndex}`; }
  onChange(listener: () => void) { this.#onChange = listener; }
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work);
    this.#tail = task.catch(() => {});
    return task;
  }
  async #save(state: RuntimeState, command?: { view: Command; fingerprint: string }) {
    this.#version = await this.store.saveConsole(this.#version, state, command ?
      { id: command.view.commandId, at: command.view.acceptedAt, fingerprint: command.fingerprint, body: command.view } : null);
    this.#state = state;
    if (command) this.#recent = [command.view, ...this.#recent].slice(0, 20);
  }
  async #readGame(skipHistory = false) {
    const session = this.gameSessionId, previous = this.#game;
    this.#game = session ? await this.store.readProjection(session) : null;
    const hand = this.#game?.projection.state?.handId ?? null;
    if (previous?.projection.state?.handId !== hand || previous?.projection.sessionId !== this.#game?.projection.sessionId ||
        this.#game?.recoveryRequired || this.#game?.projection.state?.trust !== 'trusted' ||
        this.#game?.projection.handStatus !== 'playing') this.narration.invalidate();
    this.speech.setHand(hand);
    if (this.#subtitle?.priority === 'discard' && this.#subtitle.handId !== hand) this.#subtitle = null;
    if (!session) {
      this.#archive = []; this.#archiveSession = null; this.#knownDiscards.clear();
      if(this.#subtitle?.priority === 'discard')this.#subtitle = null;
      this.#answer = null;
      return;
    }
    if (session === this.#archiveSession && previous?.projection.sequence === this.#game?.projection.sequence) return;
    this.#archive = await this.store.readDiscards(session);
    const liveReplay = this.source.kind === 'replay';
    const now = Date.now();
    const switched = session !== this.#archiveSession;
    if (switched) this.#knownDiscards.clear();
    if (!skipHistory && (!switched || liveReplay)) {
      for (const entry of this.#archive.slice().reverse()) {
        if (this.#knownDiscards.has(entry.id) || entry.handId !== hand || entry.recovered) continue;
        const at = liveReplay ? now : Date.parse(entry.fact.observedAt);
        if (at > now || now - at >= 20_000 || !this.#game || this.#game.recoveryRequired ||
            this.#game.projection.state?.trust !== 'trusted' || this.#game.projection.handStatus !== 'playing') continue;
        const text = moderate(entry.factText, this.config.moderation.rules);
        if (!text) continue;
        const card = { contentId: entry.id, handId: entry.handId, text: entry.factText, priority: 'discard' as const,
          createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 20_000).toISOString() };
        if (this.#subtitle?.priority !== 'system' || Date.parse(this.#subtitle.expiresAt) <= now) this.#subtitle = card;
        this.#narrateStrategy(entry, card);
      }
    }
    this.#knownDiscards = new Set(this.#archive.map(entry => entry.id));
    this.#archiveSession = session;
  }
  #narrateStrategy(entry: DiscardArchive, card: SpeechContent) {
    const state = this.#game?.projection.state;
    if (state) this.narration.update(state, this.#archive.filter(item => item.handId === entry.handId).slice(0, 6).map(item => item.factText), card);
  }

  async #commitReplay(run: Run, event: GameObservation, p: GameProjection) {
    const mode = event.type === 'HandStarted' || event.type === 'MatchStarted' ? run.pendingMode : null;
    return (await this.store.commitReplayEvent(p.sessionId, p.sequence, event, { revision: this.#version, mode })).projection;
  }
  async #startGame(run: Run) {
    const fixture = this.#replays[run.matchIndex];
    requireThat(fixture, 'REPLAY_EXHAUSTED');
    const session = this.#gameSession(run);
    let p = await this.store.openReplaySession(session, run.id, run.startedAt);
    while (p.matchStatus === 'none') {
      const event = fixture(p);
      requireThat(event, 'REPLAY_MATCH_NOT_STARTED');
      p = await this.#commitReplay(run, event, p);
    }
  }
  async #advance() {
    const current = this.#state.run;
    if (!current || current.status === 'stopped' || current.status === 'faulted' || this.source.kind !== 'replay') return;
    const run = current;
    if (run.status === 'paused') return;
    const game = await this.store.readProjection(this.#gameSession(run));
    requireThat(game && !game.recoveryRequired, 'REPLAY_CHECKPOINT_MISSING');
    const fixture = this.#replays[run.matchIndex]!;
    const p = game.projection;
    if (p.matchStatus === 'finished') {
      const completed = { ...run, completedMatches: run.completedMatches + 1 };
      const next = this.source.fixtures[run.matchIndex + 1];
      if (completed.stopAfterMatch || !next) await this.#save({ ...this.#state, run: { ...completed, status: 'stopped' } });
      else {
        const advance = { ...completed, matchIndex: run.matchIndex + 1 };
        await this.#startGame(advance);
        await this.#save({ ...this.#state, run: advance });
      }
    } else {
      const event = fixture(p);
      if (event) await this.#commitReplay(run, event, p);
      else await this.#save({ ...this.#state, run: { ...run, status: 'stopped', pauseReason: 'REPLAY_ENDED_WITHOUT_MATCH_RESULT' } });
    }
  }
  tick() {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      try {
        await this.automation?.refresh();
        await this.#startDefaultRelay();
        await this.relay?.refresh();
        if (!this.#errorCode) await this.#advance();
        await this.#readGame();
        this.#recruit();
        if (Date.now() >= this.#nextCleanupAt) {
          await this.store.cleanupOutput(new Date(Date.now() - this.config.retention.days * 86_400_000).toISOString());
          this.#nextCleanupAt = Date.now() + 3_600_000;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const previousError = this.#errorCode;
        this.#errorCode = /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : 'OUTPUT_LEDGER_UNAVAILABLE';
        if (previousError !== this.#errorCode) {
          this.narration.invalidate();
          this.speech.clearPending();
          await this.automation?.stop();
        }
      }
      this.#announceHealth();
      if (this.#errorCode) await this.interaction.stop();
      else if (this.source.kind === 'follow' || this.#archive.length) this.interaction.tick(this.#archive);
      this.#changed();
    });
  }
  async #startDefaultRelay() {
    if (this.#relayInitialized || !this.relay || this.source.kind !== 'follow') return;
    this.#relayInitialized = true;
    if (this.#state.relayEnabled !== false) await this.relay.start();
  }
  #announceHealth() {
    for (const card of this.#health.observe(this.automation?.view, this.relay?.view, this.#errorCode, Date.now())) {
      this.narration.invalidate();
      this.#subtitle = card;
      this.speech.enqueue(card);
    }
  }
  #recruit() {
    const view=this.automation?.view;
    const active=view?.enabled && view.status==='recruiting' && view.roomId && view.recruitUntil && Date.parse(view.recruitUntil)>Date.now();
    const key=active?`${view.roomId}/${view.recruitUntil}`:null;
    if(key!==this.#recruitKey){
      this.speech.cancelRecruitment();
      if(this.#subtitle?.priority==='recruitment')this.#subtitle=null;
      this.#recruitKey=key;this.#invitationIndex=0;this.#usedInvitations.clear();
    }
    if(!active || !this.audioEnabled || this.speech.busy || this.speech.view.muted || this.#invitationIndex>=invitationCount)return;
    let text=invitation(view.roomId!,this.#invitationIndex++);
    while(this.#usedInvitations.has(text) && this.#invitationIndex<invitationCount)text=invitation(view.roomId!,this.#invitationIndex++);
    if(this.#usedInvitations.has(text))return;
    this.#usedInvitations.add(text);
    const card:SpeechContent={contentId:`recruit-${randomUUID()}`,handId:null,text,priority:'recruitment',
      createdAt:new Date().toISOString(),expiresAt:view.recruitUntil!};
    if (this.#subtitle?.priority !== 'system' || Date.parse(this.#subtitle.expiresAt) <= Date.now()) this.#subtitle=card;
    this.speech.enqueue(card);
  }
  async close() {
    this.#closed = true;
    await this.#tail;
    await this.relay?.close();
    await this.automation?.close();
    await Promise.all([this.speech.setMuted(true), this.interaction.stop(), this.commentary.close(), this.narration.close()]);
  }

  command(name: CommandName, input: unknown): Promise<unknown> {
    return this.#enqueue(async () => {
      let p: ReturnType<typeof requestBody>;
      try { p = requestBody(name, input); } catch { throw new ConsoleError(422, 'VALIDATION_FAILED'); }
      const fingerprint = digest([name, p]);
      const prior = await this.store.readCommand(p.commandId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConsoleError(409, 'IDEMPOTENCY_CONFLICT');
        return prior.body;
      }
      const now = Date.now(), at = new Date(now).toISOString(), issued = Date.parse(p.issuedAt);
      if (issued < now - 300_000 || issued > now + 30_000) throw new ConsoleError(422, 'COMMAND_EXPIRED');
      const run = this.#state.run;
      if (Object.hasOwn(p, 'sessionId') && p.sessionId !== this.sessionId &&
          !(name === 'control.end' && run?.status === 'stopped' && p.sessionId === run.id))
        throw new ConsoleError(409, 'SESSION_MISMATCH', 'none', 'after-refresh');
      if (p.expectedControlEpoch !== undefined && p.expectedControlEpoch !== run?.controlEpoch)
        throw new ConsoleError(409, 'CONTROL_EPOCH_MISMATCH', 'none', 'after-refresh');
      if ((p.expectedRevision ?? p.expectedConfigRevision ?? this.configRevision) !== this.configRevision)
        throw new ConsoleError(409, 'CONFIG_REVISION_MISMATCH', 'none', 'after-refresh');
      if (name.startsWith('control.') && this.source.kind !== 'replay') throw new ConsoleError(409, 'UNSUPPORTED_CAPABILITY');
      if (this.#errorCode) throw new ConsoleError(503, 'STORAGE_UNAVAILABLE', 'none', 'after-recovery');
      let next = this.#state, result: object;
      switch (name) {
        case 'control.start': {
          if (this.sessionId) throw new ConsoleError(409, 'INVALID_STATE');
          const fresh: Run = { id: `replay-${digest([p.commandId, p.issuedAt, this.#sourceKey]).slice(0, 32)}`, status: 'running',
            controlEpoch: 0, startedAt: at, sourceKey: this.#sourceKey, matchIndex: 0, completedMatches: 0,
            pendingMode: this.config.run.defaultMode, stopAfterMatch: false };
          await this.#startGame(fresh);
          next = { ...next, run: fresh };
          result = this.#controlResult(fresh);
          break;
        }
        case 'control.pause': {
          requireThat(run, 'RUN_REQUIRED');
          const paused: Run = run.status === 'paused' ? run : { ...run, status: 'paused',
            controlEpoch: run.controlEpoch + 1, pauseReason: 'USER_PAUSED' };
          next = { ...next, run: paused };
          result = this.#controlResult(paused);
          break;
        }
        case 'control.resume': {
          if (run?.status !== 'paused') throw new ConsoleError(409, 'INVALID_STATE');
          const checkpoint = await this.store.readProjection(this.#gameSession(run));
          if (!checkpoint || checkpoint.recoveryRequired || checkpoint.projection.state?.trust === 'untrusted')
            throw new ConsoleError(409, 'RECOVERY_REQUIRED', 'none', 'after-recovery');
          const { pauseReason: _reason, ...rest } = run;
          const resumed: Run = { ...rest, status: rest.stopAfterMatch ? 'stopping' : 'running', controlEpoch: rest.controlEpoch + 1 };
          next = { ...next, run: resumed };
          result = this.#controlResult(resumed);
          break;
        }
        case 'control.stop-after-match': {
          requireThat(run, 'RUN_REQUIRED');
          const stopping: Run = { ...run, stopAfterMatch: true, status: run.status === 'running' ? 'stopping' : run.status };
          next = { ...next, run: stopping };
          result = this.#controlResult(stopping);
          break;
        }
        case 'control.end': {
          if (!run || !['paused','faulted','stopped'].includes(run.status)) throw new ConsoleError(409, 'INVALID_STATE');
          const stopped: Run = { ...run, status: 'stopped' };
          next = { ...next, run: stopped };
          result = this.#controlResult(stopped);
          break;
        }
        case 'control.next-mode': {
          if (!run || run.status === 'stopped') throw new ConsoleError(409, 'INVALID_STATE');
          const pendingMode = p.mode as DecisionMode;
          next = { ...next, run: { ...run, pendingMode } };
          result = { kind: 'next-mode', sessionId: run.id, pendingMode, activeMode: this.#game?.projection.state ? this.#game.projection.activeMode : null,
            currentHandId: this.#game?.projection.state?.handId ?? null, effective: 'next-hand' };
          break;
        }
        case 'config.patch': {
          let config: ReturnType<typeof patchConfig>;
          try { config = patchConfig(this.config, p.changes, this.voices.map(v => v.id)); }
          catch { throw new ConsoleError(422, 'VALIDATION_FAILED'); }
          if (config.groups.models && config.next.models.commentaryProfile !== this.config.models.commentaryProfile &&
              config.next.models.commentaryProfile === 'local' && !this.commentary.available)
            throw new ConsoleError(409, 'UNSUPPORTED_CAPABILITY');
          if (!config.next.interaction.dryRun && !this.biliSendingEnabled) throw new ConsoleError(409, 'UNSUPPORTED_CAPABILITY');
          next = { ...next, config: config.next, configRevision: this.configRevision + 1 };
          const effects = Object.entries(config.groups).map(([group, patch]) => ({
            group, effective: group === 'interaction' && this.config.interaction.roomId !== config.next.interaction.roomId ?
              'reconnecting' : configEffects[group as keyof typeof configEffects], fields: Object.keys(patch as object),
          }));
          result = { kind: 'config-updated', revision: next.configRevision, sessionId: this.sessionId, effects };
          break;
        }
        case 'display.reset': {
          if (this.source.kind !== 'follow') throw new ConsoleError(409, 'UNSUPPORTED_CAPABILITY');
          const automation = this.automation?.view;
          if (automation?.enabled || automation && ['starting','creating','recruiting','recovering','playing','waiting','stopping'].includes(automation.status))
            throw new ConsoleError(409, 'AUTOMATION_ACTIVE');
          next = { ...next, displayReset: { sourceKey: this.#sourceKey,
            sessionIds: [...new Set([this.source.sessionId, ...(automation?.sessionId ? [automation.sessionId] : [])])] } };
          result = { kind: 'display-reset', sessionId: null };
          break;
        }
        case 'relay.set': {
          if (!this.relay) throw new ConsoleError(409, 'UNSUPPORTED_CAPABILITY');
          this.#relayInitialized = true;
          if (p.enabled) await this.relay.start();
          else await this.relay.stop();
          next = { ...next, relayEnabled: p.enabled as boolean };
          result = { kind: 'relay-control', ...this.relay.view };
          break;
        }
        case 'automation.set': {
          if (!this.automation || this.source.kind !== 'follow') throw new ConsoleError(409, 'UNSUPPORTED_CAPABILITY');
          if (p.enabled) { await this.#startDefaultRelay(); await this.automation.start(); }
          else await this.automation.stop();
          result = { kind: 'automation-control', ...this.automation.view };
          break;
        }
        case 'speech.clear':
        case 'speech.mute': {
          this.narration.invalidate();
          const cancelledCount = name === 'speech.clear' ? this.speech.clearPending() : await this.speech.setMuted(p.muted as boolean);
          const { pendingCount: _pendingCount, ...view } = this.speech.view;
          result = { kind: 'speech-control', ...view, cancelledCount };
          break;
        }
      }
      const prev = this.config;
      const updatedAt = new Date().toISOString();
      const view: Command = { commandId: p.commandId, name, sessionId: next.run?.id && name === 'control.start' ? next.run.id : p.sessionId as string | null,
        status: 'succeeded', acceptedAt: at, updatedAt, completedAt: updatedAt, result };
      try { await this.#save(next, { view, fingerprint }); }
      catch {
        this.#errorCode = 'OUTPUT_LEDGER_UNAVAILABLE';
        await this.automation?.stop();
        this.narration.invalidate();
        this.speech.clearPending();
        this.#announceHealth();
        throw new ConsoleError(503, 'STORAGE_UNAVAILABLE', 'unknown', 'after-recovery');
      }
      if (name === 'display.reset') {
        this.narration.invalidate(); this.commentary.invalidate(); this.interaction.reset();
        this.#subtitle = null; this.#answer = null;
        this.speech.clearPending();
      }
      if (digest(prev.moderation) !== digest(this.config.moderation) || digest(prev.speech) !== digest(this.config.speech)) {
        this.speech.refreshPolicy();
        this.interaction.refreshPolicy();
      }
      if (digest([prev.moderation, prev.persona, prev.models.decisionProfile, prev.models.commentaryProfile]) !==
          digest([this.config.moderation, this.config.persona, this.config.models.decisionProfile, this.config.models.commentaryProfile])) {
        this.commentary.invalidate();
        this.narration.invalidate();
        this.interaction.refreshPolicy();
      }
      if (prev.models.commentaryIntervalMs !== this.config.models.commentaryIntervalMs) this.narration.refreshInterval();
      if (prev.interaction.roomId !== this.config.interaction.roomId) { this.interaction.reset(); this.#answer = null; }
      if (prev.interaction.dryRun !== this.config.interaction.dryRun) this.interaction.refreshPolicy();
      await this.#readGame();
      this.#changed();
      return view;
    });
  }
  #controlResult(run: Run) {
    return { kind: 'run-control', sessionId: run.id, status: run.status, controlEpoch: run.controlEpoch,
      stopAfterMatch: run.stopAfterMatch, clientAutoWin: 'unknown', clientMayAct: false, warnings: ['REPLAY_ONLY'] };
  }
  #card(content: SpeechContent | null) {
    if (!content || Date.parse(content.expiresAt) <= Date.now()) return null;
    const { contentId, handId, createdAt, expiresAt } = content, text = moderate(content.text, this.config.moderation.rules);
    return text ? { contentId, handId, createdAt, expiresAt, text } : null;
  }
  get projections() {
    const run = this.#state.run, g = this.#game, p = g?.projection, s = p?.state;
    const stale = this.source.kind === 'follow' && g && Date.now() - Date.parse(g.observedAt) > 30_000;
    const game = s && p && g ? {
      matchId: s.matchId, handId: s.handId, stateVersion: s.stateVersion, trust: g.recoveryRequired || stale ? 'syncing' : s.trust,
      trustIssues: [...s.trustIssues, ...(g.recoveryRequired || stale ? ['OBSERVATION_STALE'] : [])], ownSeat: s.ownSeat,
      dealer: s.dealer, roundWind: s.roundWind, seatWind: s.seatWind, handNumber: s.handNumber, honba: s.honba, riichiSticks: s.riichiSticks,
      doraIndicators: s.doraIndicators, doraTiles: s.doraTiles, tilesRemaining: s.tilesRemaining, observedAt: g.observedAt,
      handStatus: p.handStatus === 'finished' ? 'finished' : p.matchEndPending ? 'settling' : stale || run?.status === 'stopped' ? 'interrupted' : 'playing',
      ...(s.latestAction ? { latestAction: publicAction(s.latestAction) } : {}),
      ...(this.config.output.showScores ? { scores: Object.fromEntries(Object.entries(s.players).map(([seat, v]) => [seat, v.score])) } : {}),
    } : null;
    const status = run && this.#errorCode && run.status !== 'stopped' ? 'faulted' : run?.status ?? null;
    const activeMode = s ? p!.activeMode : null, pendingMode = run?.pendingMode ?? p?.pendingMode ?? null;
    const now = this.#revisionAt;
    return {
      console: {
        session: run ? { id: run.id, status, controlEpoch: run.controlEpoch, startedAt: run.startedAt,
          completedMatches: run.completedMatches, stopAfterMatch: run.stopAfterMatch, activeMode, pendingMode: run.pendingMode,
          ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}) } : null,
        automation: this.automation?.view ?? { available: false, enabled: false, status: 'idle', completedMatches: 0, sessionId: null },
        relay: this.relay?.view ?? idleRelay(),
        game, room: p?.room ? { ...p.room, status: p.matchStatus === 'playing' ? 'playing' : 'unknown' } : null,
        configRevision: this.configRevision, speech: this.speech.view, interaction: this.interaction.view,
        recentCommands: this.#recent,
        modules: [
          { module: 'game', status: this.source.kind === 'replay' ? 'degraded' : 'ready', updatedAt: now,
            ...(this.source.kind === 'replay' ? { errorCode: 'REPLAY_ONLY' } : {}) },
          { module: 'storage', status: this.#errorCode ? 'unavailable' : 'ready', updatedAt: now,
            ...(this.#errorCode ? { errorCode: this.#errorCode } : {}) },
          { module: 'models', status: !this.commentary.available || !this.commentary.view.enabled ? 'unavailable' :
            this.commentary.view.last?.source === 'fact-template' ? 'degraded' : 'ready', updatedAt: now,
            ...(this.commentary.view.last?.code ? { errorCode: this.commentary.view.last.code } : {}) },
          { module: 'tts', status: this.audioEnabled ? 'ready' : 'unavailable', updatedAt: now },
          { module: 'playback', status: this.speech.last?.outcome === 'failed' ? 'degraded' : this.audioEnabled ? 'ready' : 'unavailable', updatedAt: now },
          { module: 'bilibili', status: this.interaction.gap ? 'degraded' : this.interaction.view.connection === 'connected' ? 'ready' : 'unavailable',
            updatedAt: now, ...(this.interaction.gap ? { errorCode: 'MESSAGE_GAP' } : {}) },
        ],
      },
      obs: { automation: this.automation ? {enabled:this.automation.view.enabled,status:this.automation.view.status,roomId:this.automation.view.roomId ?? null,recruitUntil:this.automation.view.recruitUntil ?? null} : null, runStatus: status, activeMode, pendingMode, game, subtitle: this.#card(this.#subtitle),
        interaction: this.#card(this.#answer), theme: this.config.output.theme, muted: this.speech.view.muted },
    };
  }
  #changed() {
    const signature = canonical({ ...this.projections, delivery: this.interaction.lastDelivery, speech: this.speech.last, commentary: this.commentary.view, bili: this.interaction.sourceStatus });
    if (signature === this.#signature) return;
    this.#revisionAt = new Date().toISOString();
    this.#signature = canonical({ ...this.projections, delivery: this.interaction.lastDelivery, speech: this.speech.last, commentary: this.commentary.view, bili: this.interaction.sourceStatus });
    this.#onChange();
  }
  get configView() {
    return { revision: this.configRevision, values: this.config, readOnly: { players: 4, length: this.#game?.projection.room?.rules.length ?? 'south', displayTimeSetting: this.#game?.projection.room?.rules.displayTimeSetting ?? '300+0',
      protocolVersion: this.#game?.projection.room?.rules.protocolVersion ?? null, modelCredentialsConfigured: this.commentary.available,
      bilibiliCredentialsConfigured: this.biliSendingEnabled } };
  }
  get capabilities() {
    return { voices: this.voices, modelProfiles: this.commentary.available ? [{ id: 'local', purposes: ['explanation','viewer-answer'], configured: true, available: true }] : [], ttsProviders: [{ id: 'fish', available: this.audioEnabled }],
      game: { clientVersion: null, protocolVersion: this.configView.readOnly.protocolVersion,
        supportedActions: [], syncVerified: false, deadlineVerified: false } };
  }
  get outputStatus() { return { lastSpeech: this.speech.last, lastDelivery: this.interaction.lastDelivery, commentary: this.commentary.view,
    bilibili: this.interaction.sourceStatus, source: this.source.kind }; }
  async discards(sessionId: string) {
    return (await this.store.readDiscards(sessionId)).map(entry => ({
      id: entry.id, eventId: entry.eventId, sessionId: entry.sessionId, handId: entry.handId,
      decisionId: entry.decisionId, observedAt: entry.fact.observedAt,
      text: moderate(commentaryText(entry), this.config.moderation.rules), source: entry.commentary?.source ?? 'fact-template',
      evidenceIds: entry.commentary?.evidenceIds ?? [entry.eventId],
      limitations: (entry.commentary?.limitations ?? ['没有经过验证的牌理证据']).map(text => moderate(text, this.config.moderation.rules)).filter((text): text is string => text !== null),
      createdAt: entry.commentary?.createdAt ?? entry.fact.observedAt,
    }));
  }
}
interface RuntimeOptions {
  store: StorageClient; source: ConsoleSource; voices: ConsoleRuntime['voices']; voiceId: string; speech?: SpeechPort; bili?: BiliPort; commentary?: CommentaryPort; automation?: AutomationPort; relay?: RelayPort;
}
export function publicAction(action: NonNullable<NonNullable<NonNullable<Projection>['projection']['state']>['latestAction']>) {
  return { eventId: action.eventId, handId: action.handId, actor: action.actor,
    kind: action.kind === 'meld' ? action.meld?.kind ?? 'special' : action.riichiDeclaration ? 'riichi' : 'discard',
    tiles: action.tiles, origin: action.origin, observedAt: action.observedAt };
}
