import type { AuthoritativeSync, FriendRoom, GameObservation, HandInitialView, OperationWindow, Seat } from '../../domain/game/types.ts';
import { initialProjection, reduceObservation } from '../../domain/game/reducer.ts';
import { digest, requireThat } from '../../domain/game/value.ts';
import { integer, parseObservation, parseSync, string, timestamp, validateRoom } from '../../schemas/game.ts';
import { normalizeAction, normalizeNewRound, type NormalizeContext, type VerifiedOperationTiming } from './normalize.ts';

export interface SyncGameContext {
  sessionId: string; room: FriendRoom; gameMatchKey: string; gameHandKey: string; ownSeat: Seat; handOrdinal: number;
  syncId: string; connectionEpoch: number; receivedAt: string; sourceStream?: string; timing?: VerifiedOperationTiming;
}
function record(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_PROTOCOL_OBJECT');
  return value as Record<string, unknown>;
}
/** Stable across reconnects; neither the local receive count nor an RPC request id is a source cursor. */
export function handSourceStream(gameMatchKey: string, gameHandKey: string): string {
  string(gameMatchKey); string(gameHandKey);
  return `majsoul-${digest([gameMatchKey, gameHandKey]).slice(0, 32)}`;
}

/**
 * Consume decoded restore actions (restore bytes are protobuf, without live XOR).
 * snapshot-only / truncated history is deliberately rejected: it cannot prove
 * the requested action's origin, nor rebuild physical own-tile references.
 */
export function normalizeSyncGame(value: unknown, context: SyncGameContext): AuthoritativeSync {
  const response = record(value), restore = record(response.game_restore);
  validateRoom(context.room); string(context.sessionId); string(context.gameMatchKey); string(context.gameHandKey); string(context.syncId);
  integer(context.connectionEpoch, 1); integer(context.handOrdinal, 1, 1000); integer(context.ownSeat, 0, 3); timestamp(context.receivedAt);
  requireThat(response.error === undefined || response.error === null, 'SYNC_RPC_REJECTED');
  requireThat(response.is_end === false, 'SYNC_GAME_ENDED'); integer(response.step, 1, 999_999_999);
  if (context.timing?.source === 'protocol-operation') {
    integer(restore.passed_waiting_time, 0, 1_200);
    requireThat(restore.game_state === 1 && restore.last_pause_time_ms === 0, 'TIMING_GAME_NOT_RUNNING');
    requireThat(context.timing.elapsedMs === restore.passed_waiting_time * 1_000 && context.timing.pageEpoch === response.pageEpoch && context.timing.sampledMonoMs === response.receivedMonoMs,
      'TIMING_SCOPE_MISMATCH');
  }
  requireThat(Array.isArray(restore.actions) && restore.actions.length > 0 && restore.actions.length <= 512, 'SYNC_ACTIONS_REQUIRED');
  const actions = restore.actions.map(record), sourceStream = context.sourceStream ?? handSourceStream(context.gameMatchKey, context.gameHandKey);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!; integer(action.step, 0, 999_999_999); string(action.name, 80);
    if (i) requireThat(action.step === (actions[i - 1]!.step as number) + 1, 'SYNC_HISTORY_GAP');
  }
  requireThat(actions.at(-1)!.step === response.step - 1, 'SYNC_NEXT_STEP_MISMATCH');
  const first = actions.findIndex(a => a.name === 'ActionNewRound');
  requireThat(first >= 0 && actions.slice(0, first).every(a => a.name === 'ActionMJStart') && actions.filter(a => a.name === 'ActionNewRound').length === 1, 'SYNC_HAND_START_REQUIRED');
  const payloadFor = (action: Record<string, unknown>) => record(action.data ?? action.payload);
  const opening = payloadFor(actions[first]!);
  requireThat(Array.isArray(opening.scores) && opening.scores.length === 4, 'INVALID_PROTOCOL_SCORES');
  let projection = initialProjection(context.sessionId); projection.connectionEpoch = context.connectionEpoch;
  const base = { schemaVersion: 1, connectionEpoch: context.connectionEpoch, source: 'majsoul-sync', receivedAt: context.receivedAt };
  const seed = (type: string, payload: unknown): GameObservation => parseObservation({ ...base, type, payload,
    observationId: `restore-seed-${type}`, sourceDedupKey: `restore-seed-${type}` });
  projection = reduceObservation(projection, seed('RoomVerified', { room: context.room, verifiedAt: context.receivedAt, evidenceIds: [context.syncId] }));
  projection = reduceObservation(projection, seed('MatchStarted', { roomId: context.room.roomId, ownSeat: context.ownSeat,
    initialScores: Object.fromEntries(opening.scores.map((score, seat) => [seat, score])), gameMatchKey: context.gameMatchKey }));
  const handHistory: GameObservation[] = [];
  for (let i = first; i < actions.length; i++) {
    const action = actions[i]!, last = i === actions.length - 1;
    const normalization: NormalizeContext = { projection, sourceStream, step: action.step as number,
      receivedAt: context.receivedAt, connectionEpoch: context.connectionEpoch, source: 'majsoul-sync', historyReplay: !last,
      ...(last && context.timing ? { timing: context.timing } : {}) };
    const events = action.name === 'ActionNewRound'
      ? normalizeNewRound(payloadFor(action), { ...normalization, ownSeat: context.ownSeat, gameHandKey: context.gameHandKey, handOrdinal: 1 })
      : normalizeAction(action.name as string, payloadFor(action), normalization);
    for (const event of events) { projection = reduceObservation(projection, event); handHistory.push(event); }
  }
  requireThat(projection.state?.trust === 'trusted' && projection.handStatus === 'playing', 'SYNC_UNKNOWN_STATE');
  const { sessionId: _session, matchId: _match, handId: _hand, connectionEpoch: _epoch, stateVersion: _version,
    trust: _trust, trustIssues: _issues, latestAction: _latest, operationWindow, ...view } = structuredClone(projection.state);
  const currentView: HandInitialView & { operationWindow?: OperationWindow } = view;
  if (operationWindow?.status === 'open') currentView.operationWindow = operationWindow;
  // The temporary reducer starts at ordinal 1; authoritative identity comes from the caller's verified hand boundary.
  const firstEvent = handHistory[0]!; requireThat(firstEvent.type === 'HandStarted', 'SYNC_HAND_START_REQUIRED'); firstEvent.payload.ordinal = context.handOrdinal;
  const result = parseSync({ syncId: context.syncId, connectionEpoch: context.connectionEpoch, receivedAt: context.receivedAt,
    coverage: 'complete-current-state', room: context.room, gameMatchKey: context.gameMatchKey, gameHandKey: context.gameHandKey,
    handOrdinal: context.handOrdinal, currentView, missingFields: [], historyCoverage: 'complete-hand', handHistory,
    observedActions: handHistory.filter(o => o.type === 'TileDiscarded' || o.type === 'MeldDeclared'), sourceCursor: `${sourceStream}:${response.step - 1}` });
  return result;
}
