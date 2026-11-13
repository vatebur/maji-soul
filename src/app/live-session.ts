import { GameCoordinator } from '../application/game/coordinator.ts';
import type { GameActor } from '../application/game/actor.ts';
import { bridgeCall, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import { handSourceStream, normalizeSyncGame } from '../adapters/majsoul/sync.ts';
import { normalizeAction, normalizeNewRound, normalizeMatchEnd } from '../adapters/majsoul/normalize.ts';
import { deriveSyncOperationTiming, type SyncCountdownEvidence } from '../adapters/majsoul/operation-timing.ts';
import type { AuthoritativeSync, FriendRoom, GameObservation, GameProjection } from '../domain/game/types.ts';
import { digest, requireThat } from '../domain/game/value.ts';
import { roomClockSeconds } from '../domain/game/room-clock.ts';

export interface LiveSegment { sync: AuthoritativeSync; subsequent: GameObservation[] }
interface TimingRejectionScope {
  page: any; projection: GameProjection; controlEpoch: number;
  cursor: {generation:number;pageEpoch:number;lastStep:number|null};
}
const unverifiedTimingCodes = new Set(['COUNTDOWN_PROTOCOL_MISMATCH','COUNTDOWN_BANK_MISMATCH']);
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
  readonly forcedRiichiDiscards = new Set<string>();
  /** Authoritative tsumogiri following a skipped offer; never program confirmations. */
  readonly expiredWindowDiscards = new Set<string>();
  readonly unverifiedTimingWindowDiscards = new Set<string>();
  readonly counts = { handStarts:0, handEnds:0, matchEnds:0, reconnects:0 };
  #page: EgoPagePort;
  #room: FriendRoom;
  #akagi: boolean;
  #gameUuid: string | null = null;
  #recovering = false;
  #nativeRestoreDeadline: number | null = null;
  #pendingResult: any = null;
  #cursor: {generation:number;pageEpoch:number;lastStep:number|null} | null = null;
  #settlementDiagnostics: {name:string;step:number;before:number[];payload:Record<string,unknown>} | null = null;
  #timingDiagnostics: ReturnType<typeof summarizeTimingAcquisition> = null;
  #browserStatsBefore: ReturnType<typeof summarizeBrowserStats> = null;
  #autoWinRecoveries: AutoWinRecovery[] = [];
  #pendingAutoWinRecovery: AutoWinRecovery | null = null;
  // This selects the read-only sampling path, never authorizes an action.
  // An expired window loses its timing/room proof, but does not recreate the
  // Unity toolbar. Keep that distinction scoped to the actual native restore.
  #autoWinReadOnlyScope: { pageEpoch:number; sourceStream:number; gameUuid:string;
    gameHandKey:string; nativeRestoreRevision:number } | null = null;
  #expiredWindow: { gameHandKey: string; sourceCursor: string; tile: string; reason:'expired'|'unverified-timing' } | null = null;
  #rejectedTiming: {error:Error;scope:TimingRejectionScope} | null = null;
  #unverifiedTimingWindow: TimingRejectionScope | null = null;
  #closingUnverifiedTiming = false;
  constructor(actor: GameActor, page: EgoPagePort, room: FriendRoom, akagi = false) {
    this.coordinator = new GameCoordinator(actor); this.#page = page; this.#room = room; this.#akagi = akagi;
  }
  get recovering() { return this.#recovering; }
  get awaitingSettlement() { return this.#pendingResult !== null; }
  get actor() { return this.coordinator.actor; }
  get cursor() { return this.#cursor && {...this.#cursor}; }
  get diagnostics() { return structuredClone({timing:this.#timingDiagnostics,browserStatsBefore:this.#browserStatsBefore,settlement:this.#settlementDiagnostics}); }
  get autoWinRecovery() { return structuredClone(this.#autoWinRecoveries.at(-1) ?? null); }
  get autoWinRecoveries() { return structuredClone(this.#autoWinRecoveries); }
  #rememberCursor(value: any) {
    this.#cursor = {generation:value.generation,pageEpoch:value.pageEpoch,lastStep:value.lastStep};
  }
  #rememberAutoWinReadOnlyScope(scope:any,readback:any,gameHandKey:string) {
    if (readback?.state!=='enabled' || readback.pageEpoch!==scope.pageEpoch ||
      !Number.isSafeInteger(scope.sourceStream) || scope.sourceStream<0 || typeof scope.gameUuid!=='string' ||
      !Number.isSafeInteger(scope.nativeRestoreRevision) || scope.nativeRestoreRevision<0 ||
      readback.nativeRestoreRevision!==scope.nativeRestoreRevision) return;
    this.#autoWinReadOnlyScope={pageEpoch:scope.pageEpoch,sourceStream:scope.sourceStream,gameUuid:scope.gameUuid,
      gameHandKey,nativeRestoreRevision:scope.nativeRestoreRevision};
  }
  #handKey(gameMatchKey: string, opening: any): string {
    requireThat(typeof opening?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(opening.sha256),'HAND_IDENTITY_UNVERIFIED');
    return `hand-${digest([gameMatchKey,opening.sha256]).slice(0,32)}`;
  }
  async synchronize(collectExecutionProofs = true, refreshWindow = false) {
    this.#rejectedTiming = null;
    const expected = refreshWindow ? this.cursor : null;
    if (refreshWindow) {
      requireThat(this.#akagi && expected && collectExecutionProofs, 'AKAGI_WINDOW_CHANGED');
      // Sampling may race a higher-priority call from another seat. Keep the
      // committed actor usable for ingest until the page acknowledges this exact
      // scope. The page and actor both remain paused throughout sampling.
      this.actor.suspendForBoundary();
    }

    const recovering=this.#recovering;
    // A failed collection on reconnect cannot inherit an earlier proof.
    this.#timingDiagnostics=null;this.#browserStatsBefore=null;
    let token = refreshWindow ? undefined : this.actor.beginSync();
    await this.actor.awaitControlBarrier();
    // Keep a real pre-collection read, independent of rejected pixel evidence.
    // It can authorize only abandoning this window, never an action or deadline.
    const rejectionScope = expected ? {page:await bridgeCall(this.#page,'read'),projection:this.actor.projection,
      controlEpoch:this.actor.control.controlEpoch,cursor:expected} : null;
    const rememberTimingRejection = (error:unknown) => {
      if (rejectionScope && error instanceof Error && unverifiedTimingCodes.has(error.message))
        this.#rejectedTiming={error,scope:rejectionScope};
    };
    let acquisition;
    try { acquisition = collectExecutionProofs ? await bridgeCall(this.#page,'automaticTiming')
      : {raw:await bridgeCall(this.#page,'sync'),evidence:null}; }
    catch(error) { rememberTimingRejection(error); throw error; }
    this.#timingDiagnostics=summarizeTimingAcquisition(acquisition);
    const raw = acquisition.raw, pageState = await bridgeCall(this.#page,'read');
    this.#browserStatsBefore=summarizeBrowserStats(pageState.stats);
    if (expected) {
      requireThat(pageState.pageEpoch === expected.pageEpoch && pageState.generation === expected.generation &&
        pageState.lastStep === expected.lastStep && raw.step - 1 === expected.lastStep &&
        !pageState.reason && !pageState.overflow && pageState.queued === 0, 'AKAGI_WINDOW_CHANGED');
      await bridgeCall(this.#page,'ackSync',{generation:raw.generation,step:raw.step-1});
    }
    requireThat(token || expected, 'SYNC_REQUIRED');
    requireThat(typeof pageState.gameUuid === 'string' && pageState.gameUuid.length > 0 && [0,1,2,3].includes(pageState.ownSeat),'GAME_IDENTITY_UNVERIFIED');
    requireThat(raw.gameUuid === undefined || raw.gameUuid === pageState.gameUuid,'SYNC_IDENTITY_CHANGED');
    requireThat(this.#gameUuid === null || this.#gameUuid === pageState.gameUuid,'OBSERVED_MATCH_CHANGED');
    const config = pageState.authSummary?.gameConfig;
    const shortClock = this.#room.rules.displayTimeSetting === '5+20';
    requireThat(!shortClock || this.#akagi, 'FRIEND_ROOM_CLOCK_UNSUPPORTED');
    const [fixed, add] = roomClockSeconds(this.#room.rules.displayTimeSetting);
    requireThat(config?.category === 1 && config.mode?.mode === (this.#room.rules.length === 'south' ? 2 : 1) &&
      config.mode.detail_rule?.time_fixed === fixed && config.mode.detail_rule?.time_add === add,'FRIEND_ROOM_READBACK_MISMATCH');
    if (this.#akagi) {
      requireThat(pageState.akagiEnabled === true && pageState.phase2ActionsEnabled === true, 'AKAGI_BRIDGE_DISABLED');
      if (this.#room.rules.computerSeats === 3) requireThat(pageState.authSummary.otherSeatsAreRobots === true, 'AKAGI_COMPUTER_SEATS_UNVERIFIED');
      const rules = config.mode.detail_rule;
      requireThat(rules.dora_count === 3 && rules.shiduan === 1 && rules.init_point === 25000 &&
        this.#room.rules.verifiedOptions.redFives === 3, 'AKAGI_ROOM_RULES_UNVERIFIED');
    }
    const configuredRedFives = this.#room.rules.verifiedOptions.redFives;
    if (typeof configuredRedFives === 'number') {
      requireThat(config.mode.detail_rule.dora_count === configuredRedFives, 'FRIEND_ROOM_READBACK_MISMATCH');
    }
    const gameMatchKey = `game-${digest(pageState.gameUuid).slice(0,32)}`;
    const opening = raw.game_restore?.actions?.find((a:any)=>a.name==='ActionNewRound');
    requireThat(opening,'SYNC_HAND_START_REQUIRED');
    const gameHandKey = this.#handKey(gameMatchKey,opening.payload ?? opening.data);
    const handOrdinal = await this.coordinator.resolveHandOrdinal(gameMatchKey,gameHandKey);
    const terminal = raw.is_end || endNames.includes(raw.game_restore.actions.at(-1)?.name);
    const timingEvidence = terminal ? null : acquisition.evidence as SyncCountdownEvidence | null;
    let timing: ReturnType<typeof deriveSyncOperationTiming> | undefined;
    let expiredWindow = false;
    // During a window refresh, keep the committed actor available for ingress
    // until read-only visual collection succeeds. A turn can expire while a
    // screenshot is encoded; that must not strand it behind an uncommitted sync.
    try { timing = timingEvidence ? deriveSyncOperationTiming(raw,token?.connectionEpoch ?? this.actor.projection.connectionEpoch,timingEvidence) : undefined; }
    catch (error) {
      rememberTimingRejection(error);
      // Continuous play can reach an offer too late to execute. Still commit
      // the authoritative restore so subsequent ingress remains usable. The
      // window retains an unknown deadline and cannot authorize a send.
      if (!this.#akagi || !refreshWindow || !(error instanceof Error && error.message === 'COUNTDOWN_EXPIRED')) throw error;
      expiredWindow = true;
    }
    if (timing && this.#timingDiagnostics) this.#timingDiagnostics.verified=true;
    if (!expected) await bridgeCall(this.#page,'ackSync',{generation:raw.generation,step:raw.step-1});
    let autoWinReadback: any = null;
    if (collectExecutionProofs && !terminal && !expiredWindow) {
      const previous = this.segments.at(-1)?.sync;
      const recovery = this.#autoWinRecoveries.at(-1);
      const retained = this.#autoWinReadOnlyScope;
      const sameReadOnlyScope = retained?.gameHandKey === gameHandKey &&
        ['pageEpoch','sourceStream','gameUuid','nativeRestoreRevision'].every(key=>
          retained[key as keyof typeof retained]===pageState[key]);
      const alreadyVerified = refreshWindow && (retained ? sameReadOnlyScope :
        previous?.gameHandKey === gameHandKey && previous.room.autoWin === 'verified-on' && this.#cursor?.pageEpoch === raw.pageEpoch ||
        recovery?.gameHandKey === gameHandKey && recovery.pageEpoch === raw.pageEpoch && recovery.status === 'verified');
      const verifyCurrentAutoWin = async () => {
        const sampled=acquisition.autoWinReadback;
        if (sampled?.source==='unity-button-pixels-v1' && sampled.pageEpoch===pageState.pageEpoch &&
          sampled.generation===pageState.generation && sampled.step===pageState.lastStep &&
          Number.isSafeInteger(sampled.nativeRestoreRevision) && sampled.nativeRestoreRevision===pageState.nativeRestoreRevision) {
          try {
            // The countdown already captured these pixels. This is still a
            // fresh acknowledgement against the original 1s age/scope fence,
            // not reuse of a previous window or the unit-calibration images.
            const verified=await bridgeCall(this.#page,'ackAutoWin',sampled);
            requireThat(sampled.state==='enabled','AUTO_WIN_UNVERIFIED');
            return {...sampled,clicked:false,verified};
          } catch(error) {
            if (!(error instanceof Error && error.message==='AUTO_WIN_READBACK_STALE')) throw error;
            const current=await bridgeCall(this.#page,'read');
            if (!['pageEpoch','generation','lastStep','nativeRestoreRevision','sourceStream','gameUuid','handSha256','controlEpoch','paused']
              .every(key=>current[key]===pageState[key])) throw error;
          }
        }
        return bridgeCall(this.#page,'verifyAutoWin');
      };
      // A fresh read is still mandatory, but an enabled switch in this hand
      // does not need the two-frame restore/toggle workflow on every offer.
      autoWinReadback = alreadyVerified ? await verifyCurrentAutoWin().catch(async error => {
        if (error instanceof Error && error.message === 'AUTO_WIN_UNVERIFIED') {
          this.#autoWinReadOnlyScope=null;
          return bridgeCall(this.#page,'ensureAutoWin');
        }
        if (error instanceof Error && error.message === 'AUTO_WIN_READBACK_STALE') {
          const current = await bridgeCall(this.#page,'read');
          // Only the read-only verification path may discard a stale sample.
          // Replaced documents, restores, hands, owners or unresolved sends
          // retain their blocking behavior; no rejected proof reaches prepare.
          const same = current.pageEpoch === expected!.pageEpoch && current.gameUuid === pageState.gameUuid &&
            this.actor.projection.gameHandKey === gameHandKey &&
            Number.isSafeInteger(pageState.sourceStream) && pageState.sourceStream >= 0 &&
            current.sourceStream === pageState.sourceStream && current.handSha256 === pageState.handSha256 &&
            Number.isSafeInteger(pageState.nativeRestoreRevision) && pageState.nativeRestoreRevision >= 0 &&
            current.nativeRestoreRevision === pageState.nativeRestoreRevision &&
            Number.isSafeInteger(current.generation) && current.generation >= expected!.generation &&
            Number.isSafeInteger(current.lastStep) && current.lastStep >= expected!.lastStep! &&
            current.controlEpoch === this.actor.control.controlEpoch && current.paused === true && current.connected === true &&
            current.freshConnection === true && !current.reason && !current.overflow &&
            Number.isSafeInteger(pageState.stats?.bridgeActionSends) && pageState.stats.bridgeActionSends >= 0 &&
            current.stats?.bridgeActionSends === pageState.stats.bridgeActionSends &&
            this.actor.control.paused && !this.actor.control.needsSync;
          if (same && (await this.actor.storage.inspectMatch(gameMatchKey)).unresolvedAttempts.length === 0) {
            // Wall time can only close this window, never extend or authorize
            // it. Mark the skipped offer before draining its native timeout
            // discard, retaining the exact tile/cursor attribution checks.
            const budgetExpired = timing && Date.now() - Date.parse(timing.sampledAt) >=
              timing.remainingMs - timing.uncertaintyMs - 250;
            throw Error(budgetExpired ? 'AUTO_WIN_WINDOW_EXPIRED' : 'AUTO_WIN_SAMPLE_STALE');
          }
        }
        throw error;
      }) : await bridgeCall(this.#page,'ensureAutoWin');
      requireThat(autoWinReadback.state === 'enabled' && autoWinReadback.pageEpoch === raw.pageEpoch,'AUTO_WIN_UNVERIFIED');
    }
    if (expected) {
      token = this.actor.beginSync();
      await this.actor.awaitControlBarrier();
      // Re-derive with the newly issued epoch rather than mutating a proof
      // produced for the previously committed actor.
      if (timing) timing = deriveSyncOperationTiming(raw,token.connectionEpoch,timingEvidence!);
    }
    requireThat(token, 'SYNC_REQUIRED');
    if (autoWinReadback && timing) {
        try { await bridgeCall(this.#page,'ackTiming',timing); }
        catch (error) {
          // Visual verification can consume the remaining budget after the
          // samples passed. Commit this restore without an executable deadline.
          if (!this.#akagi || !refreshWindow || !(error instanceof Error && error.message === 'DEADLINE_EXCEEDED')) throw error;
          expiredWindow = true; timing = undefined;
        }
    }
    const room: FriendRoom = {...this.#room,autoWin:autoWinReadback ? 'verified-on':'unknown'};
    const sync = normalizeSyncGame(raw,{...token,sessionId:this.actor.projection.sessionId,room,gameMatchKey,gameHandKey,
      ownSeat:pageState.ownSeat,handOrdinal,receivedAt:raw.receivedAt,akagi:this.#akagi,...(timing?{timing}:{})});
    await this.coordinator.applySync(sync);
    const retainExpiredTail=this.#akagi && refreshWindow && expiredWindow;
    // An already expired offer cannot send. Its native timeout can arrive
    // after applySync: leave that authoritative tail queued until the caller
    // marks the exact skipped offer, so the next pump can ingest/attribute it.
    // Executable synchronization retains the original empty-drain gate.
    const cursor = await bridgeCall(this.#page,retainExpiredTail?'read':'drain');
    if (retainExpiredTail) {
      requireThat(cursor.pageEpoch===raw.pageEpoch && cursor.gameUuid===pageState.gameUuid &&
        Number.isSafeInteger(pageState.sourceStream) && cursor.sourceStream===pageState.sourceStream &&
        cursor.handSha256===pageState.handSha256 && pageState.handSha256===(opening.payload??opening.data).sha256 &&
        Number.isSafeInteger(pageState.nativeRestoreRevision) && pageState.nativeRestoreRevision>=0 &&
        cursor.nativeRestoreRevision===pageState.nativeRestoreRevision &&
        cursor.controlEpoch===this.actor.control.controlEpoch && cursor.paused===true && this.actor.control.paused &&
        cursor.connected===true && cursor.freshConnection===true && !cursor.reason && !cursor.overflow &&
        Number.isSafeInteger(cursor.generation) && cursor.generation>=raw.generation &&
        Number.isSafeInteger(cursor.lastStep) && cursor.lastStep>=raw.step-1 &&
        Number.isSafeInteger(pageState.stats?.bridgeActionSends) && cursor.stats?.bridgeActionSends===pageState.stats.bridgeActionSends,
      'SYNC_CAPTURE_RACE');
      // The actor still represents raw; the next pump, not this read-only
      // observation, advances its remembered cursor alongside the queued facts.
    } else {
      requireThat(!cursor.reason && !cursor.overflow && cursor.records.length === 0 && cursor.lastStep === raw.step-1,'SYNC_CAPTURE_RACE');
      this.#rememberCursor(cursor);
    }
    this.#gameUuid = pageState.gameUuid;
    this.#recovering = false; this.#nativeRestoreDeadline = null; this.#pendingResult = null;
    this.#pendingAutoWinRecovery = null;
    this.#expiredWindow = null;
    this.#unverifiedTimingWindow = null;
    this.segments.push({sync,subsequent:[]});
    this.#rememberAutoWinReadOnlyScope(cursor,autoWinReadback,gameHandKey);
    if (!collectExecutionProofs) await this.#restoreAutoWin(cursor,this.#recordAutoWinRecovery(cursor,!!terminal,recovering?'reconnect':'initial-sync'));
    return {sync,cursor,timing,timingEvidence,autoWinReadback,expiredWindow};
  }
  async skipExpiredWindow(sourceCursor: string, gameHandKey: string) {
    this.actor.suspendForBoundary();
    await this.actor.awaitControlBarrier();
    const p = this.actor.projection, state = p.state;
    requireThat(this.#akagi && !this.actor.control.needsSync && state?.trust === 'trusted' &&
      p.sourceCursor === sourceCursor && p.gameHandKey === gameHandKey, 'EXPIRED_WINDOW_SCOPE_CHANGED');
    const ledger = await this.actor.storage.inspectMatch(p.gameMatchKey!);
    requireThat(ledger.unresolvedAttempts.length === 0, 'ACTION_RECONCILIATION_REQUIRED');
    requireThat(this.actor.projection.sequence===p.sequence && !this.actor.control.needsSync &&
      this.actor.projection.state?.trust==='trusted','EXPIRED_WINDOW_SCOPE_CHANGED');
    this.#markSkippedDraw(sourceCursor,gameHandKey,'expired');
  }
  #markSkippedDraw(sourceCursor:string,gameHandKey:string,reason:'expired'|'unverified-timing') {
    const state=this.actor.projection.state!;
    const draw = state.drawnTileRef, window = state.operationWindow;
    const tile = draw.known && draw.value ? state.ownConcealed.find(tile => tile.instanceId === draw.value) : undefined;
    this.#expiredWindow = tile && window?.status === 'open' && window.candidates.some(candidate =>
      candidate.authority === 'executor' && candidate.action.kind === 'discard' && candidate.action.tsumogiri && candidate.action.tile === tile.instanceId)
      ? { gameHandKey, sourceCursor, tile: tile.code, reason } : null;
  }
  #requireRejectedTimingActor(scope:TimingRejectionScope) {
    const p=this.actor.projection,c=this.actor.control,previous=scope.projection;
    requireThat(this.#akagi && !this.#recovering && !this.#pendingResult && c.paused &&
      (!c.needsSync || this.#closingUnverifiedTiming) && !c.reason &&
      c.pendingIngress===0 && c.controlPending===0 && c.controlEpoch===scope.controlEpoch &&
      p.state?.trust==='trusted' && p.sequence===previous.sequence && p.connectionEpoch===previous.connectionEpoch &&
      p.gameMatchKey===previous.gameMatchKey && p.gameHandKey===previous.gameHandKey && p.sourceCursor===previous.sourceCursor &&
      p.state.operationWindow?.id===previous.state?.operationWindow?.id && p.state.operationWindow?.status==='open' &&
      p.handStatus==='playing' && p.matchStatus==='playing' && !p.matchEndPending,'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
  }
  #requireRejectedTimingPage(scope:TimingRejectionScope,current:any,batch=false) {
    const before=scope.page,p=scope.projection,expected=scope.cursor;
    const integer=(n:unknown):n is number=>Number.isSafeInteger(n) && (n as number)>=0;
    requireThat(integer(before.pageEpoch) && before.pageEpoch>0 && before.pageEpoch===expected.pageEpoch &&
      integer(before.generation) && before.generation===expected.generation && integer(before.lastStep) && before.lastStep===expected.lastStep &&
      before.lastStep===Number(p.sourceCursor?.split(':').at(-1)) && before.queued===0 &&
      typeof before.gameUuid==='string' && before.gameUuid===this.#gameUuid &&
      p.gameMatchKey===`game-${digest(before.gameUuid).slice(0,32)}` &&
      typeof before.handSha256==='string' && /^[a-f0-9]{64}$/.test(before.handSha256) &&
      this.#handKey(p.gameMatchKey!,{sha256:before.handSha256})===p.gameHandKey &&
      integer(before.sourceStream) && integer(before.nativeRestoreRevision) &&
      before.controlEpoch===scope.controlEpoch && before.paused===true && before.connected===true && before.freshConnection===true &&
      !before.nativeRestorePending && !before.reason && !before.overflow && !before.handEnded && !before.matchEnded &&
      integer(before.stats?.bridgeActionSends) &&
      ['pageEpoch','gameUuid','handSha256','sourceStream','nativeRestoreRevision','controlEpoch'].every(key=>current[key]===before[key]) &&
      current.paused===true && current.connected===true && current.freshConnection===true &&
      !current.nativeRestorePending && !current.reason && !current.overflow &&
      current.stats?.bridgeActionSends===before.stats.bridgeActionSends &&
      integer(current.queued) && integer(current.generation) && integer(current.lastStep) && current.lastStep>=before.lastStep &&
      // Each queued authoritative record increments generation exactly once.
      // Extra input, client requests, resize or restore invalidation cannot be
      // mistaken for a native timeout just because a matching discard follows.
      current.generation-before.generation===current.queued && current.lastStep-before.lastStep<=current.queued,
    'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
    if (batch) requireThat(Array.isArray(current.records) && current.records.length===current.queued &&
      current.records.every((record:any,index:number)=>record.pageEpoch===before.pageEpoch &&
        record.generation===before.generation+index+1 && record.gameUuid===before.gameUuid &&
        record.handSha256===before.handSha256 && record.sourceStream===before.sourceStream &&
        (record.kind==='action' || record.kind==='match-end')),'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
  }
  async skipUnverifiedTimingWindow(error:unknown,sourceCursor:string,gameHandKey:string) {
    const rejected=this.#rejectedTiming;this.#rejectedTiming=null;
    requireThat(rejected && rejected.error===error && unverifiedTimingCodes.has(rejected.error.message) &&
      rejected.scope.projection.sourceCursor===sourceCursor && rejected.scope.projection.gameHandKey===gameHandKey,
    'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
    const scope=rejected.scope;
    this.#requireRejectedTimingActor(scope);
    const ledger=await this.actor.storage.inspectMatch(scope.projection.gameMatchKey!);
    requireThat(ledger.unresolvedAttempts.length===0,'ACTION_RECONCILIATION_REQUIRED');
    this.#requireRejectedTimingActor(scope);
    // Read, never drain: timeout facts may already be queued. Mark the original
    // draw first, then let the ordinary pump validate and ingest those facts.
    const current=await bridgeCall(this.#page,'read');
    this.#requireRejectedTimingActor(scope);
    this.#requireRejectedTimingPage(scope,current);
    this.#markSkippedDraw(sourceCursor,gameHandKey,'unverified-timing');
    this.#unverifiedTimingWindow=scope;
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
      this.#rememberAutoWinReadOnlyScope(cursor,readback,p.gameHandKey!);
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
    const projection = this.actor.projection, state = projection.state;
    const draw = state?.drawnTileRef;
    // In riichi the client can send a forced tsumogiri before ever offering
    // an executor window. Account for it separately from Akagi's sends.
    const forced = this.#akagi && state?.players[state.ownSeat].riichi === 'accepted' &&
      (!state.operationWindow || state.operationWindow.status === 'closed') && draw?.known && draw.value !== null
      ? observations.find(event => event.type === 'TileDiscarded' && event.payload.actor === state.ownSeat &&
        event.payload.tsumogiri.known && event.payload.tsumogiri.value && !event.payload.riichiDeclaration &&
        state.ownConcealed.some(tile => tile.instanceId === draw.value && tile.code === event.payload.tile))
      : undefined;
    const skipped = this.#expiredWindow;
    const nextCursor = skipped && `${skipped.sourceCursor.slice(0, skipped.sourceCursor.lastIndexOf(':') + 1)}${Number(skipped.sourceCursor.split(':').at(-1)) + 1}`;
    const expired = skipped && state && projection.gameHandKey === skipped.gameHandKey && projection.sourceCursor === skipped.sourceCursor
      ? observations.find(event => event.type === 'TileDiscarded' && event.sourceCursor === nextCursor &&
        event.payload.actor === state.ownSeat && event.payload.tile === skipped.tile &&
        event.payload.tsumogiri.known && event.payload.tsumogiri.value && !event.payload.riichiDeclaration)
      : undefined;
    await this.coordinator.ingest(observations);
    if (forced?.sourceCursor) this.forcedRiichiDiscards.add(forced.sourceCursor);
    if (expired?.sourceCursor && expired !== forced)
      (skipped?.reason==='unverified-timing'?this.unverifiedTimingWindowDiscards:this.expiredWindowDiscards).add(expired.sourceCursor);
    if (this.actor.projection.sourceCursor !== skipped?.sourceCursor || this.actor.projection.gameHandKey !== skipped?.gameHandKey)
      this.#expiredWindow = null;
    this.segments.at(-1)!.subsequent.push(...observations);
    for (const event of observations) {
      if (event.type==='HandStarted') this.counts.handStarts++;
      if (event.type==='HandEnded') this.counts.handEnds++;
      if (event.type==='MatchEnded') this.counts.matchEnds++;
    }
  }
  async pump(): Promise<void> {
    const batch = await bridgeCall(this.#page,'drain');
    const skipped=this.#unverifiedTimingWindow;
    if (skipped) {
      this.#requireRejectedTimingActor(skipped);
      const ledger=await this.actor.storage.inspectMatch(skipped.projection.gameMatchKey!);
      requireThat(ledger.unresolvedAttempts.length===0,'ACTION_RECONCILIATION_REQUIRED');
      this.#requireRejectedTimingActor(skipped);
      this.#requireRejectedTimingPage(skipped,batch,true);
    }
    await this.#consumeBatch(batch,true);
    if (skipped) {
      const p=this.actor.projection;
      if (p.sourceCursor!==skipped.projection.sourceCursor || p.gameHandKey!==skipped.projection.gameHandKey ||
        p.state?.operationWindow?.status!=='open') this.#unverifiedTimingWindow=null;
      else {
        this.#requireRejectedTimingActor(skipped);
        // An empty drain consumes no cursor or proof. Continue to fence every
        // asynchronous wait until an authoritative fact closes this offer.
        requireThat(batch.records.length===0,'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
      }
    }
  }
  async pauseAndDrain():Promise<void> {
    const skipped=this.#unverifiedTimingWindow;
    if(skipped)this.#requireRejectedTimingActor(skipped);
    const controlEpoch=this.actor.control.controlEpoch;
    this.actor.pause();await this.actor.awaitControlBarrier();
    if(skipped) {
      // The final observation barrier deliberately closes the Actor. Only this
      // method's exact single pause may update the control fence for the final
      // read-only drain; all pixel, page, send and attribution guards survive.
      requireThat(this.actor.control.controlEpoch===controlEpoch+1 && this.actor.control.needsSync,
        'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
      this.#unverifiedTimingWindow={...skipped,controlEpoch:controlEpoch+1,page:{...skipped.page,controlEpoch:controlEpoch+1}};
      this.#closingUnverifiedTiming=true;
    }
    try { await this.pump(); }
    finally { this.#closingUnverifiedTiming=false; }
  }
  #deferNativeRestore(state:any) {
    requireThat(!state.overflow,'BRIDGE_QUEUE_OVERFLOW');
    requireThat(!state.reason || recoverableReasons.includes(state.reason),'BRIDGE_UNTRUSTED');
    requireThat(state.gameUuid === undefined || this.#gameUuid === null || state.gameUuid === this.#gameUuid,'OBSERVED_MATCH_CHANGED');
    this.#nativeRestoreDeadline ??= performance.now() + 30_000;
    requireThat(performance.now() < this.#nativeRestoreDeadline,'SYNC_NATIVE_RESTORE_TIMEOUT');
  }
  async #consumeBatch(batch:any,allowSynchronization:boolean): Promise<void> {
    this.#rememberCursor(batch);
    this.#validateAutoWinRecovery(batch);
    requireThat(!batch.overflow,'BRIDGE_QUEUE_OVERFLOW');
    const disconnected = batch.records.some((r:any)=>r.kind==='disconnected');
    const reauthenticated = batch.records.some((r:any)=>r.kind==='auth-summary');
    if (batch.reason || disconnected || reauthenticated || this.#recovering) {
      this.#expiredWindow = null;
      requireThat(!batch.reason || recoverableReasons.includes(batch.reason),'BRIDGE_UNTRUSTED');
      requireThat(batch.gameUuid === undefined || this.#gameUuid === null || batch.gameUuid === this.#gameUuid,'OBSERVED_MATCH_CHANGED');
      if (!this.#recovering) { this.actor.failClosed('DISCONNECTED'); this.#recovering = true; }
      await this.actor.awaitControlBarrier();
      if (allowSynchronization && batch.connected === true && batch.freshConnection && batch.authSummary) {
        // Authentication precedes Unity's replay and finishSyncGame. Let that
        // native cycle finish before starting our own paired synchronization.
        if (batch.nativeRestorePending === true) { this.#deferNativeRestore(batch); return; }
        try { await this.synchronize(false); this.counts.reconnects++; }
        catch (error) {
          // A new native restore can start after the drain above. This refusal
          // occurs before a bridge request; defer to a later pump without
          // swallowing connection, match, receipt or snapshot failures.
          if (!(error instanceof Error && error.message === 'SYNC_NATIVE_RESTORE_PENDING')) throw error;
          this.#deferNativeRestore(await bridgeCall(this.#page,'read'));
        }
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
          receivedAt:record.receivedAt,connectionEpoch:projection.connectionEpoch,akagi:this.#akagi};
        if (endNames.includes(record.name)) {
          const fields = ['old_scores','delta_scores','scores','gameend','liujumanguan'];
          this.#settlementDiagnostics = { name: record.name, step: record.step,
            before: [0,1,2,3].map(seat=>projection.state!.players[seat as 0|1|2|3].score),
            payload: Object.fromEntries(fields.filter(key=>Object.hasOwn(record.payload,key)).map(key=>[key,record.payload[key]])) };
        }
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
