import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import { initialProjection, reduceObservation } from '../src/domain/game/reducer.ts';
import { legalOperationActions, mapActionToRequest } from '../src/adapters/majsoul/actions.ts';
import { selectAkagiAction } from '../src/adapters/engine/akagi.ts';
import type { DecisionSnapshot } from '../src/domain/game/types.ts';

function setup(combinations: string[]) {
  const p = buildPhase1Fixture().events.slice(0, 3).reduce(reduceObservation, initialProjection('akagi-riichi'));
  const state = p.state!;
  const offered = { seat: state.ownSeat, operation_list: [{ type: 1, combination: [] }, { type: 7, combination: combinations }] };
  const legalActions = legalOperationActions(state, offered, 'window', 'evidence');
  const snapshot: DecisionSnapshot = {
    schemaVersion: 1, id: 'decision', scope: { sessionId: state.sessionId, matchId: state.matchId, handId: state.handId, decisionId: 'decision' },
    state, legalActions, windowId: 'window', stateVersion: state.stateVersion, connectionEpoch: state.connectionEpoch, controlEpoch: 0,
    createdAt: '2026-11-07T00:00:00.000Z', actionDeadline: '2026-11-07T00:01:00.000Z', activeMode: 'engine',
    unknownFields: [], contextEventIds: [], sourceCursor: p.sourceCursor!,
  };
  return { snapshot, offered };
}

test('Akagi riichi uses an explicitly offered red five when its ordinary five is absent', () => {
  const { snapshot, offered } = setup(['0m']);
  const action = selectAkagiAction(snapshot, { kind: 'riichi-discard', tile: '5m' }, false);
  assert.ok(snapshot.legalActions.includes(action));
  assert.deepEqual(mapActionToRequest(action.action, snapshot.state, offered).params, { type: 7, tile: '0m', moqie: true, timeuse: 0 });
  assert.throws(() => selectAkagiAction(snapshot, { kind: 'riichi-discard', tile: '5s' }, false), /AKAGI_ACTION_NOT_OFFERED/);
  assert.throws(() => selectAkagiAction(snapshot, { kind: 'riichi-discard', tile: '4m' }, false), /AKAGI_ACTION_NOT_OFFERED/);
});

test('Akagi keeps exact red identity when offered and never substitutes for ordinary discards', () => {
  const { snapshot, offered } = setup(['0m', '5m']);
  for (const tile of ['5m', '5mr']) {
    const action = selectAkagiAction(snapshot, { kind: 'riichi-discard', tile }, false);
    const request = mapActionToRequest(action.action, snapshot.state, offered);
    assert.equal(request.params.tile, tile === '5mr' ? '0m' : '5m');
  }
  snapshot.legalActions = snapshot.legalActions.filter(c => {
    const action = c.action;
    return action.kind !== 'discard' || snapshot.state.ownConcealed.find(t => t.instanceId === action.tile)?.code !== '5m';
  });
  assert.throws(() => selectAkagiAction(snapshot, { kind: 'discard', tile: '5m', tsumogiri: false }, false), /AKAGI_ACTION_NOT_OFFERED/);
});
