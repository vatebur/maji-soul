import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPhase1Fixture, FIXTURE_SESSION } from '../scripts/build-phase1-fixtures.ts';
import { normalizeAction, majsoulTile } from '../src/adapters/majsoul/normalize.ts';
import { initialProjection, reduceObservation } from '../src/domain/game/reducer.ts';
import type { GameProjection } from '../src/domain/game/types.ts';
import { digest } from '../src/domain/game/value.ts';
import { parseObservation } from '../src/schemas/game.ts';

function atSequence(sequence: number): GameProjection {
  return buildPhase1Fixture().events.slice(0, sequence).reduce(reduceObservation, initialProjection(FIXTURE_SESSION));
}
const context = (projection: GameProjection, step: number) => ({ projection, sourceStream: 'fixture-hand-1', step,
  receivedAt: '2026-11-05T00:00:20.000Z', connectionEpoch: 0 });

test('tracked synthetic replay is deterministic, distinguishes red/ordinary/physical duplicates and resets on dealer repeat', async () => {
  const directory = new URL('./fixtures/phase1-discard/', import.meta.url);
  const events = (await readFile(new URL('events.jsonl', directory), 'utf8')).trim().split('\n').map(line => parseObservation(JSON.parse(line)));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const expected = JSON.parse(await readFile(new URL('expected.json', directory), 'utf8'));
  assert.equal(manifest.evidenceKind, 'synthetic');
  assert.equal(digest(events), manifest.eventsSha256);
  const final = events.reduce(reduceObservation, initialProjection(FIXTURE_SESSION));
  assert.equal(digest(final.state), expected.finalStateHash);
  assert.equal(final.sequence, expected.finalSequence);
  assert.deepEqual(events, buildPhase1Fixture().events);
  const first = atSequence(4), firstState = first.state!;
  const fives = firstState.ownConcealed.filter(t => t.code === '5m' || t.code === '5mr');
  assert.deepEqual(fives.map(t => t.code), ['5m', '5m', '5mr']);
  assert.equal(new Set(fives.map(t => t.instanceId)).size, 3);
  assert.equal(firstState.operationWindow!.candidates.filter(c => c.action.kind === 'discard' && fives.some(t => c.action.kind === 'discard' && t.instanceId === c.action.tile)).length, 3);
  assert.notEqual(final.state!.handId, firstState.handId);
  assert.equal(final.state!.handNumber, 1); assert.equal(final.state!.honba, 1);
  assert.equal(final.state!.players[0].river.length, 0);
  assert.equal(final.state!.latestAction, undefined);
  assert.equal(events.filter(e => e.type === 'TileDiscarded' && e.payload.actor === 0).length, expected.ownDiscardFacts);
});

test('decoded actions are projected by whitelist; opponent tile and authentication extras never enter observations', () => {
  const current = atSequence(5);
  const result = normalizeAction('ActionDealTile', { seat: 1, tile: 'DO_NOT_RETAIN_OPPONENT_TILE', left_tile_count: 68,
    cookie: 'DO_NOT_RETAIN_COOKIE', token: 'DO_NOT_RETAIN_TOKEN', account_id: 1234567, hidden_hands: ['DO_NOT_RETAIN_HAND'] }, context(current, 3));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('DO_NOT_RETAIN'), false);
  assert.equal(serialized.includes('account_id'), false);
  assert.equal(serialized.includes('1234567'), false);
  assert.equal(result.length, 1); assert.equal(result[0]!.type, 'TileDrawn');
  if (result[0]!.type === 'TileDrawn') assert.deepEqual(result[0]!.payload.tile, { known: false, reason: 'OPPONENT_HIDDEN_TILE' });
  assert.equal(current.state!.players[1].concealedCount.known && current.state!.players[1].concealedCount.value, 13);
});

test('own draws preserve the red-five code and an ordinary-discard offer retains distinct physical refs', () => {
  const current = atSequence(11);
  const draw = normalizeAction('ActionDealTile', { seat: 0, tile: '0p', left_tile_count: 65 }, context(current, 9));
  assert.equal(draw[0]!.type, 'TileDrawn');
  if (draw[0]!.type === 'TileDrawn') assert.deepEqual(draw[0]!.payload.tile, { known: true, value: '5pr' });
  assert.equal(majsoulTile('0m'), '5mr'); assert.equal(majsoulTile('0s'), '5sr');
  assert.throws(() => majsoulTile('0z'), /INVALID_PROTOCOL_TILE/);
  const events = normalizeAction('ActionDealTile', { seat: 0, tile: '5m', left_tile_count: 65,
    operation: { seat: 0, operation_list: [{ type: 1, combination: [] }], time_fixed: 300000, time_add: 0, token: 'SECRET' } }, context(current, 9));
  const next = events.reduce(reduceObservation, current), window = next.state!.operationWindow!;
  const ordinaryFives = next.state!.ownConcealed.filter(t => t.code === '5m');
  assert.equal(ordinaryFives.length, 3);
  const actions = window.candidates.filter(c => c.action.kind === 'discard' && ordinaryFives.some(t => c.action.kind === 'discard' && t.instanceId === c.action.tile));
  assert.equal(actions.length, 3); assert.equal(new Set(actions.map(c => c.id)).size, 3);
  assert.equal(actions.filter(c => c.action.kind === 'discard' && c.action.tsumogiri).length, 1);
  assert.deepEqual(window.deadline, { known: false, reason: 'DEADLINE_PROVENANCE_UNVERIFIED' });
  assert.equal(JSON.stringify(events).includes('300000'), false);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('unknown operations, restrictions, critical fields and unsupported transitions fail the whole normalization', () => {
  const current = atSequence(11), base = { seat: 0, tile: '5m', left_tile_count: 65 };
  for (const operations of [[{ type: 99 }], [{ type: 1 }, { type: 8 }], [{ type: 1, combination: ['5m'] }]]) {
    assert.throws(() => normalizeAction('ActionDealTile', { ...base, operation: { seat: 0, operation_list: operations } }, context(current, 9)), /UNSUPPORTED_OPERATION|UNVERIFIED_OPERATION_RESTRICTIONS/);
  }
  assert.throws(() => normalizeAction('ActionDealTile', { seat: 0, left_tile_count: 65 }, context(current, 9)), /INVALID_PROTOCOL_TILE/);
  assert.throws(() => normalizeAction('ActionDealTile', { seat: 0, tile: '5m' }, context(current, 9)), /INVALID_INTEGER/);
  assert.throws(() => normalizeAction('ActionDealTile', { ...base, liqi: { seat: 1, score: 24000 } }, context(current, 9)), /INVALID_INTEGER/);
  assert.throws(() => normalizeAction('ActionNewRound', { tiles: ['1m'] }, context(current, 9)), /UNSUPPORTED_PROTOCOL_ACTION/);
  assert.throws(() => normalizeAction('ActionDealTile', base, context(current, 10)), /SOURCE_GAP/);
  assert.throws(() => normalizeAction('ActionDealTile', base, { ...context(current, 9), connectionEpoch: 1 }), /NORMALIZER_STATE_UNTRUSTED/);
  assert.equal(current.sequence, 11);
});

test('discard mapping requires the observed flags and never infers them from a requested action', () => {
  const current = atSequence(4);
  assert.throws(() => normalizeAction('ActionDiscardTile', { seat: 0, tile: '0m', is_liqi: false, is_wliqi: false }, context(current, 2)), /PROTOCOL_BOOLEAN_MISSING/);
  const events = normalizeAction('ActionDiscardTile', { seat: 0, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false,
    requested_action: 'discard-ordinary-five', player: { token: 'SECRET' } }, context(current, 2));
  assert.equal(events.length, 1); const event = events[0]!;
  assert.equal(event.type, 'TileDiscarded');
  if (event.type === 'TileDiscarded') {
    assert.equal(event.payload.tile, '5mr'); assert.deepEqual(event.payload.tsumogiri, { known: true, value: true });
  }
  const final = events.reduce(reduceObservation, current);
  assert.equal(final.state!.ownConcealed.filter(t => t.code === '5m').length, 2);
  assert.equal(final.state!.ownConcealed.some(t => t.code === '5mr'), false);
  assert.equal(final.state!.latestAction!.origin, 'unknown');
});
