import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDatabase, loadReplay, replay } from '../src/app/replay.ts';
import { FIXTURE_SESSION } from '../scripts/build-phase1-fixtures.ts';
import { digest } from '../src/domain/game/value.ts';
import { actorHarness, redCandidate } from './helpers.ts';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/phase1-discard/', import.meta.url));

test('replay rejects schema drift, mislabeled evidence, and mismatched event hashes before execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-replay-validation-'));
  try {
    await cp(fixtureDirectory, directory, { recursive: true });
    const original = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    for (const changed of [{ schemaVersion: 2 }, { reducerVersion: 'unverified' }, { evidenceKind: 'real-capture' }, { eventsSha256: '0'.repeat(64) }]) {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...original, ...changed }));
      await assert.rejects(loadReplay(directory), /INVALID_ENUM|REPLAY_HASH_MISMATCH/);
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(original));
    assert.equal((await loadReplay(directory)).events.length, 17);
    const text = await readFile(join(directory, 'events.jsonl'), 'utf8'), lines = text.trimEnd().split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), cookie: 'never-import-credentials' });
    await writeFile(join(directory, 'events.jsonl'), `${lines.join('\n')}\n`);
    await assert.rejects(loadReplay(directory), /INVALID_FIELDS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI dry-run, replay report, and read-only inspection agree; existing output is never overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-replay-cli-'));
  try {
    const plain = await replay(fixtureDirectory, { outputDirectory: join(directory, 'plain') });
    assert.equal(plain.status, 'passed'); assert.equal(plain.ownDiscardFacts, 2); assert.equal(plain.preview, null);
    const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.ts', 'dry-run', fixtureDirectory, '--candidate', '13', '--out', join(directory, 'dry')],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), maxBuffer: 1024 * 1024 });
    const dry = JSON.parse(stdout) as { preview: { status: string; sends: number; authoritativeConfirmations: number; executionMode: string }; databasePath: string; reportPath: string; finalStateHash: string; automationEnabled: boolean };
    assert.equal(dry.finalStateHash, plain.finalStateHash); assert.equal(dry.automationEnabled, false);
    assert.equal(dry.preview.status, 'simulated'); assert.equal(dry.preview.executionMode, 'dry-run');
    assert.equal(dry.preview.sends, 0); assert.equal(dry.preview.authoritativeConfirmations, 0);
    const inspection = await inspectDatabase(dry.databasePath, FIXTURE_SESSION);
    assert.equal(inspection.counts.events, 17); assert.equal(inspection.counts.outbox, 2); assert.equal(inspection.counts.confirmations, 0);
    assert.equal(inspection.attempts.length, 1); assert.equal(inspection.attempts[0]?.status, 'simulated');
    assert.equal(digest(inspection.projection.state), dry.finalStateHash); assert.equal(inspection.requiresAuthoritativeSyncBeforeExecution, true);
    const savedReport = await readFile(dry.reportPath, 'utf8');
    await assert.rejects(replay(fixtureDirectory, { outputDirectory: join(directory, 'dry') }), { code: 'EEXIST' });
    assert.equal(await readFile(dry.reportPath, 'utf8'), savedReport);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inspect keeps the active writer and its recovery/attempt state unchanged', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), candidate = redCandidate(snapshot);
    const { attempt } = await h.store.reserveAction({ attemptId: 'inspection-prepared', decisionId: snapshot.id, actionId: candidate.id,
      processInstanceId: h.actor.processInstanceId, executionMode: 'contract-test', preparedAt: snapshot.createdAt });
    const before = await h.store.inspect(FIXTURE_SESSION), inspected = await inspectDatabase(h.path, FIXTURE_SESSION);
    assert.deepEqual(inspected.attempts, before.attempts); assert.equal(inspected.recoveryRequired, before.recoveryRequired);
    assert.equal((await h.store.markDispatching(attempt.id)).transitioned, true);
    await h.store.recordFault(FIXTURE_SESSION, 'TEST_INSPECTION_BARRIER', snapshot.createdAt);
    assert.equal((await inspectDatabase(h.path, FIXTURE_SESSION)).recoveryRequired, true);
    // A second read neither clears the persisted recovery flag nor takes over the writer.
    await h.store.setPendingMode(FIXTURE_SESSION, 'llm');
    const after = await inspectDatabase(h.path, FIXTURE_SESSION);
    assert.equal(after.recoveryRequired, true); assert.equal(after.attempts[0]?.status, 'dispatching');
    assert.equal(after.projection.pendingMode, 'llm'); assert.equal(after.counts.events, before.counts.events);
  } finally { await h.cleanup(); }
});
