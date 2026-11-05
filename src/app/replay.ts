import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageClient } from '../adapters/storage/client.ts';
import { GameActor } from '../application/game/actor.ts';
import { ActionExecutor } from '../application/game/executor.ts';
import { ReplayClock } from '../application/game/clock.ts';
import { REDUCER_VERSION } from '../domain/game/reducer.ts';
import { canonical, digest, requireThat } from '../domain/game/value.ts';
import { array, integer, object, oneOf, parseObservation, string, tile, timestamp } from '../schemas/game.ts';

async function boundedRead(path: string, limit: number): Promise<string> {
  const file = await stat(path); requireThat(file.isFile() && file.size <= limit, 'REPLAY_FILE_TOO_LARGE');
  const text = await readFile(path, 'utf8'); requireThat(Buffer.byteLength(text) <= limit, 'REPLAY_FILE_TOO_LARGE'); return text;
}
export async function loadReplay(directory: string) {
  const path = resolve(directory);
  const [manifestText, eventsText, expectedText] = await Promise.all([
    boundedRead(join(path, 'manifest.json'), 64 * 1024), boundedRead(join(path, 'events.jsonl'), 8 * 1024 * 1024), boundedRead(join(path, 'expected.json'), 64 * 1024),
  ]);
  const manifest = object(JSON.parse(manifestText), ['schemaVersion', 'reducerVersion', 'fixtureId', 'evidenceKind', 'sourceVersion', 'sessionId', 'virtualNow', 'description', 'redaction', 'eventCount', 'eventsSha256'], ['originHandOrdinal']);
  if (manifest.originHandOrdinal !== undefined) integer(manifest.originHandOrdinal,1,1000);
  oneOf(manifest.schemaVersion, [1]); oneOf(manifest.reducerVersion, [REDUCER_VERSION]);
  // Live assets use this same strict visible-domain-event contract. Diagnostic summaries
  // cannot satisfy it: every event must parse and reproduce the complete expected state.
  oneOf(manifest.evidenceKind, ['synthetic', 'live-capture']); string(manifest.fixtureId); string(manifest.sessionId); string(manifest.sourceVersion);
  string(manifest.description, 1024); string(manifest.redaction, 1024); timestamp(manifest.virtualNow); integer(manifest.eventCount, 1, 10_000); string(manifest.eventsSha256, 64);
  const lines = eventsText.trimEnd().split('\n'); requireThat(lines.length <= 10_000 && lines.every(line => Buffer.byteLength(line) <= 256 * 1024), 'REPLAY_EVENT_LIMIT');
  const events = lines.map(line => parseObservation(JSON.parse(line)));
  requireThat(events.length === manifest.eventCount && digest(events) === manifest.eventsSha256, 'REPLAY_HASH_MISMATCH');
  const expected = object(JSON.parse(expectedText), ['eventCount', 'finalStateHash', 'ownDiscardFacts', 'finalSequence', 'finalHandOrdinal', 'finalOwnTiles']);
  integer(expected.eventCount, 1, 10_000); integer(expected.ownDiscardFacts, 0, 10_000); integer(expected.finalSequence, 1, 10_000); integer(expected.finalHandOrdinal, 1, 1000);
  string(expected.finalStateHash, 64); array(expected.finalOwnTiles, tile, 14);
  return { path, manifest, events, expected };
}
export async function replay(directory: string, options: { outputDirectory?: string; dryRunCandidate?: number } = {}) {
  const fixture = await loadReplay(directory);
  const runDirectory = resolve(options.outputDirectory ?? join('data', 'replay-runs', randomUUID()));
  // A fresh directory prevents a replay from opening or taking over a real session database.
  const parent = resolve(runDirectory, '..'); await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(runDirectory, { mode: 0o700 });
  const databasePath = join(runDirectory, 'state.sqlite'), storage = new StorageClient(databasePath);
  try {
    const clock = new ReplayClock(fixture.manifest.virtualNow as string), sessionId = fixture.manifest.sessionId as string;
    const actor = await GameActor.open(storage, sessionId, randomUUID(), { clock });
    for (const observation of fixture.events) {
      // Facts keep their original receipt time and causal order. A buffered
      // match result can precede its settlement in wall time, not in the ledger.
      clock.advanceTo(new Date(Math.max(clock.wallTimeMs(),Date.parse(observation.receivedAt))).toISOString());
      await actor.ingest(observation);
    }
    const inspection = await storage.inspect(sessionId), state = actor.projection.state;
    const actual = { eventCount: fixture.events.length, finalStateHash: digest(state), ownDiscardFacts: inspection.counts.outbox,
      finalSequence: actor.projection.sequence, finalHandOrdinal: actor.projection.handOrdinal, finalOwnTiles: state?.ownConcealed.map(t => t.code) ?? [] };
    requireThat(canonical(actual) === canonical(fixture.expected), 'REPLAY_EXPECTATION_MISMATCH');
    let preview: object | null = null;
    if (options.dryRunCandidate !== undefined) {
      integer(options.dryRunCandidate, 0, 63); await actor.resume();
      const decision = await actor.freezeDecision(), selected = decision.legalActions[options.dryRunCandidate];
      requireThat(selected, 'CANDIDATE_INDEX_OUT_OF_RANGE');
      // This assembly has no transport, browser, model provider, audio, or live-output capability.
      const executor = new ActionExecutor(actor), attempt = await executor.dryRun(decision.id, selected.id);
      preview = { candidateIndex: options.dryRunCandidate, action: selected, status: attempt.status, executionMode: attempt.executionMode,
        decisionId: decision.id, attemptId: attempt.id, sends: 0, authoritativeConfirmations: 0 };
    }
    const report = { schemaVersion: 1, reducerVersion: REDUCER_VERSION, evidenceKind: fixture.manifest.evidenceKind,
      fixtureId: fixture.manifest.fixtureId, sessionId, status: 'passed', ...actual, preview,
      automationEnabled: false, databasePath, reportPath: join(runDirectory, 'report.json') };
    await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); return report;
  } finally { await storage.close(); }
}
export async function inspectDatabase(databasePath: string, sessionId: string) {
  string(sessionId); const storage = new StorageClient(resolve(databasePath), { readOnly: true });
  try {
    const inspection = await storage.inspect(sessionId);
    return { ...inspection, runtimeStatus: 'offline-inspection', requiresAuthoritativeSyncBeforeExecution: true, automationEnabled: false };
  } finally { await storage.close(); }
}
