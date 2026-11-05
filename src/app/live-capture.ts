import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AuthoritativeSync, GameObservation } from '../domain/game/types.ts';
import { initialProjection, REDUCER_VERSION, reduceObservation } from '../domain/game/reducer.ts';
import { digest, requireThat } from '../domain/game/value.ts';
import { parseObservation } from '../schemas/game.ts';

/** Export only validated public facts and own visible tiles; never raw protocol objects. */
export async function exportLiveCapture(directory: string, sessionId: string, sync: AuthoritativeSync, subsequent: GameObservation[], sourceVersion: string) {
  requireThat(sync.historyCoverage === 'complete-hand' && sync.handHistory[0]?.type === 'HandStarted', 'CAPTURE_HISTORY_REQUIRED');
  requireThat(sync.handOrdinal === 1, 'CAPTURE_FIRST_HAND_REQUIRED');
  const opening = sync.handHistory[0].payload.initialView;
  const seed = (type: string, payload: unknown): GameObservation => parseObservation({ schemaVersion: 1,
    observationId: `capture-${type}`, connectionEpoch: sync.connectionEpoch, source: 'majsoul-sync',
    sourceDedupKey: `capture-${type}`, receivedAt: sync.receivedAt, type, payload });
  const recorded = [...sync.handHistory, ...subsequent];
  requireThat(recorded.every(e => e.type !== 'MeldDeclared' || e.payload.consumed.length === 0), 'CAPTURE_OWN_MELD_MAPPING_REQUIRED');
  // Replay has a fresh connection generation. Offers/permits are ephemeral and
  // must not be resurrected from an archive; preserve the authoritative facts.
  const factsOnly = recorded.filter(e => e.type !== 'OperationOffered' && e.type !== 'OperationClosed');
  const events = [seed('RoomVerified', { room: sync.room, verifiedAt: sync.receivedAt, evidenceIds: [sync.syncId] }),
    seed('MatchStarted', { roomId: sync.room.roomId, ownSeat: opening.ownSeat,
      initialScores: Object.fromEntries(Object.entries(opening.players).map(([s, p]) => [s, p.score])), gameMatchKey: sync.gameMatchKey }),
    ...factsOnly].map(e => parseObservation({ ...structuredClone(e), connectionEpoch: 0 }));
  let projection = initialProjection(sessionId);
  for (const event of events) projection = reduceObservation(projection, event);
  const state = projection.state; requireThat(state, 'CAPTURE_STATE_REQUIRED');
  const facts = events.filter(e => e.type === 'TileDiscarded' && e.payload.actor === state.ownSeat);
  const expected = { eventCount: events.length, finalStateHash: digest(state), ownDiscardFacts: facts.length,
    finalSequence: projection.sequence, finalHandOrdinal: projection.handOrdinal, finalOwnTiles: state.ownConcealed.map(t => t.code) };
  const manifest = { schemaVersion: 1, reducerVersion: REDUCER_VERSION, fixtureId: `live-${digest(events).slice(0, 16)}`,
    evidenceKind: 'live-capture', sourceVersion, sessionId, virtualNow: events[0]!.receivedAt,
    description: 'Current-client robot friend-room capture through production sync and event adapters; ordinary discard scope.',
    redaction: 'Strict domain event whitelist: own visible hand and public facts only; no account, authentication, raw frames or hidden opponent tiles.',
    eventCount: events.length, eventsSha256: digest(events) };
  const path = resolve(directory); await mkdir(path, { mode: 0o700 });
  await Promise.all([writeFile(join(path, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }),
    writeFile(join(path, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 }),
    writeFile(join(path, 'expected.json'), JSON.stringify(expected, null, 2) + '\n', { mode: 0o600 })]);
  return { directory: path, manifest, expected };
}
