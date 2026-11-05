import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { exportLiveCapture } from '../src/app/live-capture.ts';
import { inspectDatabase, loadReplay, replay } from '../src/app/replay.ts';
import { normalizeAction } from '../src/adapters/majsoul/normalize.ts';
import { handSourceStream, normalizeSyncGame } from '../src/adapters/majsoul/sync.ts';
import { initialProjection, reduceObservation, reduceSync } from '../src/domain/game/reducer.ts';
import type { GameObservation } from '../src/domain/game/types.ts';
import { digest } from '../src/domain/game/value.ts';

/** Contract input only: these generated protocol actions are never real-client evidence. */
function captureInput() {
  const receivedAt = '2026-11-05T00:00:20.000Z', sessionId = 'capture-contract-test', gameMatchKey = 'test-match', gameHandKey = 'test-hand';
  const opening = { chang: 0, ju: 0, ben: 0, liqibang: 0, scores: [25000,25000,25000,25000], left_tile_count: 69,
    doras: ['4z'], tiles: initialView().ownConcealed.map(t => t.code.endsWith('r') ? `0${t.code[1]}` : t.code) };
  const actions: { name: string; step: number; data: object }[] = [{ name: 'ActionNewRound', step: 1, data: opening }];
  const discard = (seat: number, tile: string, moqie: boolean) => ({ seat, tile, moqie, is_liqi: false, is_wliqi: false });
  actions.push({ name: 'ActionDiscardTile', step: 2, data: discard(0, '0m', false) });
  for (const [seat, tile] of [[1, '9s'], [2, '2z'], [3, '4p']] as const) {
    actions.push({ name: 'ActionDealTile', step: seat * 2 + 1, data: { seat, tile: 'DO_NOT_ARCHIVE_HIDDEN_TILE', left_tile_count: 69 - seat } });
    actions.push({ name: 'ActionDiscardTile', step: seat * 2 + 2, data: discard(seat, tile, false) });
  }
  actions.push({ name: 'ActionDealTile', step: 9, data: { seat: 0, tile: '5m', left_tile_count: 65,
    operation: { seat: 0, operation_list: [{ type: 1 }], time_fixed: 300000, time_add: 0 } } });
  const sync = normalizeSyncGame({ error: null, is_end: false, step: 10, game_restore: { actions,
    snapshot: { account_id: 'DO_NOT_ARCHIVE_ACCOUNT', hands: ['DO_NOT_ARCHIVE_HIDDEN_HAND'] } } }, {
    sessionId, room: buildPhase1Fixture().projection.room!, gameMatchKey, gameHandKey, ownSeat: 0, handOrdinal: 1,
    syncId: 'capture-sync', connectionEpoch: 7, receivedAt,
    timing: { source: 'client-countdown', step: 9, sampledAt: receivedAt, remainingMs: 280000, uncertaintyMs: 1000 } });
  const projection = reduceSync(initialProjection(sessionId), sync);
  const subsequent = normalizeAction('ActionDiscardTile', discard(0, '5m', true), {
    projection, sourceStream: handSourceStream(gameMatchKey, gameHandKey), step: 10, receivedAt: '2026-11-05T00:00:21.000Z', connectionEpoch: 7 });
  return { sync, sessionId, subsequent, projection };
}

test('captured complete source-hand facts replay through SQLite with epoch 0 and no resurrected operation windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-live-capture-'));
  try {
    const { sync, sessionId, subsequent, projection } = captureInput();
    const before = digest(sync), expectedLive = subsequent.reduce(reduceObservation, projection);
    assert.equal(projection.state!.operationWindow!.status, 'open');
    const exported = await exportLiveCapture(join(directory, 'capture'), sessionId, sync, subsequent, 'test-client-version');
    const fixture = await loadReplay(exported.directory);
    assert.equal(fixture.manifest.evidenceKind, 'live-capture');
    assert.equal(fixture.events.every(e => e.connectionEpoch === 0), true);
    assert.equal(fixture.events.some(e => e.type === 'OperationOffered' || e.type === 'OperationClosed'), false);
    assert.equal(fixture.events.filter(e => e.type === 'TileDiscarded').length, 5);
    assert.equal(fixture.events.filter(e => e.type === 'TileDiscarded' && e.payload.actor === 0).length, 2);
    const report = await replay(exported.directory, { outputDirectory: join(directory, 'replay') });
    assert.equal(report.status, 'passed'); assert.equal(report.ownDiscardFacts, 2); assert.equal(report.preview, null);
    const stored = await inspectDatabase(report.databasePath, sessionId), state = stored.projection.state!;
    assert.equal(state.connectionEpoch, 0); assert.equal(state.operationWindow, undefined);
    assert.equal(state.drawnTileRef.known && state.drawnTileRef.value, null);
    assert.equal(state.ownConcealed.length, 13);
    assert.deepEqual(state.ownConcealed.map(t => t.code), expectedLive.state!.ownConcealed.map(t => t.code));
    assert.equal(state.ownConcealed.filter(t => t.code === '5m').length, 2);
    assert.equal(new Set(state.ownConcealed.map(t => t.instanceId)).size, 13);
    assert.equal(state.ownConcealed.every(t => t.instanceId.includes(':e0:')), true);
    assert.equal(stored.counts.confirmations, 0); assert.equal(stored.attempts.length, 0);
    assert.equal(digest(sync), before);
    const archive = await readFile(join(exported.directory, 'events.jsonl'), 'utf8');
    assert.equal(archive.includes('DO_NOT_ARCHIVE'), false);
    assert.equal(archive.includes('280000'), false);
    await assert.rejects(replay(exported.directory, { outputDirectory: join(directory, 'preview'), dryRunCandidate: 0 }), /WINDOW_CLOSED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('capture without subsequent action still strips executable offers and retains exact ordinary tile instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-live-capture-window-'));
  try {
    const { sync, sessionId, projection } = captureInput();
    const result = await exportLiveCapture(join(directory, 'capture'), sessionId, sync, [], 'test-client-version');
    const fixture = await loadReplay(result.directory), final = fixture.events.reduce(reduceObservation, initialProjection(sessionId));
    assert.equal(final.state!.operationWindow, undefined);
    assert.equal(final.state!.ownConcealed.length, 14);
    const fives = final.state!.ownConcealed.filter(t => t.code === '5m');
    assert.equal(fives.length, 3); assert.equal(new Set(fives.map(t => t.instanceId)).size, 3);
    assert.equal(final.state!.drawnTileRef.known && final.state!.drawnTileRef.value, fives.at(-1)!.instanceId);
    assert.notEqual(final.state!.drawnTileRef.known && final.state!.drawnTileRef.value, projection.state!.drawnTileRef.known && projection.state!.drawnTileRef.value);
    assert.equal(result.expected.ownDiscardFacts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('capture rejects incomplete, stale source histories and unknown fields before creating a replay directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-live-capture-invalid-'));
  try {
    const { sync, sessionId, subsequent } = captureInput();
    const target = join(directory, 'capture');
    await assert.rejects(exportLiveCapture(target, sessionId, { ...sync, historyCoverage: 'partial' }, subsequent, 'test-client-version'), /CAPTURE_HISTORY_REQUIRED/);
    const gapped = structuredClone(subsequent); gapped[0]!.sourceCursor = `${handSourceStream('test-match', 'test-hand')}:11`;
    await assert.rejects(exportLiveCapture(target, sessionId, sync, gapped, 'test-client-version'), /SOURCE_GAP/);
    const bad = [{ ...subsequent[0]!, account_id: 'DO_NOT_ARCHIVE' }] as unknown as GameObservation[];
    await assert.rejects(exportLiveCapture(target, sessionId, sync, bad, 'test-client-version'), /INVALID_FIELDS/);
    // An own meld contains references from the live epoch. Until explicit
    // mapping exists, exporting it would silently consume different instances.
    const ownMeld = { ...subsequent[0]!, type: 'MeldDeclared', payload: {
      meld: { id: 'own-live-meld', actor: 0, kind: 'pon', tiles: ['5m','5m','5m'], fromSeat: 3, calledTileIndex: 2 },
      consumed: ['live:e7:tile:1', 'live:e7:tile:2'] } } as GameObservation;
    await assert.rejects(exportLiveCapture(target, sessionId, sync, [ownMeld], 'test-client-version'), /CAPTURE_OWN_MELD_MAPPING_REQUIRED/);
    const first = await exportLiveCapture(target, sessionId, sync, subsequent, 'test-client-version');
    const manifest = await readFile(join(first.directory, 'manifest.json'), 'utf8');
    await assert.rejects(exportLiveCapture(target, sessionId, sync, [], 'test-client-version'), { code: 'EEXIST' });
    assert.equal(await readFile(join(first.directory, 'manifest.json'), 'utf8'), manifest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
