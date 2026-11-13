import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAutomation } from './automation-harness.ts';
import { ConsoleRuntime, commandName } from '../src/app/console/runtime.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import type { AutomationPort } from '../src/app/console/automation.ts';
import type { LiveAcceptanceOptions } from '../src/app/live.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/domain/game/value.ts';

const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;
const options: LiveAcceptanceOptions = { outputDirectory: '/tmp/maji-loop-test-output', sourceVersion: 'test',
  databasePath: '/tmp/maji-loop-test.sqlite', room: { roomId: room.roomId, rules: room.rules, autoWin: 'unknown' } };
const page = { evaluate: async () => null };
const ready = { akagiEnabled: true, authSummary: {}, lastStep: 1, reason: null, matchEnded: false };

test('observation slices continue until an explicit stop without consuming error retries or counting extra matches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-slices-'));
  let now = 0, accepts = 0, preparations = 0;
  t.mock.method(Date, 'now', () => now);
  const sessions = new Set<string>();
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 2, maxDurationMs: 100 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      prepareRoom: async () => { preparations++; return options.room; },
      call: async (_page, method) => {
        assert.notEqual(method, 'startNextMatch');
        return { ...ready, audienceRoomsVersion: 6, connected: true, paused: true, controlEpoch: 0,
          ...(accepts ? { gameUuid: 'same-game' } : {}) };
      },
      accept: async (_page, current, _runtime, signal) => {
        accepts++;
        assert.equal(current.databasePath, options.databasePath);
        assert.equal(current.room.roomId, options.room.roomId);
        assert.equal(sessions.has(current.sessionId!), false); sessions.add(current.sessionId!);
        const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
        assert.equal(status.status, 'playing');
        assert.equal(status.completedMatches, 0);
        now = 1000;
        // Let the real control poll observe the expired run duration.
        await new Promise(resolve => setTimeout(resolve, 110));
        assert.equal(signal?.aborted, false);
        return accepts === 5 ? { status: 'passed', lifecycle: { matchStatus: 'finished' } } : {
          status: 'blocked', code: 'MATCH_OBSERVATION_LIMIT', recovery: { canResume: true,
            unresolvedAttempts: 0, gameMatchKey: `game-${digest('same-game').slice(0,32)}` },
        };
      },
    });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(accepts, 5);
    assert.equal(preparations, 1);
    assert.equal(status.completedMatches, 1);
    assert.equal(status.status, 'stopped');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('observation continuation requires a safe same-game ledger and released page, and honors stop', async t => {
  for (const mode of ['unsafe', 'pending-action', 'unreleased', 'changed-game', 'disconnected', 'cancel'] as const) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maji-loop-slices-'));
    let accepts = 0;
    try {
      await writeFile(join(directory, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, options, directory, { maxMatches: 2, maxDurationMs: 60_000 }, {
        install: async () => { throw Error('MUST_NOT_RELOAD'); },
        call: async (_page, method) => {
          assert.notEqual(method, 'startNextMatch');
          return { ...ready, connected: mode !== 'disconnected', paused: true,
            controlEpoch: mode === 'unreleased' && accepts ? 2 : 0,
            ...(accepts ? { gameUuid: mode === 'changed-game' ? 'other-game' : 'same-game' } : {}) };
        },
        accept: async (_page, _options, _runtime, signal) => {
          accepts++;
          if (mode === 'cancel') {
            await writeFile(join(directory, 'control.json'), '{"enabled":false}');
            await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
          }
          return { status: 'blocked', code: 'MATCH_OBSERVATION_LIMIT', recovery: { canResume: mode !== 'unsafe',
            unresolvedAttempts: mode === 'pending-action' ? 1 : 0, gameMatchKey: `game-${digest('same-game').slice(0,32)}` } };
        },
      });
      const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
      assert.equal(accepts, 1);
      assert.equal(status.completedMatches, 0);
      assert.equal(status.status, mode === 'cancel' ? 'stopped' : 'faulted');
      if (mode !== 'cancel') assert.equal(status.errorCode, 'MATCH_OBSERVATION_LIMIT');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('in-match recovery is bounded, preserves the ledger and requires a released page with no uncertain actions', async t => {
  const trace = ['authGame', 'syncGame', 'finishSyncGame'].flatMap((method, group) =>
    ['request', 'response', 'response-forwarded'].map((phase, index) => ({ owner: 'client', pageEpoch: 1,
      method, phase, observedMonoMs: group * 3 + index, ...(index ? { accepted: true, ...(method === 'syncGame' ? { hasRestore: true } : {}) } : {}) })));
  for (const mode of ['recover', 'persistent', 'unsafe', 'unreleased', 'changed-game', 'protocol-error', 'cancel'] as const) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maji-loop-recovery-'));
    let accepts = 0;
    const sessions = new Set<string>();
    try {
      await writeFile(join(directory, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 60_000 }, {
        install: async () => { throw Error('MUST_NOT_RELOAD'); },
        call: async (_page, method) => {
          if (method === 'sync') return { gameUuid: 'same-game', is_end: false, game_restore: { actions: [{ name: 'ActionNewRound' }] } };
          assert.notEqual(method, 'startNextMatch');
          return { ...ready, connected: true, paused: true, pageEpoch: 1, generation: 0, nativeRestoreRevision: 0,
            executorActive: false, nativeLifecycleTrace: trace,
            controlEpoch: mode === 'unreleased' && accepts ? 5 : 0,
            gameUuid: mode === 'changed-game' && accepts ? 'other-game' : 'same-game' };
        },
        accept: async (_page, current) => {
          accepts++;
          assert.equal(current.databasePath, options.databasePath);
          assert.equal(current.room.roomId, options.room.roomId);
          assert.equal(current.resumeMatch, true);
          assert.equal(sessions.has(current.sessionId!), false); sessions.add(current.sessionId!);
          if (mode === 'recover' && accepts > 1) return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
          if (mode === 'cancel') await writeFile(join(directory, 'control.json'), '{"enabled":false}');
          return { status: 'blocked', code: mode === 'protocol-error' ? 'COUNTDOWN_PROTOCOL_MISMATCH' : 'SYNC_HAND_START_REQUIRED',
            recovery: { canResume: mode !== 'unsafe', gameMatchKey: `game-${digest('same-game').slice(0,32)}`, unresolvedAttempts: mode === 'unsafe' ? 1 : 0 } };
        },
      });
      const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
      assert.equal(accepts, mode === 'recover' ? 2 : mode === 'persistent' ? 4 : 1);
      assert.equal(status.completedMatches, mode === 'recover' ? 1 : 0);
      assert.equal(status.status, mode === 'recover' || mode === 'cancel' ? 'stopped' : 'faulted');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('startup reloads an abandoned actor fence before attaching a new worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  let installs = 0, accepts = 0;
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 60_000 }, {
      install: async () => { installs++; return {} as any; },
      call: async () => ({ ...ready, controlEpoch: installs ? 0 : 5 }),
      accept: async () => {
        assert.equal(installs, 1); accepts++;
        return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
      },
    });
    assert.equal(accepts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a released terminal game can close its socket and return through confirmation without reloading its lobby', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-terminal-restart-'));
  let confirms = 0, starts = 0;
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 60_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD_LOBBY'); },
      call: async (_page, method) => {
        if (method === 'startNextMatch') { starts++; return { ready: true }; }
        return starts ? { ...ready, audienceRoomsVersion: 6 } : { ...ready, audienceRoomsVersion: 6,
          gameUuid: 'ended', matchEnded: true, connected: false, reason: 'DISCONNECTED', paused: true, controlEpoch: 0,
          matchResult: { result: { players: [{}, {}, {}, {}] } } };
      },
      confirmResult: async (_page, uuid) => { assert.equal(uuid, 'ended'); confirms++; },
      prepareRoom: async () => { assert.equal(confirms, 1); return options.room; },
      startRoom: async () => true,
      accept: async () => ({ status: 'passed', lifecycle: { matchStatus: 'finished' } }),
    });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.status, 'stopped');
    assert.equal(status.completedMatches, 1);
    assert.equal(confirms, 1);
    assert.equal(starts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup also replaces an overflowed or untrusted bridge left behind at match end', async t => {
  for (const reason of ['BRIDGE_QUEUE_OVERFLOW', 'BRIDGE_UNTRUSTED']) await t.test(reason, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
    let installs = 0;
    try {
      await writeFile(join(directory, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 60_000 }, {
        install: async () => { installs++; return {} as any; },
        call: async () => installs ? ready : { ...ready, matchEnded: true, reason, overflow: reason === 'BRIDGE_QUEUE_OVERFLOW' },
        accept: async () => ({ status: 'passed', lifecycle: { matchStatus: 'finished' } }),
      });
      assert.equal(installs, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('startup upgrades older audience bridges before preparing a room with computer cleanup',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-loop-test-'));let installs=0,preparations=0;
  try{
    await writeFile(join(directory,'control.json'),'{"enabled":true}');
    await runAutomation(page,process.execPath,options,directory,{maxMatches:1,maxDurationMs:60_000},{
      install:async()=>{installs++;return{} as any;},
      call:async()=>({...ready,audienceRoomsVersion:installs?6:5}),
      prepareRoom:async()=>{assert.equal(installs,1);preparations++;return options.room;},
      accept:async()=>({status:'passed',lifecycle:{matchStatus:'finished'}}),
    });
    assert.equal(preparations,1);assert.equal(installs,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('table calibration is restored after lobby preparation clears the viewport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  let calibrated = false, accepts = 0;
  const visualPage = { ...page, cdp: async (method: string) => {
    if (method === 'Emulation.setDeviceMetricsOverride') calibrated = true;
  } };
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(visualPage, process.execPath, options, directory, { maxMatches: 2, maxDurationMs: 60_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async () => ({ ...ready, audienceRoomsVersion: 6 }),
      prepareRoom: async () => { calibrated = false; return options.room; },
      accept: async () => {
        assert.equal(calibrated, true); accepts++;
        return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
      },
    });
    assert.equal(accepts, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the native lobby viewport is restored before collecting the room start proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-loop-test-'));
  let calibrated = false, started = false;
  const visualPage = { ...page, cdp: async (method: string) => {
    if (method === 'Emulation.setDeviceMetricsOverride') calibrated = true;
    if (method === 'Emulation.clearDeviceMetricsOverride') calibrated = false;
  } };
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(visualPage, process.execPath, options, directory, { maxMatches: 1, maxDurationMs: 60_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async (_page, method) => {
        if (method === 'startNextMatch') {
          assert.equal(calibrated, false, 'resizing after this proof would invalidate its generation');
          started = true; return { ready: true, expected: { pageEpoch: 1, generation: 2, gameUuid: null } };
        }
        return { ...ready, authSummary: started ? {} : null };
      },
      startRoom: async () => { assert.equal(calibrated, false); return true; },
      accept: async () => {
        assert.equal(started, true); assert.equal(calibrated, true);
        return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
      },
    });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(status.completedMatches, 1);
    assert.equal(status.status, 'stopped');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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

test('continuous games use distinct sessions and outputs, one ledger, and honor an explicit operator stop', async () => {
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

test('blocked reports cannot advance without a complete, same-match completion proof', async t => {
  const key = `game-${digest('same-game').slice(0,32)}`;
  for (const mode of ['no-proof', 'unfinished', 'pending-action', 'other-match'] as const) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maji-completion-'));
    let accepts = 0;
    try {
      await writeFile(join(directory, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, options, directory, { maxMatches: 2, maxDurationMs: 60_000 }, {
        install: async () => { throw Error('MUST_NOT_RELOAD'); },
        call: async (_page, method) => { assert.notEqual(method, 'startNextMatch'); return ready; },
        confirmResult: async () => { throw Error('MUST_NOT_CONFIRM'); },
        accept: async () => {
          accepts++;
          return { status: 'blocked', gameMatchKey: key, lifecycle: { matchStatus: mode === 'unfinished' ? 'playing' : 'finished' },
            ...(mode === 'no-proof' ? {} : { matchCompletion: { canStartNextMatch: true,
              gameMatchKey: mode === 'other-match' ? `game-${digest('other-game').slice(0,32)}` : key,
              unresolvedAttempts: mode === 'pending-action' ? 1 : 0 } }) };
        },
      });
      const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
      assert.equal(accepts, 1);
      assert.equal(status.status, 'faulted');
      assert.equal(status.completedMatches, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
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
