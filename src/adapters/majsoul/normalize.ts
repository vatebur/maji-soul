import type { GameObservation, GameProjection, LegalAction, Seat, TileCode } from '../../domain/game/types.ts';
import { doraFromIndicator, eventIdFor, known, reduceObservation, unknown } from '../../domain/game/reducer.ts';
import { canonical, cursorParts, digest, requireThat } from '../../domain/game/value.ts';
import { integer, parseObservation, timestamp } from '../../schemas/game.ts';

export interface NormalizeContext {
  projection: GameProjection;
  sourceStream: string;
  step: number;
  receivedAt: string;
  connectionEpoch: number;
  source?: 'majsoul-network' | 'majsoul-sync';
}

function record(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_PROTOCOL_OBJECT');
  return value as Record<string, unknown>;
}
function flag(value: unknown): boolean {
  requireThat(typeof value === 'boolean', 'PROTOCOL_BOOLEAN_MISSING');
  return value;
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
 * This is deliberately a narrow compatibility boundary: no new-hand/sync view
 * is invented from the incomplete phase-0 capture. Decoders must materialize
 * protobuf's declared scalar defaults; missing critical fields remain errors.
 */
export function normalizeAction(name: string, payload: unknown, context: NormalizeContext): GameObservation[] {
  requireThat(name === 'ActionDealTile' || name === 'ActionDiscardTile', 'UNSUPPORTED_PROTOCOL_ACTION');
  const input = record(payload), { projection } = context, state = projection.state;
  integer(context.step, 0, 999_999_999); integer(context.connectionEpoch); timestamp(context.receivedAt);
  const sourceCursor = `${context.sourceStream}:${context.step}`; cursorParts(sourceCursor);
  requireThat(state && state.trust === 'trusted' && projection.handStatus === 'playing' && projection.connectionEpoch === context.connectionEpoch, 'NORMALIZER_STATE_UNTRUSTED');
  integer(input.seat, 0, 3); const actor = input.seat as Seat;

  // These fields carry further state transitions or alternate game variants.
  // They need their own verified mapping before this narrow adapter accepts them.
  for (const field of ['liqi', 'muyu', 'hun_zhi_yi_ji_info', 'yongchang']) {
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

  if (name === 'ActionDealTile') {
    integer(input.left_tile_count, 0, 136);
    append('TileDrawn', { actor, tile: actor === state.ownSeat ? known(majsoulTile(input.tile)) : unknown('OPPONENT_HIDDEN_TILE'),
      tilesRemaining: known(input.left_tile_count) }, 'draw', true);
  } else {
    const riichi = flag(input.is_liqi), doubleRiichi = flag(input.is_wliqi);
    append('TileDiscarded', { actor, tile: majsoulTile(input.tile), tsumogiri: known(flag(input.moqie)),
      riichiDeclaration: riichi || doubleRiichi }, 'discard', true);
  }

  if (input.doras !== undefined) {
    requireThat(Array.isArray(input.doras) && input.doras.length <= 5, 'INVALID_DORA_LIST');
    const indicators = input.doras.map(majsoulTile);
    if (indicators.length && canonical(indicators) !== canonical(projected.state!.doraIndicators)) {
      requireThat(projection.room?.rules.verifiedOptions.doraRule === 'standard-riichi', 'DORA_RULE_NOT_VERIFIED');
      append('DoraRevealed', { indicators, doraTiles: indicators.map(doraFromIndicator) }, 'dora');
    }
  }

  if (input.operation !== undefined && input.operation !== null) {
    const offered = record(input.operation);
    requireThat(Array.isArray(offered.operation_list) && offered.operation_list.length <= 16, 'INVALID_OPERATION_LIST');
    const operations = offered.operation_list.map(record);
    if (operations.length) {
      integer(offered.seat, 0, 3);
      requireThat(offered.seat === state.ownSeat && operations.length === 1 && operations[0]!.type === 1, 'UNSUPPORTED_OPERATION');
      const operation = operations[0]!;
      for (const field of ['combination', 'change_tiles', 'change_tile_states']) {
        requireThat(operation[field] === undefined || Array.isArray(operation[field]) && operation[field].length === 0, 'UNVERIFIED_OPERATION_RESTRICTIONS');
      }
      requireThat(operation.gap_type === undefined || operation.gap_type === 0, 'UNVERIFIED_OPERATION_RESTRICTIONS');
      // Only an ordinary draw has a verified full-hand discard set here. Meld,
      // riichi and win windows must be mapped separately, without approximation.
      requireThat(name === 'ActionDealTile' && actor === state.ownSeat && projected.state!.players[state.ownSeat].riichi === 'none', 'UNVERIFIED_DISCARD_WINDOW');
      const current = projected.state!, drawnRef = current.drawnTileRef;
      requireThat(drawnRef.known && drawnRef.value !== null, 'DRAWN_TILE_UNKNOWN');
      const windowId = `window-${digest([projection.gameMatchKey, projection.gameHandKey, context.connectionEpoch, sourceCursor]).slice(0, 24)}`;
      const evidenceId = eventIdFor(projection.sessionId, projection.sequence + 1);
      const candidates: LegalAction[] = current.ownConcealed.map(t => ({
        id: `discard-${digest([windowId, t.instanceId]).slice(0, 24)}`,
        action: { kind: 'discard', tile: t.instanceId, tsumogiri: t.instanceId === drawnRef.value },
        authority: 'executor', label: `打 ${t.code}`, evidenceEventIds: [evidenceId],
      }));
      append('OperationOffered', { window: { id: windowId, connectionEpoch: context.connectionEpoch,
        openedAt: context.receivedAt,
        deadline: unknown('DEADLINE_PROVENANCE_UNVERIFIED'),
        candidates, status: 'open' } }, 'window');
    }
  }
  return observations;
}
