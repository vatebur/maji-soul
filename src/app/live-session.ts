import { GameCoordinator } from '../application/game/coordinator.ts';
import type { GameActor } from '../application/game/actor.ts';
import { bridgeCall, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import { handSourceStream, normalizeSyncGame } from '../adapters/majsoul/sync.ts';
import { normalizeAction, normalizeNewRound, normalizeMatchEnd } from '../adapters/majsoul/normalize.ts';
import { deriveSyncOperationTiming, type SyncCountdownEvidence } from '../adapters/majsoul/operation-timing.ts';
import type { AuthoritativeSync, FriendRoom, GameObservation } from '../domain/game/types.ts';
import { digest, requireThat } from '../domain/game/value.ts';

export interface LiveSegment { sync: AuthoritativeSync; subsequent: GameObservation[] }
const endNames = ['ActionHule','ActionNoTile','ActionLiuJu'];
const recoverableReasons = ['DISCONNECTED','CONNECTION_CHANGED','RECONNECT_REQUESTED'];
const recoverableAutoWinErrors = new Set(['AUTO_WIN_CDP_UNAVAILABLE','AUTO_WIN_PROFILE_UNVERIFIED','AUTO_WIN_VIEWPORT_MISMATCH',
  'AUTO_WIN_SCREENSHOT_INVALID','AUTO_WIN_SCREENSHOT_FORMAT','AUTO_WIN_SCREENSHOT_LIMIT','AUTO_WIN_READBACK_STALE',
  'AUTO_WIN_READBACK_UNKNOWN','AUTO_WIN_READBACK_FAILED','AUTO_WIN_UNVERIFIED','AUTO_WIN_TOGGLE_REQUIRES_PAUSE','AUTO_WIN_RECOVERY_NOT_READY']);
const autoWinProtocolErrors = new Set(['BRIDGE_MISSING','BRIDGE_UNTRUSTED','BRIDGE_QUEUE_OVERFLOW','EGO_RPC_TIMEOUT','EGO_PAGE_FAILED',
  'CONTROL_BARRIER_FAILED','PROCESS_INSTANCE_STALE','FENCE_STALE','SOURCE_STEP_GAP','DISCONNECTED','CONNECTION_CHANGED','RECONNECT_REQUESTED']);

export interface AutoWinRecovery {
  trigger: 'initial-sync' | 'reconnect' | 'new-hand'; status: 'pending' | 'verified' | 'unverified' | 'not-required'; attempted: boolean;
  connectionEpoch: number; gameHandKey: string; pageEpoch: number; sourceStream: number | null; step: number; generation: number;
  code: string | null;
  readback: {source:'unity-button-pixels-v1'|null;state:'enabled'|'disabled'|'unknown';observedAt:string|null;
    pageEpoch:number|null;generation:number|null;step:number|null;rgbaSha256:string|null;clicked:boolean} | null;
}

const diagnosticObject = (value: unknown): Record<string, any> => value !== null && typeof value==='object' && !Array.isArray(value) ? value : {};
const diagnosticNumber = (value: unknown): number | null => typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=Number.MAX_SAFE_INTEGER ? value : null;
function diagnosticTime(value: unknown): string | null {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function diagnosticRtt(requested: unknown, received: unknown): number | null {
  const start=diagnosticNumber(requested),end=diagnosticNumber(received);
  return start===null || end===null ? null : diagnosticNumber(end-start);
}

/** Reports only counters owned by the bridge, never arbitrary Page properties. */
export function summarizeBrowserStats(value: unknown) {
  const input=diagnosticObject(value);
  const counter=(key:string)=>Number.isSafeInteger(input[key]) && input[key]>=0 ? input[key] as number : null;
  const stats={clientRequests:counter('clientRequests'),bridgeSyncRequests:counter('bridgeSyncRequests'),
    bridgeActionSends:counter('bridgeActionSends'),clientWinRequests:counter('clientWinRequests'),authoritativeOwnWins:counter('authoritativeOwnWins')};
  return Object.values(stats).some(value=>value!==null) ? stats : null;
}

/** A collected sample is diagnostic evidence, not proof that its gate passed. */
function summarizeTimingAcquisition(value: unknown) {
  const acquisition=diagnosticObject(value),raw=diagnosticObject(acquisition.raw),evidence=diagnosticObject(acquisition.evidence);
  if (evidence.source!=='automatic-client-countdown' || !Array.isArray(evidence.samples)) return null;
  const restore=diagnosticObject(raw.game_restore);
  const last=diagnosticObject(Array.isArray(restore.actions) ? restore.actions.at(-1) : null);
  const payload=diagnosticObject(last.payload ?? last.data),operation=diagnosticObject(payload.operation);
  return {source:'automatic-client-countdown',verified:false,
    sync:{pageEpoch:diagnosticNumber(raw.pageEpoch),generation:diagnosticNumber(raw.generation),nextStep:diagnosticNumber(raw.step),
      requestedMonoMs:diagnosticNumber(raw.requestedMonoMs),receivedMonoMs:diagnosticNumber(raw.receivedMonoMs),receivedAt:diagnosticTime(raw.receivedAt),
      roundTripMs:diagnosticRtt(raw.requestedMonoMs,raw.receivedMonoMs),passedWaitingTime:diagnosticNumber(restore.passed_waiting_time),
      fixedMs:diagnosticNumber(operation.time_fixed),addMs:diagnosticNumber(operation.time_add)},
    sampleCount:evidence.samples.length,
    samples:evidence.samples.slice(0,8).map((value:unknown)=>{
      const sample=diagnosticObject(value);
      return {pageEpoch:diagnosticNumber(sample.pageEpoch),step:diagnosticNumber(sample.step),
        requestedMonoMs:diagnosticNumber(sample.requestedMonoMs),receivedMonoMs:diagnosticNumber(sample.receivedMonoMs),sampledAt:diagnosticTime(sample.sampledAt),
        roundTripMs:diagnosticRtt(sample.requestedMonoMs,sample.receivedMonoMs),passedWaitingTime:diagnosticNumber(sample.passedWaitingTime),
        fixedMs:diagnosticNumber(sample.fixedMs),addMs:diagnosticNumber(sample.addMs),displayedRemainingMs:diagnosticNumber(sample.displayedRemainingMs),
        displaySampledMonoMs:diagnosticNumber(sample.displaySampledMonoMs)};
    })};
}

/** Keeps a single actor and ledger across hand boundaries and socket recovery.
 * It observes and reconciles; only the separate executor can choose to send. */
export class LiveGameSession {
  readonly coordinator: GameCoordinator;
  readonly segments: LiveSegment[] = [];
  readonly counts = { handStarts:0, handEnds:0, matchEnds:0, reconnects:0 };
  #page: EgoPagePort;
  #room: FriendRoom;
  #gameUuid: string | null = null;
  #recovering = false;
  #pendingResult: any = null;
  #cursor: {generation:number;pageEpoch:number;lastStep:number|null} | null = null;
  #timingDiagnostics: ReturnType<typeof summarizeTimingAcquisition> = null;
  #browserStatsBefore: ReturnType<typeof summarizeBrowserStats> = null;
  #autoWinRecoveries: AutoWinRecovery[] = [];
  #pendingAutoWinRecovery: AutoWinRecovery | null = null;
  constructor(actor: GameActor, page: EgoPagePort, room: FriendRoom) {
    this.coordinator = new GameCoordinator(actor); this.#page = page; this.#room = room;
  }
  get recovering() { return this.#recovering; }
  get awaitingSettlement() { return this.#pendingResult !== null; }
  get actor() { return this.coordinator.actor; }
  get cursor() { return this.#cursor && {...this.#cursor}; }
  get diagnostics() { return structuredClone({timing:this.#timingDiagnostics,browserStatsBefore:this.#browserStatsBefore}); }
  get autoWinRecovery() { return structuredClone(this.#autoWinRecoveries.at(-1) ?? null); }
  get autoWinRecoveries() { return structuredClone(this.#autoWinRecoveries); }
  #rememberCursor(value: any) {
    this.#cursor = {generation:value.generation,pageEpoch:value.pageEpoch,lastStep:value.lastStep};
  }
  #handKey(gameMatchKey: string, opening: any): string {
    requireThat(typeof opening?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(opening.sha256),'HAND_IDENTITY_UNVERIFIED');
    return `hand-${digest([gameMatchKey,opening.sha256]).slice(0,32)}`;
  }
  async synchronize(collectExecutionProofs = true) {
    const recovering=this.#recovering;
    // A failed collection on reconnect cannot inherit an earlier proof.
    this.#timingDiagnostics=null;this.#browserStatsBefore=null;
    const token = this.actor.beginSync(); await this.actor.awaitControlBarrier();
    const acquisition = collectExecutionProofs ? await bridgeCall(this.#page,'automaticTiming')
      : {raw:await bridgeCall(this.#page,'sync'),evidence:null};
    this.#timingDiagnostics=summarizeTimingAcquisition(acquisition);
    const raw = acquisition.raw, pageState = await bridgeCall(this.#page,'read');
    this.#browserStatsBefore=summarizeBrowserStats(pageState.stats);
    requireThat(typeof pageState.gameUuid === 'string' && pageState.gameUuid.length > 0 && [0,1,2,3].includes(pageState.ownSeat),'GAME_IDENTITY_UNVERIFIED');
    requireThat(raw.gameUuid === undefined || raw.gameUuid === pageState.gameUuid,'SYNC_IDENTITY_CHANGED');
    requireThat(this.#gameUuid === null || this.#gameUuid === pageState.gameUuid,'OBSERVED_MATCH_CHANGED');
    const config = pageState.authSummary?.gameConfig;
    requireThat(config?.category === 1 && config.mode?.mode === 1 && config.mode.ai === true &&
      config.mode.detail_rule?.time_fixed === 300 && config.mode.detail_rule?.time_add === 0,'FRIEND_ROOM_READBACK_MISMATCH');
    const gameMatchKey = `game-${digest(pageState.gameUuid).slice(0,32)}`;
    const opening = raw.game_restore?.actions?.find((a:any)=>a.name==='ActionNewRound');
    requireThat(opening,'SYNC_HAND_START_REQUIRED');
    const gameHandKey = this.#handKey(gameMatchKey,opening.payload ?? opening.data);
    const handOrdinal = await this.coordinator.resolveHandOrdinal(gameMatchKey,gameHandKey);
    const terminal = raw.is_end || endNames.includes(raw.game_restore.actions.at(-1)?.name);
    const timingEvidence = terminal ? null : acquisition.evidence as SyncCountdownEvidence | null;
    const timing = timingEvidence ? deriveSyncOperationTiming(raw,token.connectionEpoch,timingEvidence) : undefined;
    if (timing && this.#timingDiagnostics) this.#timingDiagnostics.verified=true;
    await bridgeCall(this.#page,'ackSync',{generation:raw.generation,step:raw.step-1});
    let autoWinReadback: any = null;
    if (collectExecutionProofs && !terminal) {
      autoWinReadback = await bridgeCall(this.#page,'ensureAutoWin');
      requireThat(autoWinReadback.state === 'enabled' && autoWinReadback.pageEpoch === raw.pageEpoch,'AUTO_WIN_UNVERIFIED');
      if (timing) await bridgeCall(this.#page,'ackTiming',timing);
    }
    const room: FriendRoom = {...this.#room,autoWin:autoWinReadback ? 'verified-on':'unknown'};
    const sync = normalizeSyncGame(raw,{...token,sessionId:this.actor.projection.sessionId,room,gameMatchKey,gameHandKey,
      ownSeat:pageState.ownSeat,handOrdinal,receivedAt:raw.receivedAt,...(timing?{timing}:{})});
    await this.coordinator.applySync(sync);
    const cursor = await bridgeCall(this.#page,'drain');
    requireThat(!cursor.reason && !cursor.overflow && cursor.records.length === 0 && cursor.lastStep === raw.step-1,'SYNC_CAPTURE_RACE');
    this.#rememberCursor(cursor);
    this.#gameUuid = pageState.gameUuid;
    this.#recovering = false; this.#pendingResult = null;
    this.#pendingAutoWinRecovery = null;
    this.segments.push({sync,subsequent:[]});
    if (!collectExecutionProofs) await this.#restoreAutoWin(cursor,this.#recordAutoWinRecovery(cursor,!!terminal,recovering?'reconnect':'initial-sync'));
    return {sync,cursor,timing,timingEvidence,autoWinReadback};
  }
  #recordAutoWinRecovery(cursor:any,terminal:boolean,trigger:AutoWinRecovery['trigger']):AutoWinRecovery {
    const p=this.actor.projection;
    const recovery:AutoWinRecovery={trigger,status:terminal?'not-required':'pending',attempted:false,
      connectionEpoch:p.connectionEpoch,gameHandKey:p.gameHandKey!,pageEpoch:cursor.pageEpoch,
      sourceStream:diagnosticNumber(cursor.sourceStream),step:cursor.lastStep,generation:cursor.generation,code:null,readback:null};
    this.#autoWinRecoveries.push(recovery);
    return recovery;
  }
  async #restoreAutoWin(cursor:any,recovery:AutoWinRecovery) {
    if (recovery.status==='not-required') return;
    const p=this.actor.projection;
    requireThat(this.actor.control.paused && !this.actor.control.needsSync && p.state?.trust==='trusted','AUTO_WIN_RECOVERY_REQUIRES_SYNC');
    recovery.attempted=true;
    let fatal:unknown,failed=false;
    try {
      const argument=recovery.trigger==='new-hand' ? {purpose:'new-hand',expected:{pageEpoch:cursor.pageEpoch,
        sourceStream:cursor.sourceStream,generation:cursor.generation,step:cursor.lastStep}}
        : recovery.trigger==='reconnect' ? {purpose:'reconnect'} : undefined;
      const readback=await bridgeCall(this.#page,'ensureAutoWin',argument);
      recovery.readback={source:readback.source==='unity-button-pixels-v1'?'unity-button-pixels-v1':null,
        state:['enabled','disabled','unknown'].includes(readback.state)?readback.state:'unknown',observedAt:diagnosticTime(readback.observedAt),
        pageEpoch:diagnosticNumber(readback.pageEpoch),generation:diagnosticNumber(readback.generation),step:diagnosticNumber(readback.step),
        rgbaSha256:typeof readback.rgbaSha256==='string' && /^[a-f0-9]{64}$/.test(readback.rgbaSha256)?readback.rgbaSha256:null,
        clicked:readback.clicked===true};
      requireThat(readback.state==='enabled','AUTO_WIN_UNVERIFIED');
      requireThat(readback.pageEpoch===cursor.pageEpoch && readback.step===cursor.lastStep &&
        Number.isSafeInteger(readback.generation) && readback.generation>=cursor.generation,'AUTO_WIN_READBACK_STALE');
      recovery.status='verified';
    } catch(error) {
      const code=error instanceof Error?error.message:'';
      recovery.status='unverified';recovery.code=recoverableAutoWinErrors.has(code)||autoWinProtocolErrors.has(code)?code:'AUTO_WIN_RECOVERY_FAILED';
      if (!recoverableAutoWinErrors.has(code)) {
        fatal=autoWinProtocolErrors.has(code)?error:new Error('AUTO_WIN_RECOVERY_FAILED');failed=true;
      }
    }
    // The UI gesture can change generation or receive real game facts. Retain
    // those facts and close the cursor; do not recursively reconnect from here.
    const batch=await bridgeCall(this.#page,'drain');
    await this.#consumeBatch(batch,false);
    if (failed) throw fatal;
  }
  async #restorePendingHandAutoWin(batch:any) {
    const recovery=this.#pendingAutoWinRecovery,p=this.actor.projection;
    if (!recovery || recovery.status!=='pending' || recovery.connectionEpoch!==p.connectionEpoch || recovery.gameHandKey!==p.gameHandKey ||
      p.handStatus!=='playing' || p.matchStatus!=='playing' || p.matchEndPending || this.#pendingResult || this.#recovering ||
      !this.actor.control.paused || this.actor.control.needsSync || p.state?.trust!=='trusted') return;
    // SQLite ingress and the control barrier can outlast another page update.
    // Defer until that ingress has been drained; never toggle an older hand.
    const current=await bridgeCall(this.#page,'read');
    if (current.pageEpoch!==recovery.pageEpoch || diagnosticNumber(current.sourceStream)!==recovery.sourceStream ||
      current.pageEpoch!==batch.pageEpoch || current.sourceStream!==batch.sourceStream ||
      current.generation!==batch.generation || current.lastStep!==batch.lastStep ||
      !Number.isSafeInteger(current.sourceStream) || current.sourceStream<0 || !Number.isSafeInteger(current.lastStep) || current.lastStep<0 ||
      current.paused!==true || current.connected!==true || !current.freshConnection || current.handEnded || current.matchEnded ||
      current.reason || current.overflow || (current.queued ?? 0)!==0) return;
    // Wait through the opening animation and other seats' automatic actions.
    // This client offer only identifies a quiet UI opportunity; it does not
    // create an executable opening window or authorize any game action.
    const offered=current.operation?.value,operations=offered?.operation_list;
    if (current.operation?.step!==current.lastStep || offered?.seat!==p.state.ownSeat || !Array.isArray(operations) ||
      operations.length===0 || operations.some((operation:any)=>!Number.isSafeInteger(operation?.type) || operation.type<1 || operation.type>7)) return;
    recovery.generation=current.generation;recovery.step=current.lastStep;
    // One attempt per committed hand. A failure may follow a real click, so it
    // must not be retried merely because the next pump sees the same hand.
    this.#pendingAutoWinRecovery=null;
    await this.#restoreAutoWin(current,recovery);
  }
  #validateAutoWinRecovery(batch:any) {
    const recovery=this.#autoWinRecoveries.at(-1),proof=recovery?.readback;
    if (!recovery || recovery.status!=='verified' || !proof) return;
    const sameScope=batch.pageEpoch===recovery.pageEpoch && diagnosticNumber(batch.sourceStream)===recovery.sourceStream &&
      this.actor.projection.connectionEpoch===recovery.connectionEpoch && this.actor.projection.gameHandKey===recovery.gameHandKey &&
      batch.connected!==false && batch.freshConnection!==false && !batch.reason && !batch.overflow;
    const retained=batch.lastAutoWinReadback;
    const sameProof=retained?.state==='enabled' && ['pageEpoch','generation','step','observedAt','rgbaSha256'].every(key=>retained[key]===proof[key as keyof typeof proof]);
    if (!sameScope || Object.hasOwn(batch,'lastAutoWinReadback') && !sameProof || batch.generation!==proof.generation && !sameProof) {
      recovery.status='unverified';recovery.code='AUTO_WIN_READBACK_STALE';
    }
  }
  async #ingest(observations: GameObservation[]) {
    await this.coordinator.ingest(observations);
    this.segments.at(-1)!.subsequent.push(...observations);
    for (const event of observations) {
      if (event.type==='HandStarted') this.counts.handStarts++;
      if (event.type==='HandEnded') this.counts.handEnds++;
      if (event.type==='MatchEnded') this.counts.matchEnds++;
    }
  }
  async pump(): Promise<void> {
    const batch = await bridgeCall(this.#page,'drain');
    await this.#consumeBatch(batch,true);
  }
  async #consumeBatch(batch:any,allowSynchronization:boolean): Promise<void> {
    this.#rememberCursor(batch);
    this.#validateAutoWinRecovery(batch);
    requireThat(!batch.overflow,'BRIDGE_QUEUE_OVERFLOW');
    const disconnected = batch.records.some((r:any)=>r.kind==='disconnected');
    const reauthenticated = batch.records.some((r:any)=>r.kind==='auth-summary');
    if (batch.reason || disconnected || reauthenticated || this.#recovering) {
      requireThat(!batch.reason || recoverableReasons.includes(batch.reason),'BRIDGE_UNTRUSTED');
      if (!this.#recovering) { this.actor.failClosed('DISCONNECTED'); this.#recovering = true; }
      await this.actor.awaitControlBarrier();
      if (allowSynchronization && batch.connected === true && batch.freshConnection && batch.authSummary) {
        await this.synchronize(false); this.counts.reconnects++;
      }
      return;
    }
    const previousHand=this.actor.projection.gameHandKey;
    for (const record of batch.records) {
      requireThat(record.gameUuid === undefined || record.gameUuid === this.#gameUuid,'OBSERVED_MATCH_CHANGED');
      const projection = this.actor.projection;
      requireThat(projection.gameMatchKey && projection.gameHandKey && projection.state,'GAME_IDENTITY_UNVERIFIED');
      if (record.kind==='match-end') {
        if (record.handSha256) requireThat(this.#handKey(projection.gameMatchKey,{sha256:record.handSha256})===projection.gameHandKey,'OBSERVED_HAND_CHANGED');
        this.actor.pause();
        // Notification and settlement can race across client callback queues.
        requireThat(!this.#pendingResult || digest(this.#pendingResult.payload)===digest(record.payload),'MATCH_RESULT_CONFLICT');
        this.#pendingResult = record;
      } else {
        requireThat(record.kind==='action','BRIDGE_UNEXPECTED_RECORD');
        const boundary = record.name==='ActionNewRound' || endNames.includes(record.name);
        if (boundary) this.actor.suspendForBoundary();
        const gameHandKey = record.name==='ActionNewRound' ? this.#handKey(projection.gameMatchKey,record.payload) : projection.gameHandKey;
        if (record.handSha256) requireThat(this.#handKey(projection.gameMatchKey,{sha256:record.handSha256})===gameHandKey,'OBSERVED_HAND_CHANGED');
        const context = {projection,sourceStream:handSourceStream(projection.gameMatchKey,gameHandKey),step:record.step,
          receivedAt:record.receivedAt,connectionEpoch:projection.connectionEpoch};
        const observations = record.name==='ActionNewRound'
          ? normalizeNewRound(record.payload,{...context,ownSeat:projection.state.ownSeat,gameHandKey,
              handOrdinal:await this.coordinator.resolveHandOrdinal(projection.gameMatchKey,gameHandKey)})
          : normalizeAction(record.name,record.payload,context);
        await this.#ingest(observations);
      }
      if (this.#pendingResult && this.actor.projection.handStatus==='finished') {
        const result = this.#pendingResult;
        await this.#ingest(normalizeMatchEnd(result.payload,{projection:this.actor.projection,
          connectionEpoch:this.actor.projection.connectionEpoch,receivedAt:result.receivedAt}));
        this.#pendingResult = null;
      }
    }
    this.#validateAutoWinRecovery(batch);
    const p=this.actor.projection,terminal=p.handStatus==='finished' || p.matchStatus==='finished';
    if (this.#pendingAutoWinRecovery && (terminal || this.#pendingAutoWinRecovery.gameHandKey!==p.gameHandKey)) {
      this.#pendingAutoWinRecovery.status='not-required';this.#pendingAutoWinRecovery=null;
    }
    if (p.gameHandKey!==previousHand) {
      // Publish pending immediately: a prior hand's verified/not-required result
      // (or no initial recovery record) cannot make this hand pass observation.
      const recovery=this.#recordAutoWinRecovery(batch,terminal,'new-hand');
      this.#pendingAutoWinRecovery=terminal?null:recovery;
    }
    await this.actor.awaitControlBarrier();
    if (allowSynchronization) await this.#restorePendingHandAutoWin(batch);
  }
}
