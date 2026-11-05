import type { GameObservation, GameProjection, HandInitialView, LegalAction, Meld, Seat, TileCode } from '../../domain/game/types.ts';
import { doraFromIndicator, eventIdFor, known, reduceObservation, seats, unknown } from '../../domain/game/reducer.ts';
import { canonical, cursorParts, digest, requireThat } from '../../domain/game/value.ts';
import { integer, parseObservation, timestamp } from '../../schemas/game.ts';
import type { VerifiedOperationTiming } from './operation-timing.ts';
import { legalOperationActions, type OfferedOperations } from './actions.ts';
export type { VerifiedOperationTiming } from './operation-timing.ts';

export interface NormalizeContext {
  projection: GameProjection;
  sourceStream: string;
  step: number;
  receivedAt: string;
  connectionEpoch: number;
  source?: 'majsoul-network' | 'majsoul-sync';
  /** Historical offers are expired; only the last restore action may open a window. */
  historyReplay?: boolean;
  timing?: VerifiedOperationTiming;
}

function record(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_PROTOCOL_OBJECT');
  return value as Record<string, unknown>;
}
function flag(value: unknown): boolean {
  requireThat(typeof value === 'boolean', 'PROTOCOL_BOOLEAN_MISSING');
  return value;
}
function scoreList(value: unknown) {
  requireThat(Array.isArray(value) && value.length === 4, 'INVALID_PROTOCOL_SCORES');
  value.forEach(v => integer(v, -100_000, 1_000_000));
  return Object.fromEntries(seats.map(s => [s, value[s]])) as Record<Seat, number>;
}

export function operationDeadline(operation: Record<string, unknown>, context: NormalizeContext, sourceEventId: string) {
  const timing = context.timing;
  if (!timing) return unknown('DEADLINE_PROVENANCE_UNVERIFIED');
  requireThat(['client-countdown', 'protocol-operation'].includes(timing.source) && timing.step === context.step, 'TIMING_SCOPE_MISMATCH');
  timestamp(timing.sampledAt); integer(timing.remainingMs, 1, 600_000); integer(timing.uncertaintyMs, 1, 120_000);
  integer(operation.time_fixed, 0, 600_000); integer(operation.time_add, 0, 600_000);
  if (timing.source === 'protocol-operation') {
    requireThat(context.source === 'majsoul-sync' && timing.origin === 'sync-game' && timing.connectionEpoch === context.connectionEpoch && timing.sampledAt === context.receivedAt, 'TIMING_SCOPE_MISMATCH');
    integer(timing.pageEpoch, 1); integer(timing.fixedMs, 1, 600_000); integer(timing.addMs, 0, 0);
    integer(timing.elapsedMs, 0, 1_200_000); integer(timing.networkAllowanceMs, 0, 30_000); integer(timing.quantizationAllowanceMs, 2_000, 120_000);
    requireThat(Number.isFinite(timing.sampledMonoMs) && timing.sampledMonoMs >= 0 && timing.fixedMs === operation.time_fixed && timing.addMs === operation.time_add &&
      timing.remainingMs === timing.fixedMs + timing.addMs - timing.elapsedMs && timing.uncertaintyMs === timing.networkAllowanceMs + timing.quantizationAllowanceMs, 'COUNTDOWN_READBACK_MISMATCH');
    requireThat(timing.remainingMs > timing.uncertaintyMs + 250, 'COUNTDOWN_EXPIRED');
  }
  requireThat(timing.remainingMs <= operation.time_fixed + operation.time_add && Math.abs(Date.parse(timing.sampledAt) - Date.parse(context.receivedAt)) <= 5_000, 'COUNTDOWN_READBACK_MISMATCH');
  const at = Date.parse(timing.sampledAt) + timing.remainingMs;
  requireThat(at >= Date.parse(context.receivedAt), 'COUNTDOWN_EXPIRED');
  return known({ at: new Date(at).toISOString(), sourceEventId, uncertaintyMs: timing.uncertaintyMs });
}

export interface NewRoundContext extends NormalizeContext { ownSeat: Seat; gameHandKey: string; handOrdinal: number }
/** Hand identity is supplied by a verified client round id; wind/dealer/honba are not unique ids. */
export function normalizeNewRound(payload: unknown, context: NewRoundContext): GameObservation[] {
  const input = record(payload);
  integer(input.chang, 0, 3); integer(input.ju, 0, 3); integer(input.ben, 0, 100); integer(input.liqibang, 0, 100);
  integer(input.left_tile_count, 0, 136); integer(context.ownSeat, 0, 3);
  requireThat(context.gameHandKey.length > 0 && context.gameHandKey.length <= 160, 'HAND_KEY_REQUIRED');
  for (const field of ['muyu', 'yongchang', 'xia_ke_shang']) requireThat(input[field] === undefined || input[field] === null, 'UNSUPPORTED_PROTOCOL_TRANSITION');
  for (const field of ['field_spell', 'ju_count']) requireThat(input[field] === undefined || input[field] === 0, 'UNSUPPORTED_PROTOCOL_VARIANT');
  requireThat(input.opens === undefined || Array.isArray(input.opens) && input.opens.length <= 4 && input.opens.every(v => {
    const opened = record(v); return Array.isArray(opened.tiles) && opened.tiles.length === 0;
  }), 'UNSUPPORTED_REVEALED_HAND');
  requireThat(Array.isArray(input.tiles) && input.tiles.length === (input.ju === context.ownSeat ? 14 : 13), 'INVALID_OPENING_HAND');
  requireThat(Array.isArray(input.doras) && input.doras.length > 0 && input.doras.length <= 5, 'INVALID_DORA_LIST');
  requireThat(context.projection.room?.rules.verifiedOptions.doraRule === 'standard-riichi', 'DORA_RULE_NOT_VERIFIED');
  const scores = scoreList(input.scores), dealer = input.ju as Seat;
  const ownConcealed = input.tiles.map((t, i) => ({ instanceId: `opening-${i}`, code: majsoulTile(t) }));
  const indicators = input.doras.map(majsoulTile);
  const initialView: HandInitialView = { ownSeat: context.ownSeat,
    players: Object.fromEntries(seats.map(s => [s, { seat: s, score: scores[s], river: [], melds: [], riichi: 'none', concealedCount: known(s === dealer ? 14 : 13) }])) as unknown as HandInitialView['players'],
    // The opening 14 tiles are an unordered concealed hand in the observed
    // client. Their last array entry does not identify a drawn tile. A first
    // discard with authoritative moqie:false may remove any matching instance.
    ownConcealed, drawnTileRef: known(null), dealer,
    roundWind: `${input.chang + 1}z` as TileCode, seatWind: `${(context.ownSeat - dealer + 4) % 4 + 1}z` as TileCode,
    handNumber: dealer + 1, honba: input.ben, riichiSticks: input.liqibang, doraIndicators: indicators,
    doraTiles: indicators.map(doraFromIndicator), tilesRemaining: known(input.left_tile_count), currentActor: known(dealer), unknownFields: [] };
  const sourceCursor = `${context.sourceStream}:${context.step}`;
  const hand = parseObservation({ schemaVersion: 1, observationId: `observation-${digest([context.connectionEpoch, sourceCursor, 'hand']).slice(0, 24)}`,
    connectionEpoch: context.connectionEpoch, source: context.source ?? 'majsoul-network', sourceDedupKey: `${sourceCursor}:hand`, sourceCursor,
    receivedAt: context.receivedAt, type: 'HandStarted', payload: { ordinal: context.handOrdinal, initialView, gameHandKey: context.gameHandKey } });
  reduceObservation(context.projection, hand);
  // No executable opening window until the client provides a separately
  // observed ActionDealTile. Never infer moqie from the opening array order.
  return [hand];
}

function offerDiscard(offered: Record<string, unknown>, context: NormalizeContext, permitted: boolean, autoWinKind?: 'tsumo' | 'ron'): GameObservation | undefined {
  requireThat(Array.isArray(offered.operation_list) && offered.operation_list.length <= 16, 'INVALID_OPERATION_LIST');
  const operations = offered.operation_list.map(record);
  if (!operations.length) return;
  const { projection } = context, current = projection.state!;
  integer(offered.seat, 0, 3);
  const wins = operations.filter(o => o.type === 8 || o.type === 9);
  if (wins.length) requireThat(wins.length === 1 && (wins[0]!.type === 8 ? autoWinKind === 'tsumo' : autoWinKind === 'ron'), 'AUTO_WIN_OPERATION_MISMATCH');
  else if (operations.some(o => [1,4,6,7].includes(o.type as number))) requireThat(permitted, 'UNVERIFIED_DISCARD_WINDOW');
  const sourceCursor = `${context.sourceStream}:${context.step}`;
  const windowId = `window-${digest([projection.gameMatchKey, projection.gameHandKey, context.connectionEpoch, sourceCursor]).slice(0, 24)}`;
  const evidenceId = eventIdFor(projection.sessionId, projection.sequence + 1);
  const candidates = legalOperationActions(current, offered as unknown as OfferedOperations, windowId, evidenceId);
  return parseObservation({ schemaVersion: 1, observationId: `observation-${digest([context.connectionEpoch, sourceCursor, 'window']).slice(0, 24)}`,
    connectionEpoch: context.connectionEpoch, source: context.source ?? 'majsoul-network', sourceDedupKey: `${sourceCursor}:window`, receivedAt: context.receivedAt,
    type: 'OperationOffered', payload: { window: { id: windowId, connectionEpoch: context.connectionEpoch, openedAt: context.receivedAt,
      deadline: operationDeadline(offered, context, evidenceId), candidates, status: 'open' } } });
}
export function majsoulTile(value: unknown): TileCode {
  requireThat(typeof value === 'string' && /^(?:[0-9][mps]|[1-7]z)$/.test(value), 'INVALID_PROTOCOL_TILE');
  return (value[0] === '0' ? `5${value[1]}r` : value) as TileCode;
}

/**
 * Project already decoded, version-checked actions into visible domain facts.
 * The input object is never copied, logged, or serialized. In particular, a tile
 * included in somebody else's draw is discarded even if it is nonempty.
 *
 * This is a deliberately narrow compatibility boundary. New-hand and sync
 * mapping require their own verified identity context; phase-0 summaries are
 * insufficient. Decoders materialize protobuf's declared scalar defaults.
 */
export function normalizeAction(name: string, payload: unknown, context: NormalizeContext): GameObservation[] {
  requireThat(['ActionDealTile', 'ActionDiscardTile', 'ActionChiPengGang', 'ActionAnGangAddGang'].includes(name), 'UNSUPPORTED_PROTOCOL_ACTION');
  const input = record(payload), { projection } = context, state = projection.state;
  integer(context.step, 0, 999_999_999); integer(context.connectionEpoch); timestamp(context.receivedAt);
  const sourceCursor = `${context.sourceStream}:${context.step}`; cursorParts(sourceCursor);
  requireThat(state && state.trust === 'trusted' && projection.handStatus === 'playing' && projection.connectionEpoch === context.connectionEpoch, 'NORMALIZER_STATE_UNTRUSTED');
  integer(input.seat, 0, 3); const actor = input.seat as Seat;

  // These fields carry further state transitions or alternate game variants.
  // They need their own verified mapping before this narrow adapter accepts them.
  for (const field of ['muyu', 'hun_zhi_yi_ji_info', 'yongchang']) {
    requireThat(input[field] === undefined || input[field] === null, 'UNSUPPORTED_PROTOCOL_TRANSITION');
  }
  requireThat(input.scores === undefined || Array.isArray(input.scores) && input.scores.length === 0, 'UNSUPPORTED_SCORE_TRANSITION');
  requireThat(input.revealed === undefined || input.revealed === false, 'UNSUPPORTED_REVEALED_HAND');
  for (const field of ['tile_state', 'liqi_type_beishuizhizhan']) {
    requireThat(input[field] === undefined || input[field] === 0, 'UNSUPPORTED_PROTOCOL_VARIANT');
  }

  const observations: GameObservation[] = [];
  let projected = projection;
  function append(type: GameObservation['type'], data: unknown, suffix: string, carriesCursor = false): void {
    const observation = parseObservation({ schemaVersion: 1,
      observationId: `observation-${digest([context.connectionEpoch, sourceCursor, suffix]).slice(0, 24)}`,
      connectionEpoch: context.connectionEpoch, source: context.source ?? 'majsoul-network',
      sourceDedupKey: `${sourceCursor}:${suffix}`, receivedAt: context.receivedAt,
      ...(carriesCursor ? { sourceCursor } : {}), type, payload: data });
    projected = reduceObservation(projected, observation);
    observations.push(observation);
  }

  if (input.liqi !== undefined && input.liqi !== null) {
    const liqi = record(input.liqi); integer(liqi.seat, 0, 3); integer(liqi.score, -100_000, 1_000_000); integer(liqi.liqibang, 0, 100);
    requireThat(liqi.failed === false && (liqi.liqi_type_beishuizhizhan === undefined || liqi.liqi_type_beishuizhizhan === 0), 'UNSUPPORTED_RIICHI_RESULT');
    const seat = liqi.seat as Seat, scores = Object.fromEntries(seats.map(s => [s, projected.state!.players[s].score])) as Record<Seat, number>;
    requireThat(liqi.score === scores[seat] - 1_000 && liqi.liqibang === projected.state!.riichiSticks + 1, 'RIICHI_SCORE_MISMATCH');
    scores[seat] = liqi.score; append('RiichiAccepted', { actor: seat, scores, riichiSticks: liqi.liqibang }, 'riichi-accepted');
  }

  if (name === 'ActionDealTile') {
    integer(input.left_tile_count, 0, 136);
    append('TileDrawn', { actor, tile: actor === state.ownSeat ? known(majsoulTile(input.tile)) : unknown('OPPONENT_HIDDEN_TILE'),
      tilesRemaining: known(input.left_tile_count) }, 'draw', true);
  } else if (name === 'ActionDiscardTile') {
    const riichi = flag(input.is_liqi), doubleRiichi = flag(input.is_wliqi);
    append('TileDiscarded', { actor, tile: majsoulTile(input.tile), tsumogiri: known(flag(input.moqie)),
      riichiDeclaration: riichi || doubleRiichi }, 'discard', true);
  } else if (name === 'ActionChiPengGang') {
    integer(input.type, 0, 2);
    requireThat(Array.isArray(input.tiles) && Array.isArray(input.froms) && input.tiles.length === input.froms.length && input.tiles.length === (input.type === 2 ? 4 : 3), 'INVALID_PROTOCOL_MELD');
    input.froms.forEach(s => integer(s, 0, 3));
    requireThat(input.tile_states === undefined || Array.isArray(input.tile_states) && input.tile_states.every(v => v === 0), 'UNSUPPORTED_PROTOCOL_VARIANT');
    const foreign = input.froms.map((s, i) => ({ s, i })).filter(v => v.s !== actor); requireThat(foreign.length === 1, 'INVALID_PROTOCOL_MELD_SOURCE');
    const calledTileIndex = foreign[0]!.i, tiles = input.tiles.map(majsoulTile);
    const meld: Meld = { id: `meld-${digest([projection.gameMatchKey, projection.gameHandKey, sourceCursor]).slice(0, 24)}`, actor,
      kind: input.type === 0 ? 'chi' : input.type === 1 ? 'pon' : 'open-kan', tiles, fromSeat: foreign[0]!.s as Seat, calledTileIndex };
    const available = [...projected.state!.ownConcealed], consumed: string[] = [];
    if (actor === state.ownSeat) for (const [i, tile] of tiles.entries()) if (i !== calledTileIndex) {
      const index = available.findIndex(t => t.code === tile); requireThat(index >= 0, 'MELD_CONSUMED_MISMATCH'); consumed.push(available.splice(index, 1)[0]!.instanceId);
    }
    append('MeldDeclared', { meld, consumed }, 'meld', true);
  } else {
    integer(input.type, 2, 3);
    const code = majsoulTile(input.tiles), own = projected.state!.players[actor];
    const kind = input.type === 3 ? 'closed-kan' : 'added-kan';
    let tiles: TileCode[], consumed: string[] = [], previous: Meld | undefined;
    if (kind === 'closed-kan') {
      if (actor === state.ownSeat) {
        const physical = projected.state!.ownConcealed.filter(t => t.code.replace('r', '') === code.replace('r', ''));
        requireThat(physical.length === 4, 'MELD_CONSUMED_MISMATCH'); tiles = physical.map(t => t.code); consumed = physical.map(t => t.instanceId);
      } else {
        // Standard riichi has one red five; revealing all four proves its presence.
        tiles = [code, code, code, code].map(t => t.replace('r', '') as TileCode);
        if (code[0] === '5' && code[1] !== 'z') {
          requireThat(projection.room?.rules.verifiedOptions.redFives === true, 'RED_FIVE_RULE_UNVERIFIED');
          tiles[0] = `${code.slice(0, 2)}r` as TileCode;
        }
      }
    } else {
      const pons = own.melds.filter(m => m.kind === 'pon' && m.tiles.every(t => t.replace('r', '') === code.replace('r', '')));
      requireThat(pons.length === 1, 'AMBIGUOUS_KAN_UPGRADE'); previous = pons[0]!; tiles = [...previous.tiles, code];
      if (actor === state.ownSeat) {
        const physical = projected.state!.ownConcealed.filter(t => t.code === code); requireThat(physical.length === 1, 'MELD_CONSUMED_MISMATCH'); consumed = [physical[0]!.instanceId];
      }
    }
    const meld: Meld = { id: `meld-${digest([projection.gameMatchKey, projection.gameHandKey, sourceCursor]).slice(0, 24)}`, actor, kind, tiles,
      ...(previous ? { fromSeat: previous.fromSeat!, calledTileIndex: previous.calledTileIndex!, upgradedFrom: previous.id } : {}) };
    append('MeldDeclared', { meld, consumed }, 'meld', true);
  }

  if (input.doras !== undefined) {
    requireThat(Array.isArray(input.doras) && input.doras.length <= 5, 'INVALID_DORA_LIST');
    const indicators = input.doras.map(majsoulTile);
    if (indicators.length && canonical(indicators) !== canonical(projected.state!.doraIndicators)) {
      requireThat(projection.room?.rules.verifiedOptions.doraRule === 'standard-riichi', 'DORA_RULE_NOT_VERIFIED');
      append('DoraRevealed', { indicators, doraTiles: indicators.map(doraFromIndicator) }, 'dora');
    }
  }

  if (!context.historyReplay && input.operation !== undefined && input.operation !== null) {
    const offered = offerDiscard(record(input.operation), { ...context, projection: projected }, (name === 'ActionDealTile' || name === 'ActionChiPengGang') && actor === state.ownSeat,
      name === 'ActionDealTile' && actor === state.ownSeat ? 'tsumo' : (name === 'ActionDiscardTile' || name === 'ActionAnGangAddGang') && actor !== state.ownSeat ? 'ron' : undefined);
    if (offered) { projected = reduceObservation(projected, offered); observations.push(offered); }
  }
  return observations;
}
