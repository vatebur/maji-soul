import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAutomation } from '../src/app/console/automation-ego.ts';
import { ConsoleRuntime, commandName } from '../src/app/console/runtime.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import type { AutomationPort } from '../src/app/console/automation.ts';
import type { LiveAcceptanceOptions } from '../src/app/live.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import { randomUUID } from 'node:crypto';

const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;
const options: LiveAcceptanceOptions = { outputDirectory: '/tmp/maji-loop-test-output', sourceVersion: 'test',
  databasePath: '/tmp/maji-loop-test.sqlite', room: { roomId: room.roomId, rules: room.rules, autoWin: 'unknown' } };
const page = { evaluate: async () => null };
const ready = { akagiEnabled: true, authSummary: {}, lastStep: 1, reason: null, matchEnded: false };

test('startup preserves lobby and room readiness failures instead of reporting a game timeout', async t => {
  for (const code of ['LOBBY_NOT_READY', 'ROOM_NOT_READY', 'ROOM_FETCH_FAILED']) {
    const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
    let now = 0, starts = 0;
    const clock = t.mock.method(Date, 'now', () => now);
    try {
      await writeFile(join(directory, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 120_000 }, {
        install: async () => { throw Error('MUST_NOT_RELOAD'); },
        call: async (_page, method) => {
          if (method === 'startNextMatch') { starts++; now += 61_000; throw Error(code); }
          return { ...ready, authSummary: null };
        },
        accept: async () => { throw Error('MUST_NOT_PLAY'); },
      });
      const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
      assert.equal(status.status, 'faulted');
      assert.equal(status.errorCode, code);
      assert.equal(status.completedMatches, 0);
      assert.equal(starts, 1);
    } finally { clock.mock.restore(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('a submitted start that never authenticates remains a game start timeout and is not repeated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  let now = 0, starts = 0;
  t.mock.method(Date, 'now', () => now);
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 120_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async (_page, method) => {
        if (method === 'startNextMatch') { starts++; return { started: true }; }
        if (starts && method === 'read') now += 61_000;
        return { ...ready, authSummary: null };
      },
      accept: async () => { throw Error('MUST_NOT_PLAY'); },
    });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.status, 'faulted');
    assert.equal(status.errorCode, 'GAME_START_TIMEOUT');
    assert.equal(starts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('continuous games use distinct sessions and outputs, one ledger, and honor the match limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  let installs = 0, starts = 0, confirmations = 0, afterReload = false;
  const matches: LiveAcceptanceOptions[] = [];
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 3, maxDurationMs: 60_000 }, {
      install: async () => { installs++; afterReload = true; return {} as any; },
      confirmResult: async () => { confirmations++; },
      call: async (_page, method) => {
        if (method === 'startNextMatch') { starts++; afterReload = false; return { started: true }; }
        return afterReload ? { ...ready, matchEnded: true, gameUuid: `finished-${matches.length}` } : ready;
      },
      accept: async (_page, current) => { matches.push(current); afterReload = true; return { status: 'passed', lifecycle: { matchStatus: 'finished' } }; },
    });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.completedMatches, 3);
    assert.equal(status.status, 'stopped');
    assert.equal(status.enabled, false);
    assert.equal(installs, 0);
    assert.equal(starts, 2);
    assert.equal(confirmations, 2);
    assert.equal(new Set(matches.map(m => m.sessionId)).size, 3);
    assert.equal(new Set(matches.map(m => m.outputDirectory)).size, 3);
    assert.ok(matches.every(m => m.databasePath === options.databasePath && m.akagi && m.resumeMatch));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncertain match results stop the loop without reloading or starting another game', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    let pauses = 0;
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 3, maxDurationMs: 60_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async (_page, method) => { if (method === 'pause') pauses++; return ready; },
      accept: async () => ({ status: 'blocked', code: 'AKAGI_ACTION_UNCONFIRMED' }),
    });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.status, 'faulted');
    assert.equal(status.errorCode, 'AKAGI_ACTION_UNCONFIRMED');
    assert.equal(status.completedMatches, 0);
    assert.equal(pauses, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stop reaches an active worker and prevents the next match', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    let stopped = false;
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 3, maxDurationMs: 60_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async () => ready,
      accept: async (_page, _options, _runtime, signal) => {
        await writeFile(join(directory, 'control.json'), '{"enabled":false}');
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
        return { status: 'blocked' };
      },
    });
    assert.equal(stopped, true);
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.status, 'stopped');
    assert.equal(status.completedMatches, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('console command is idempotent and follows the automation worker session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-control-test-'));
  const store = new StorageClient(join(directory, 'state.sqlite'));
  let starts = 0, stops = 0;
  const automation: AutomationPort = {
    view: { available: true, enabled: false, status: 'idle', completedMatches: 0, sessionId: null },
    async start() { starts++; Object.assign(this.view, { enabled: true, status: 'playing', sessionId: 'live-new-match' }); },
    async stop() { stops++; Object.assign(this.view, { enabled: false, status: 'stopped' }); },
    async refresh() {}, async close() {},
  };
  const runtime = await ConsoleRuntime.open({ store, source: { kind: 'follow', sessionId: 'idle' }, voices: [], voiceId: 'test', automation });
  try {
    assert.equal(commandName('/api/automation/set', 'POST'), 'automation.set');
    const body = { commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: null, enabled: true };
    await runtime.command('automation.set', body);
    await runtime.command('automation.set', body);
    assert.equal(starts, 1);
    assert.equal(runtime.gameSessionId, 'live-new-match');
    assert.equal(runtime.projections.console.automation.enabled, true);
    await runtime.command('automation.set', { ...body, commandId: randomUUID(), enabled: false });
    assert.equal(stops, 1);
    await assert.rejects(runtime.command('automation.set', { ...body, commandId: randomUUID(), enabled: 'true' }), /VALIDATION_FAILED/);
  } finally { await runtime.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
