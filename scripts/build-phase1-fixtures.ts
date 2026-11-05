import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { GameObservation, GameProjection, HandInitialView, LegalAction, ObservationPayloads, PlayerView, Seat, TileCode } from '../src/domain/game/types.ts';
import { doraFromIndicator, eventIdFor, initialProjection, known, reduceObservation } from '../src/domain/game/reducer.ts';
import { digest } from '../src/domain/game/value.ts';
import { parseObservation } from '../src/schemas/game.ts';
import { normalizeAction } from '../src/adapters/majsoul/normalize.ts';

export const FIXTURE_SESSION = 'fixture-phase1-discard';
export const VIRTUAL_NOW = '2026-11-05T00:00:00.000Z';
const scores = { 0: 25000, 1: 25000, 2: 25000, 3: 25000 };

export function initialView(honba = 0): HandInitialView {
  const tiles: TileCode[] = ['1m', '2m', '3m', '4m', '5m', '5m', '6m', '7p', '8p', '9p', '1s', '2s', '3s', '5mr'];
  const player = (seat: Seat): PlayerView => ({ seat, score: scores[seat], river: [], melds: [], riichi: 'none', concealedCount: known(seat === 0 ? 14 : 13) });
  const players = { 0: player(0), 1: player(1), 2: player(2), 3: player(3) };
  return { ownSeat: 0, players, ownConcealed: tiles.map((code, i) => ({ instanceId: `initial-${i}`, code })),
    drawnTileRef: known('initial-13'), dealer: 0, roundWind: '1z', seatWind: '1z', handNumber: 1, honba, riichiSticks: 0,
    doraIndicators: ['4z'], doraTiles: [doraFromIndicator('4z')], tilesRemaining: known(69), currentActor: known<Seat>(0), unknownFields: [] };
}

export function buildPhase1Fixture() {
  const events: GameObservation[] = [];
  let projection: GameProjection = initialProjection(FIXTURE_SESSION);
  const now = () => new Date(Date.parse(VIRTUAL_NOW) + events.length * 1_000).toISOString();
  function append<K extends keyof ObservationPayloads>(type: K, payload: ObservationPayloads[K], cursor?: string): void {
    const observation = parseObservation({ schemaVersion: 1, observationId: `fixture-observation-${events.length + 1}`,
      connectionEpoch: 0, source: 'majsoul-network', sourceDedupKey: cursor ? `${cursor}:${type}` : `fixture:${events.length + 1}:${type}`,
      receivedAt: now(), ...(cursor ? { sourceCursor: cursor } : {}), type, payload });
    projection = reduceObservation(projection, observation); events.push(observation);
  }
  function wire(name: string, payload: unknown, step: number): void {
    const observations = normalizeAction(name, payload, { projection, sourceStream: 'fixture-hand-1', step, receivedAt: now(), connectionEpoch: 0 });
    for (const observation of observations) { projection = reduceObservation(projection, observation); events.push(observation); }
  }
  function window(): void {
    const state = projection.state!, id = `fixture-window-${projection.handOrdinal}-${projection.sequence}`;
    const candidates: LegalAction[] = state.ownConcealed.map((t, i) => ({
      id: `${id}-discard-${i}`, action: { kind: 'discard', tile: t.instanceId, tsumogiri: state.drawnTileRef.known && t.instanceId === state.drawnTileRef.value },
      authority: 'executor', label: `打 ${t.code}`, evidenceEventIds: [eventIdFor(FIXTURE_SESSION, projection.sequence)],
    }));
    const openedAt = now();
    append('OperationOffered', { window: { id, connectionEpoch: 0, openedAt,
      deadline: known({ at: new Date(Date.parse(openedAt) + 60_000).toISOString(), sourceEventId: eventIdFor(FIXTURE_SESSION, projection.sequence), uncertaintyMs: 10 }),
      candidates, status: 'open' } });
  }
  append('RoomVerified', { room: { roomId: 'synthetic-room', rules: { players: 4, length: 'east', displayTimeSetting: '300+0', computerSeats: 3,
    verifiedOptions: { doraRule: 'standard-riichi', redFives: true }, protocolVersion: 'synthetic-v1' }, autoWin: 'verified-on' }, verifiedAt: now(), evidenceIds: ['synthetic-room-readback'] });
  append('MatchStarted', { roomId: 'synthetic-room', ownSeat: 0, initialScores: scores, gameMatchKey: 'synthetic-match' });
  append('HandStarted', { ordinal: 1, initialView: initialView(), gameHandKey: 'synthetic-hand-1' }, 'fixture-hand-1:1');
  window();
  wire('ActionDiscardTile', { seat: 0, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false }, 2);
  let step = 3;
  for (const [seat, tile] of [[1, '9s'], [2, '2z'], [3, '4p']] as const) {
    wire('ActionDealTile', { seat, left_tile_count: 69 - seat }, step++);
    wire('ActionDiscardTile', { seat, tile, moqie: false, is_liqi: false, is_wliqi: false }, step++);
  }
  wire('ActionDealTile', { seat: 0, tile: '5m', left_tile_count: 65 }, 9);
  window();
  wire('ActionDiscardTile', { seat: 0, tile: '5m', moqie: false, is_liqi: false, is_wliqi: false }, 10);
  append('HandEnded', { scores, reason: 'abortive-draw', winners: [], resultLabel: '合成中止，用于小局边界测试' }, 'fixture-hand-1:11');
  append('HandStarted', { ordinal: 2, initialView: initialView(1), gameHandKey: 'synthetic-hand-2' }, 'fixture-hand-2:1');
  window();
  const expected = { eventCount: events.length, finalStateHash: digest(projection.state), ownDiscardFacts: 2,
    finalSequence: projection.sequence, finalHandOrdinal: projection.handOrdinal, finalOwnTiles: projection.state!.ownConcealed.map(t => t.code) };
  const manifest = { schemaVersion: 1, reducerVersion: '1.0.0', fixtureId: 'phase1-discard', evidenceKind: 'synthetic', sourceVersion: 'synthetic-v1',
    sessionId: FIXTURE_SESSION, virtualNow: VIRTUAL_NOW,
    description: '合成四人东场景：红五、普通五的不同实例、隐藏摸牌、两次弃牌、同东一连庄及新窗口。中止与时钟均为测试输入，不代表真实客户端行为。',
    redaction: 'Only visible domain facts; no credentials, player identities, raw frames, hidden draws, or wall tiles.',
    eventCount: events.length, eventsSha256: digest(events) };
  return { manifest, events, expected, projection };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = buildPhase1Fixture(), directory = new URL('../tests/fixtures/phase1-discard/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('manifest.json', directory), `${JSON.stringify(result.manifest, null, 2)}\n`);
  await writeFile(new URL('events.jsonl', directory), `${result.events.map(e => JSON.stringify(e)).join('\n')}\n`);
  await writeFile(new URL('expected.json', directory), `${JSON.stringify(result.expected, null, 2)}\n`);
  console.log(JSON.stringify({ fixture: result.manifest.fixtureId, events: result.events.length, finalStateHash: result.expected.finalStateHash }));
}
