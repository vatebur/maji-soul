import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { normalizeAction, normalizeNewRound } from '../src/adapters/majsoul/normalize.ts';
import { handSourceStream, normalizeSyncGame, type SyncGameContext } from '../src/adapters/majsoul/sync.ts';
import { initialProjection, reduceObservation, reduceSync } from '../src/domain/game/reducer.ts';
import { digest } from '../src/domain/game/value.ts';
import type { GameProjection } from '../src/domain/game/types.ts';

const at = '2026-11-05T00:00:20.000Z';
const room = buildPhase1Fixture().projection.room!;
function setup() {
  const context: SyncGameContext = { sessionId: 'sync-test', room, gameMatchKey: 'match', gameHandKey: 'client-round-unique',
    ownSeat: 0, handOrdinal: 1, syncId: 'sync-1', connectionEpoch: 1, receivedAt: at };
  const wire = (code: string) => code.endsWith('r') ? `0${code[1]}` : code;
  const opening = { chang: 0, ju: 0, ben: 0, liqibang: 0, left_tile_count: 69, scores: [25000,25000,25000,25000],
    tiles: initialView().ownConcealed.map(t => wire(t.code)), doras: ['4z'], opens: [{ seat: 0, tiles: [] }], operation: null };
  const discard = (seat: number, tile: string, moqie = false) => ({ seat, tile, moqie, is_liqi: false, is_wliqi: false });
  const actions = [
    { name: 'ActionMJStart', step: 0, data: {} },
    { name: 'ActionNewRound', step: 1, data: opening },
    { name: 'ActionDiscardTile', step: 2, data: discard(0, '0m', false) },
    { name: 'ActionDealTile', step: 3, data: { seat: 1, tile: 'HIDDEN_DO_NOT_KEEP', left_tile_count: 68 } },
    { name: 'ActionDiscardTile', step: 4, data: { ...discard(1, '9s'), operation: { seat: 0, operation_list: [{ type: 2, combination: ['7s|8s'] }] } } },
    { name: 'ActionDealTile', step: 5, data: { seat: 2, tile: '', left_tile_count: 67 } },
    { name: 'ActionDiscardTile', step: 6, data: discard(2, '2z') },
    { name: 'ActionDealTile', step: 7, data: { seat: 3, tile: '', left_tile_count: 66 } },
    { name: 'ActionDiscardTile', step: 8, data: discard(3, '4p') },
    { name: 'ActionDealTile', step: 9, data: { seat: 0, tile: '5m', left_tile_count: 65,
      operation: { seat: 0, operation_list: [{ type: 1 }], time_fixed: 300000, time_add: 0 } } },
  ];
  const response = { error: null, is_end: false, step: 10, game_restore: { actions, snapshot: { token: 'SECRET', hands: ['HIDDEN'] } } };
  return { context, response, opening, actions };
}

test('complete decoded restore rebuilds current view and independently validates each source step', () => {
  const { context, response } = setup();
  const sync = normalizeSyncGame(response, context), restored = reduceSync(initialProjection(context.sessionId), sync);
  assert.equal(sync.historyCoverage, 'complete-hand'); assert.equal(sync.handHistory[0]!.type, 'HandStarted');
  assert.equal(sync.sourceCursor, `${handSourceStream('match', 'client-round-unique')}:9`);
  assert.equal(sync.observedActions.length, 4); assert.equal(restored.state!.trust, 'trusted');
  assert.equal(restored.state!.ownConcealed.filter(t => t.code === '5m').length, 3);
  assert.equal(restored.state!.ownConcealed.length, 14);
  assert.equal(restored.state!.players[1].river[0]!.tile, '9s');
  assert.equal(JSON.stringify(sync).includes('HIDDEN_DO_NOT_KEEP'), false); assert.equal(JSON.stringify(sync).includes('SECRET'), false);
  assert.deepEqual(restored.state!.operationWindow!.deadline, { known: false, reason: 'DEADLINE_PROVENANCE_UNVERIFIED' });
  const sync2 = normalizeSyncGame(response, { ...context, syncId: 'sync-2', connectionEpoch: 2 });
  const reconnected = reduceSync(restored, sync2);
  assert.notEqual(restored.state!.ownConcealed[0]!.instanceId, reconnected.state!.ownConcealed[0]!.instanceId);
  assert.equal(reconnected.state!.players[0].river.length, restored.state!.players[0].river.length);
});

test('fresh-session restore keeps historical river references separate from subsequent ledger events', () => {
  const { context, response } = setup(), sync = normalizeSyncGame(response, context), before = digest(sync);
  const restored = reduceSync(initialProjection(context.sessionId), sync);
  assert.equal(restored.sequence, 1);
  const restoredIds = Object.values(restored.state!.players).flatMap(player => player.river.map(discard => discard.eventId));
  const another = normalizeSyncGame(response, { ...context, syncId: 'independent-sync' });
  assert.notDeepEqual(Object.values(another.currentView!.players).flatMap(player => player.river.map(discard => discard.eventId)), restoredIds);
  assert.deepEqual(another.observedActions.map(event => event.sourceDedupKey), sync.observedActions.map(event => event.sourceDedupKey));
  let projection = restored;
  const continuation = [
    { name: 'ActionDiscardTile', payload: { seat: 0, tile: '5m', moqie: true, is_liqi: false, is_wliqi: false } },
    { name: 'ActionDealTile', payload: { seat: 1, left_tile_count: 64 } },
    { name: 'ActionDiscardTile', payload: { seat: 1, tile: '9s', moqie: true, is_liqi: false, is_wliqi: false } },
  ];
  for (const [index, action] of continuation.entries()) {
    const events = normalizeAction(action.name, action.payload, { projection, sourceStream: handSourceStream(context.gameMatchKey, context.gameHandKey),
      step: 10 + index, connectionEpoch: context.connectionEpoch, receivedAt: at });
    projection = events.reduce(reduceObservation, projection);
  }
  const riverIds = Object.values(projection.state!.players).flatMap(player => player.river.map(discard => discard.eventId));
  assert.equal(projection.sequence, 4);
  assert.equal(riverIds.length, 6); assert.equal(new Set(riverIds).size, 6);
  assert.equal(projection.state!.players[1].river.at(-1)!.eventId, `${context.sessionId}:event:4`);
  assert.equal(projection.state!.latestAction!.eventId, projection.state!.players[1].river.at(-1)!.eventId);
  assert.equal(digest(sync), before);
});

test('only a matching fresh client countdown gives a bounded deadline', () => {
  const { context, response } = setup();
  const timing = { source: 'client-countdown' as const, step: 9, sampledAt: at, remainingMs: 280000, uncertaintyMs: 1000 };
  const sync = normalizeSyncGame(response, { ...context, timing });
  assert.deepEqual(sync.currentView!.operationWindow!.deadline, { known: true, value: {
    at: '2026-11-05T00:05:00.000Z', uncertaintyMs: 1000,
    sourceEventId: sync.handHistory.at(-1)!.type === 'OperationOffered' ? sync.currentView!.operationWindow!.candidates[0]!.evidenceEventIds[0] : '' } });
  assert.throws(() => normalizeSyncGame(response, { ...context, timing: { ...timing, step: 8 } }), /TIMING_SCOPE_MISMATCH/);
  assert.throws(() => normalizeSyncGame(response, { ...context, timing: { ...timing, remainingMs: 300001 } }), /COUNTDOWN_READBACK_MISMATCH/);
  assert.throws(() => normalizeSyncGame(response, { ...context, timing: { ...timing, sampledAt: '2026-11-05T00:00:00.000Z' } }), /COUNTDOWN_READBACK_MISMATCH/);
});

test('snapshot-only, history gaps, unknown actions and wrong next-step cannot create a trusted sync', () => {
  const { context, response } = setup(), before = digest(response);
  assert.throws(() => normalizeSyncGame({ ...response, game_restore: { snapshot: {}, actions: [] } }, context), /SYNC_ACTIONS_REQUIRED/);
  const gapped = structuredClone(response); gapped.game_restore.actions.splice(5, 1);
  assert.throws(() => normalizeSyncGame(gapped, context), /SYNC_HISTORY_GAP/);
  const unknown = structuredClone(response); unknown.game_restore.actions[5]!.name = 'ActionUnknown';
  assert.throws(() => normalizeSyncGame(unknown, context), /UNSUPPORTED_PROTOCOL_ACTION/);
  assert.throws(() => normalizeSyncGame({ ...response, step: 9 }, context), /SYNC_NEXT_STEP_MISMATCH/);
  assert.throws(() => normalizeSyncGame({ ...response, is_end: true }, context), /SYNC_TERMINAL_EVIDENCE_REQUIRED/);
  assert.equal(digest(response), before);
});

test('public pon facts preserve exact called-tile index and own physical consumed references', () => {
  const fixture = buildPhase1Fixture();
  let projection: GameProjection = fixture.events.slice(0, 3).reduce(reduceObservation, initialProjection('fixture-phase1-discard'));
  const base = { sourceStream: 'fixture-hand-1', connectionEpoch: 0, receivedAt: at };
  for (const o of normalizeAction('ActionDiscardTile', { seat: 0, tile: '1m', moqie: false, is_liqi: false, is_wliqi: false }, { ...base, projection, step: 2 })) projection = reduceObservation(projection, o);
  const events = normalizeAction('ActionChiPengGang', { seat: 1, type: 1, tiles: ['1m','1m','1m'], froms: [1,0,1], operation: null }, { ...base, projection, step: 3 });
  const next = events.reduce(reduceObservation, projection);
  assert.equal(next.state!.players[0].river[0]!.calledBy, 1);
  assert.equal(next.state!.players[1].melds[0]!.calledTileIndex, 1);
  assert.equal(next.state!.players[1].concealedCount.known && next.state!.players[1].concealedCount.value, 11);
  assert.throws(() => normalizeAction('ActionChiPengGang', { seat: 1, type: 1, tiles: ['1m','1m','1m'], froms: [2,0,1] }, { ...base, projection, step: 3 }), /INVALID_PROTOCOL_MELD_SOURCE/);
});

test('new-round metadata validates dealer opening count and preserves absolute seat winds', () => {
  const { opening } = setup(), fixture = buildPhase1Fixture();
  const projection = fixture.events.slice(0, 2).reduce(reduceObservation, initialProjection('fixture-phase1-discard'));
  const context = { projection, sourceStream: 'new-hand', step: 1, receivedAt: at, connectionEpoch: 0,
    ownSeat: 0 as const, gameHandKey: 'new-hand-key', handOrdinal: 1 };
  const events = normalizeNewRound(opening, context), state = events.reduce(reduceObservation, projection).state!;
  assert.equal(state.dealer, 0); assert.equal(state.ownSeat, 0); assert.deepEqual(state.drawnTileRef, { known: true, value: null });
  assert.throws(() => normalizeNewRound({ ...opening, tiles: opening.tiles.slice(0, 13) }, context), /INVALID_OPENING_HAND/);
  assert.throws(() => normalizeNewRound({ ...opening, opens: [{ seat: 1, tiles: ['1m'] }] }, context), /UNSUPPORTED_REVEALED_HAND/);
});

test('dealer opening array order never assigns a drawn instance or revives a discard window', () => {
  const { opening } = setup(), fixture = buildPhase1Fixture();
  const projection = fixture.events.slice(0, 2).reduce(reduceObservation, initialProjection('fixture-phase1-discard'));
  const context = { projection, sourceStream: 'opening-order', step: 1, receivedAt: at, connectionEpoch: 0,
    ownSeat: 0 as const, gameHandKey: 'opening-order-key', handOrdinal: 1 };
  const offered = { seat: 0, operation_list: [{ type: 1 }], time_fixed: 300000, time_add: 0 };
  const events = normalizeNewRound({ ...opening, operation: offered }, context);
  assert.equal(events.length, 1);
  const started = events.reduce(reduceObservation, projection);
  assert.equal(started.state!.operationWindow, undefined);
  assert.deepEqual(started.state!.drawnTileRef, { known: true, value: null });
  // Both the final encoded entry and a different visible tile may be the
  // server-confirmed initial hand discard. Neither is called tsumogiri.
  for (const tile of ['0m', '1m']) {
    const observations = normalizeAction('ActionDiscardTile', { seat: 0, tile, moqie: false, is_liqi: false, is_wliqi: false },
      { ...context, projection: started, step: 2 });
    assert.equal(observations.reduce(reduceObservation, started).state!.ownConcealed.length, 13);
  }
  assert.throws(() => normalizeAction('ActionDiscardTile', { seat: 0, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false },
    { ...context, projection: started, step: 2 }), /DISCARD_TILE_MISSING/);
});

test('own pon consumes distinct same-code instances and never creates opponent tile references', () => {
  const fixture = buildPhase1Fixture(), base = { sourceStream: 'fixture-hand-1', connectionEpoch: 0, receivedAt: at };
  let projection = fixture.events.slice(0, 10).reduce(reduceObservation, initialProjection('fixture-phase1-discard'));
  for (const o of normalizeAction('ActionDiscardTile', { seat: 3, tile: '5m', moqie: false, is_liqi: false, is_wliqi: false }, { ...base, projection, step: 8 })) projection = reduceObservation(projection, o);
  const ownFives = projection.state!.ownConcealed.filter(t => t.code === '5m').map(t => t.instanceId);
  const meld = normalizeAction('ActionChiPengGang', { seat: 0, type: 1, tiles: ['5m','5m','5m'], froms: [0,0,3] }, { ...base, projection, step: 9 });
  assert.equal(meld[0]!.type, 'MeldDeclared');
  if (meld[0]!.type === 'MeldDeclared') assert.deepEqual(meld[0]!.payload.consumed, ownFives);
  const after = meld.reduce(reduceObservation, projection);
  assert.equal(after.state!.ownConcealed.some(t => ownFives.includes(t.instanceId)), false);
  assert.equal(after.state!.players[3].river.at(-1)!.calledBy, 0);
});

test('riichi acceptance applies only the explicit seat score and verifies the 1000 point deposit', () => {
  const fixture = buildPhase1Fixture(), base = { sourceStream: 'fixture-hand-1', connectionEpoch: 0, receivedAt: at };
  let projection = fixture.events.slice(0, 3).reduce(reduceObservation, initialProjection('fixture-phase1-discard'));
  for (const o of normalizeAction('ActionDiscardTile', { seat: 0, tile: '0m', moqie: true, is_liqi: true, is_wliqi: false }, { ...base, projection, step: 2 })) projection = reduceObservation(projection, o);
  const liqi = { seat: 0, score: 24000, liqibang: 1, failed: false };
  const events = normalizeAction('ActionDealTile', { seat: 1, left_tile_count: 68, liqi }, { ...base, projection, step: 3 });
  const after = events.reduce(reduceObservation, projection);
  assert.equal(after.state!.players[0].score, 24000); assert.equal(after.state!.players[1].score, 25000);
  assert.equal(after.state!.players[0].riichi, 'accepted'); assert.equal(after.state!.riichiSticks, 1);
  assert.equal(events[0]!.type, 'RiichiAccepted'); assert.equal(events[0]!.sourceCursor, undefined);
  assert.throws(() => normalizeAction('ActionDealTile', { seat: 1, left_tile_count: 68, liqi: { ...liqi, score: 23000 } }, { ...base, projection, step: 3 }), /RIICHI_SCORE_MISMATCH/);
  assert.throws(() => normalizeAction('ActionDealTile', { seat: 1, left_tile_count: 68, liqi: { ...liqi, failed: true } }, { ...base, projection, step: 3 }), /UNSUPPORTED_RIICHI_RESULT/);
});
