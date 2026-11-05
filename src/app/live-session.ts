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
  constructor(actor: GameActor, page: EgoPagePort, room: FriendRoom) {
    this.coordinator = new GameCoordinator(actor); this.#page = page; this.#room = room;
  }
  get recovering() { return this.#recovering; }
  get awaitingSettlement() { return this.#pendingResult !== null; }
  get actor() { return this.coordinator.actor; }
  #handKey(gameMatchKey: string, opening: any): string {
    requireThat(typeof opening?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(opening.sha256),'HAND_IDENTITY_UNVERIFIED');
    return `hand-${digest([gameMatchKey,opening.sha256]).slice(0,32)}`;
  }
  async synchronize(collectExecutionProofs = true) {
    const token = this.actor.beginSync(); await this.actor.awaitControlBarrier();
    const acquisition = collectExecutionProofs ? await bridgeCall(this.#page,'automaticTiming')
      : {raw:await bridgeCall(this.#page,'sync'),evidence:null};
    const raw = acquisition.raw, pageState = await bridgeCall(this.#page,'read');
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
    this.#gameUuid = pageState.gameUuid;
    this.#recovering = false; this.#pendingResult = null;
    this.segments.push({sync,subsequent:[]});
    return {sync,cursor,timing,timingEvidence,autoWinReadback};
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
    requireThat(!batch.overflow,'BRIDGE_QUEUE_OVERFLOW');
    const disconnected = batch.records.some((r:any)=>r.kind==='disconnected');
    const reauthenticated = batch.records.some((r:any)=>r.kind==='auth-summary');
    if (batch.reason || disconnected || reauthenticated || this.#recovering) {
      requireThat(!batch.reason || recoverableReasons.includes(batch.reason),'BRIDGE_UNTRUSTED');
      if (!this.#recovering) { this.actor.failClosed('DISCONNECTED'); this.#recovering = true; }
      await this.actor.awaitControlBarrier();
      if (batch.connected === true && batch.freshConnection && batch.authSummary) {
        await this.synchronize(false); this.counts.reconnects++;
      }
      return;
    }
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
    await this.actor.awaitControlBarrier();
  }
}
