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

/** Generated legal action histories; these exercise capture mechanics, not live evidence. */
function meldCaptureInput(kind: 'chi' | 'pon' | 'open-kan' | 'added-kan') {
  const receivedAt = '2026-11-05T00:00:20.000Z', sessionId = `capture-${kind}`, gameMatchKey = 'meld-match', gameHandKey = `meld-hand-${kind}`;
  const filler = ['1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s'];
  const call = {
    chi: { owned: ['3m','0m'], tile: '4m', type: 0, tiles: ['4m','0m','3m'], froms: [3,0,0] },
    pon: { owned: ['5m','0m'], tile: '5m', type: 1, tiles: ['5m','0m','5m'], froms: [3,0,0] },
    'open-kan': { owned: ['5m','0m','5m'], tile: '5m', type: 2, tiles: ['5m','5m','0m','5m'], froms: [0,3,0,0] },
    'added-kan': { owned: ['5m','5m'], tile: '5m', type: 1, tiles: ['5m','5m','5m'], froms: [0,0,3] },
  }[kind];
  const actions: { name: string; step: number; data: object }[] = [];
  const append = (name: string, data: object) => actions.push({ name, step: actions.length + 1, data });
  const discard = (seat: number, tile: string, moqie: boolean) => ({ seat, tile, moqie, is_liqi: false, is_wliqi: false });
  append('ActionNewRound', { chang: 0, ju: 3, ben: 1, liqibang: 0, scores: [25000,25000,25000,25000], left_tile_count: 69,
    doras: ['4z'], opens: [], tiles: [...call.owned, ...filler.slice(0, 13 - call.owned.length)] });
  append('ActionDiscardTile', discard(3, call.tile, true));
  append('ActionChiPengGang', { seat: 0, type: call.type, tiles: call.tiles, froms: call.froms });
  if (kind === 'added-kan') {
    append('ActionDiscardTile', discard(0, '1p', false));
    for (const [seat, tile] of [[1,'9s'], [2,'2z'], [3,'3z']] as const) {
      append('ActionDealTile', { seat, left_tile_count: 69 - seat });
      append('ActionDiscardTile', discard(seat, tile, true));
    }
    append('ActionDealTile', { seat: 0, tile: '0m', left_tile_count: 65 });
  }
  const sync = normalizeSyncGame({ is_end: false, step: actions.length + 1, game_restore: { actions } }, {
    sessionId, room: buildPhase1Fixture().projection.room!, gameMatchKey, gameHandKey, ownSeat: 0, handOrdinal: 5,
    syncId: `capture-sync-${kind}`, connectionEpoch: 7, receivedAt });
  const projection = reduceSync(initialProjection(sessionId), sync);
  let live = projection, step = actions.length;
  const subsequent: GameObservation[] = [];
  const observe = (name: string, data: object) => {
    const events = normalizeAction(name, data, { projection: live, sourceStream: handSourceStream(gameMatchKey, gameHandKey),
      step: ++step, receivedAt: '2026-11-05T00:00:21.000Z', connectionEpoch: 7 });
    live = events.reduce(reduceObservation, live); subsequent.push(...events);
  };
  if (kind === 'added-kan') observe('ActionAnGangAddGang', { seat: 0, type: 2, tiles: '0m' });
  if (kind === 'open-kan' || kind === 'added-kan') {
    observe('ActionDealTile', { seat: 0, tile: '4s', left_tile_count: kind === 'added-kan' ? 64 : 68 });
    observe('ActionDiscardTile', discard(0, '4s', true));
  } else observe('ActionDiscardTile', discard(0, '1p', false));
  return { sync, sessionId, subsequent, expectedLive: live };
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

test('capture rebases legal own melds with red fives from hand 5 and replays the called river', async t => {
  for (const kind of ['chi','pon','open-kan','added-kan'] as const) await t.test(kind, async () => {
    const directory = await mkdtemp(join(tmpdir(), `maji-live-capture-${kind}-`));
    try {
      const { sync, sessionId, subsequent, expectedLive } = meldCaptureInput(kind);
      const before = digest(sync), subsequentBefore = digest(subsequent);
      assert.equal(sync.handOrdinal, 5);
      assert.equal(sync.handHistory[0]!.type === 'HandStarted' && sync.handHistory[0]!.payload.ordinal, 5);
      const exported = await exportLiveCapture(join(directory, 'capture'), sessionId, sync, subsequent, 'test-client-version');
      const fixture = await loadReplay(exported.directory);
      assert.equal(fixture.manifest.originHandOrdinal, 5);
      assert.equal(fixture.expected.finalHandOrdinal, 1);
      assert.deepEqual(fixture.events.filter(e => e.type === 'HandStarted').map(e => e.payload.ordinal), [1]);
      assert.equal(fixture.events.every(e => e.connectionEpoch === 0), true);
      const originalMelds = [...sync.handHistory, ...subsequent].filter(e => e.type === 'MeldDeclared');
      const consumedCodes = kind === 'chi' ? [['5mr','3m']] : kind === 'pon' ? [['5mr','5m']]
        : kind === 'open-kan' ? [['5m','5mr','5m']] : [['5m','5m'], ['5mr']];
      let prior = initialProjection(sessionId), meldIndex = 0;
      for (const event of fixture.events) {
        if (event.type === 'MeldDeclared') {
          const original = originalMelds[meldIndex]!;
          assert.deepEqual(event.payload.meld, original.payload.meld);
          assert.notDeepEqual(event.payload.consumed, original.payload.consumed);
          assert.equal(event.payload.consumed.every(ref => ref.includes(':e0:')), true);
          assert.equal(original.payload.consumed.every(ref => ref.includes(':e7:')), true);
          assert.deepEqual(event.payload.consumed.map(ref => prior.state!.ownConcealed.find(tile => tile.instanceId === ref)?.code), consumedCodes[meldIndex]);
          meldIndex++;
        }
        prior = reduceObservation(prior, event);
      }
      assert.equal(meldIndex, consumedCodes.length);
      const report = await replay(exported.directory, { outputDirectory: join(directory, 'replay') });
      assert.equal(report.status, 'passed'); assert.equal(report.finalHandOrdinal, 1);
      assert.equal(report.ownDiscardFacts, kind === 'added-kan' ? 2 : 1);
      const stored = await inspectDatabase(report.databasePath, sessionId), state = stored.projection.state!;
      assert.equal(stored.projection.handOrdinal, 1); assert.equal(state.connectionEpoch, 0);
      assert.deepEqual(state.players[0].melds, expectedLive.state!.players[0].melds);
      const meld = state.players[0].melds[0]!;
      assert.equal(meld.kind, kind); assert.equal(meld.tiles.filter(tile => tile === '5mr').length, 1);
      assert.equal(state.players[3].river[0]!.calledBy, 0);
      assert.equal(state.players[3].river[0]!.tile, meld.tiles[meld.calledTileIndex!]);
      if (kind === 'added-kan') assert.equal(meld.upgradedFrom, originalMelds[0]!.payload.meld.id);
      assert.deepEqual(state.ownConcealed.map(tile => tile.code), expectedLive.state!.ownConcealed.map(tile => tile.code));
      assert.equal(state.ownConcealed.length, 10);
      assert.equal(state.ownConcealed.some(tile => tile.code === '5mr'), false);
      assert.equal(state.operationWindow, undefined); assert.equal(stored.counts.confirmations, 0); assert.equal(stored.attempts.length, 0);
      assert.equal(digest(sync), before); assert.equal(digest(subsequent), subsequentBefore);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
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
    // Rebinding references cannot legitimize a meld without the matching called river.
    const ownMeld = { ...subsequent[0]!, type: 'MeldDeclared', payload: {
      meld: { id: 'own-live-meld', actor: 0, kind: 'pon', tiles: ['5m','5m','5m'], fromSeat: 3, calledTileIndex: 2 },
      consumed: ['live:e7:tile:1', 'live:e7:tile:2'] } } as GameObservation;
    await assert.rejects(exportLiveCapture(target, sessionId, sync, [ownMeld], 'test-client-version'), /MELD_|CALLED_/);
    const first = await exportLiveCapture(target, sessionId, sync, subsequent, 'test-client-version');
    const manifest = await readFile(join(first.directory, 'manifest.json'), 'utf8');
    await assert.rejects(exportLiveCapture(target, sessionId, sync, [], 'test-client-version'), { code: 'EEXIST' });
    assert.equal(await readFile(join(first.directory, 'manifest.json'), 'utf8'), manifest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
