import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runAutomation } from '../src/app/console/automation-loop.ts';
import { monitorMatch, recoveryDelayMs } from '../src/app/console/automation-monitor.ts';
import { recoverAudienceRoom } from '../src/app/console/room-recovery.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import type { LiveAcceptanceOptions } from '../src/app/live.ts';

const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;
const options: LiveAcceptanceOptions = { room, outputDirectory: '/tmp/maji-recovery-test', sourceVersion: 'test' };
const page = { evaluate: async () => null };
const ready = { akagiEnabled: true, audienceRoomsVersion: 6, authSummary: {}, paused: true, matchEnded: false, controlEpoch: 0 };

test('failed automatic play drains before replacing the room, announces incident and resumes a distinct session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-recovery-'));
  let accepts = 0, drained = false, recovered = false;
  const sessions: string[] = [], backoffs: number[] = [];
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, {
      install: async () => { throw Error('UNEXPECTED_INSTALL'); }, call: async () => ready,
      prepareRoom: async () => ({ ...room, roomId: recovered ? '56789' : room.roomId }),
      recoverRoom: async () => {
        assert.equal(drained, true);
        const state = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
        assert.equal(state.status, 'recovering'); assert.equal(state.lastErrorCode, 'AKAGI_ACTION_UNCONFIRMED');
        assert.equal(state.recoveryCount, 1); assert.ok(state.lastErrorAt); assert.ok(state.heartbeatAt);
        recovered = true;
      },
      sleep: async ms => { backoffs.push(ms); },
      accept: async (_page, current) => {
        sessions.push(current.sessionId!); accepts++;
        if (accepts === 1) { drained = true; return { status: 'blocked', code: 'AKAGI_ACTION_UNCONFIRMED' }; }
        assert.equal(recovered, true); assert.equal(current.room.roomId, '56789');
        await writeFile(join(directory, 'control.json'), '{"enabled":false}');
        return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
      },
    });
    const state = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(state.status, 'stopped'); assert.equal(state.completedMatches, 1);
    assert.equal(state.lastErrorCode, 'AKAGI_ACTION_UNCONFIRMED'); assert.equal(state.errorCode, undefined);
    assert.equal(new Set(sessions).size, 2); assert.deepEqual(backoffs, [1_000]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persistent recovery errors back off without a run limit and operator stop cancels the next room change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-recovery-'));
  let recovery = 0;
  const waits: number[] = [];
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, {
      install: async () => { throw Error('UNEXPECTED_INSTALL'); }, call: async () => ready,
      accept: async () => { throw Error('LIVE_CHILD_TIMEOUT'); },
      recoverRoom: async () => { recovery++; throw Error('LOBBY_NOT_READY'); },
      sleep: async ms => {
        waits.push(ms);
        if (waits.length === 5) await writeFile(join(directory, 'control.json'), '{"enabled":false}');
      },
    });
    assert.equal(recovery, 4); assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.equal(recoveryDelayMs(100), 60_000);
    const state = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(state.status, 'stopped'); assert.equal(state.recoveryCount, 5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('supervisor restart retains incident and match counters and replaces the old room before play', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-recovery-'));
  let recovered = false;
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await writeFile(join(directory, 'recovery.json'), JSON.stringify({ completedMatches: 8, recoveryCount: 3, lastErrorCode: 'AUTOMATION_HEARTBEAT_TIMEOUT' }));
    await runAutomation(page, process.execPath, options, directory, {
      install: async () => { throw Error('UNEXPECTED_INSTALL'); }, call: async () => ready,
      recoverRoom: async () => { recovered = true; },
      accept: async () => {
        assert.equal(recovered, true); await writeFile(join(directory, 'control.json'), '{"enabled":false}');
        return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
      },
    });
    const state = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(state.completedMatches, 9); assert.equal(state.recoveryCount, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('game watchdog aborts stalled work and waits for its executor to drain', async () => {
  let drained = false, reads = 0;
  await assert.rejects(monitorMatch(async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await delay(10); drained = true;
  }, async () => { reads++; return { connected: true, gameUuid: 'game', lastStep: 1 }; }, new AbortController().signal, async () => {},
  { pollMs: 5, stalledMs: 15, readTimeoutMs: 20 }), /GAME_PROGRESS_STALLED/);
  assert.equal(drained, true); assert.ok(reads >= 2);
});

test('game watchdog bounds a hung browser read and respects operator cancellation', async () => {
  const work = async (signal: AbortSignal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return 'drained'; };
  await assert.rejects(monitorMatch(work, async () => new Promise(() => {}), new AbortController().signal, async () => {},
    { pollMs: 5, stalledMs: 15, readTimeoutMs: 10 }), /GAME_HEALTH_READ_TIMEOUT/);
  const cancellation = new AbortController();
  const running = monitorMatch(work, async () => ({}), cancellation.signal, async () => {}, { pollMs: 100, stalledMs: 100, readTimeoutMs: 10 });
  cancellation.abort(); assert.equal(await running, 'drained');
});

test('room recovery refreshes after a drained executor and does not rejoin until termination is confirmed', async () => {
  const calls: string[] = []; let terminated = false;
  await recoverAudienceRoom(page, room, new AbortController().signal, {
    install: async () => { calls.push('reload'); return {} as any; },
    sleep: async () => {},
    call: async (_page, method) => {
      calls.push(method);
      if (method === 'inspectRoom') return { roomId: '12345' };
      if (method === 'abandonOwnedRoom' && !terminated) { terminated = true; throw Error('ROOM_RECOVERY_NOT_FINISHED'); }
      return {};
    },
  });
  assert.deepEqual(calls, ['pause', 'reload', 'inspectRoom', 'abandonOwnedRoom', 'inspectRoom', 'abandonOwnedRoom', 'reload']);
});

test('login, ownership and version faults wait for the operator instead of recreating rooms', async t => {
  for (const code of ['LOGIN_REQUIRED', 'ROOM_OWNER_REQUIRED', 'DEFAULT_ROOM_RULES_MISMATCH', 'ROOM_RECOVERY_EXECUTOR_ACTIVE', 'CLIENT_VERSION_MISMATCH', 'PROTOCOL_HASH_MISMATCH', 'BROWSER_CONTROL_WITH_USER']) await t.test(code, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maji-intervention-'));
    try {
      await writeFile(join(directory, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, options, directory, {
        install: async () => { throw Error('UNEXPECTED_INSTALL'); }, call: async () => ready,
        prepareRoom: async () => { throw Error(code); },
        recoverRoom: async () => { assert.fail('must not replace a room or reclaim browser control'); },
        accept: async () => { assert.fail('must not launch an executor'); },
      });
      const state = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
      assert.equal(state.status, 'faulted'); assert.equal(state.enabled, false); assert.equal(state.lastErrorCode, code);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('a dead browser connection exits the worker so its supervisor can reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-browser-reconnect-'));
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, options, directory, {
      install: async () => { throw Error('UNEXPECTED_INSTALL'); }, call: async () => ready,
      accept: async () => { throw Error('BROWSER_DISCONNECTED'); },
      recoverRoom: async () => { assert.fail('a disconnected Page must be replaced by the parent worker'); },
    });
    const state = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    assert.equal(state.status, 'faulted'); assert.equal(state.errorCode, 'BROWSER_DISCONNECTED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a login lost during recovery is left open after one necessary fence reset', async () => {
  let now = 0, reloads = 0;
  await assert.rejects(recoverAudienceRoom(page, room, new AbortController().signal, {
    now: () => now,
    install: async () => { reloads++; return {} as any; },
    sleep: async ms => { now += ms; },
    call: async (_page, method) => {
      if (method === 'inspectRoom') throw Error('LOBBY_NOT_READY');
      if (method === 'read') return { lobbyAuthenticated: false, authSummary: null };
      return {};
    },
  }), /LOGIN_REQUIRED/);
  assert.equal(reloads, 1); assert.equal(now, 60_000);
});

test('recovery dismisses only a proven ended-game notice before recognizing the lobby', async () => {
  let dismissed = false, inspections = 0, reloads = 0;
  const controller = new AbortController();
  await recoverAudienceRoom(page, room, controller.signal, {
    install: async () => { reloads++; return {} as any; }, sleep: async () => {},
    screen: async () => ({ screen: dismissed ? 'home' : 'unknown', width: 1919, height: 992 }),
    dismissNotice: async (_page, signal) => { assert.equal(signal, controller.signal); inspections++; dismissed = true; return true; },
    call: async (_page, method) => {
      if (method === 'inspectRoom') throw Error('ROOM_NOT_READY');
      if (method === 'read') return { paused: true, executorActive: false, controlEpoch: 0, pageEpoch: 2, generation: 3, gameUuid: null };
      assert.equal(method, 'pause'); return {};
    },
  });
  assert.equal(inspections, 1); assert.equal(reloads, 1);
});

test('a notice sample deferred before pressing stays inside the original recovery loop', async () => {
  let now = 0, inspections = 0, reloads = 0, dismissed = false;
  await recoverAudienceRoom(page, room, new AbortController().signal, {
    now: () => now, install: async () => { reloads++; return {} as any; }, sleep: async ms => { now += ms; },
    screen: async () => ({ screen: dismissed ? 'home' : 'unknown', width: 1919, height: 992 }),
    dismissNotice: async () => { dismissed = ++inspections === 2; return dismissed; },
    call: async (_page, method) => {
      if (method === 'inspectRoom') throw Error('ROOM_NOT_READY');
      if (method === 'read') return { paused: true, executorActive: false, controlEpoch: 0,
        pageEpoch: 2, generation: inspections + 3, gameUuid: null };
      assert.equal(method, 'pause'); return {};
    },
  });
  assert.equal(inspections, 2); assert.equal(reloads, 1); assert.equal(now, 1000);
});

test('unknown recovery popups stay untouched and repeated notice handling remains bounded', async () => {
  for (const result of [false, true]) {
    let now = 0, inspections = 0;
    await assert.rejects(recoverAudienceRoom(page, room, new AbortController().signal, {
      now: () => now, install: async () => ({} as any), sleep: async ms => { now += ms; },
      screen: async () => ({ screen: 'unknown', width: 1919, height: 992 }),
      dismissNotice: async () => { inspections++; return result; },
      call: async (_page, method) => {
        if (method === 'inspectRoom') throw Error('ROOM_NOT_READY');
        if (method === 'read') return { lobbyAuthenticated: true, paused: true, executorActive: false, controlEpoch: 0, pageEpoch: 2, generation: 3, gameUuid: null };
        assert.equal(method, 'pause'); return {};
      },
    }), /ROOM_NOT_READY/);
    assert.equal(now, 60_000); assert.equal(result ? inspections === 1 : inspections > 1, true);
  }
});

test('cancellation during the recovery lobby read prevents notice input', async () => {
  const controller = new AbortController();
  await assert.rejects(recoverAudienceRoom(page, room, controller.signal, {
    install: async () => ({} as any), sleep: async () => {},
    screen: async () => { controller.abort(); return { screen: 'unknown', width: 1919, height: 992 }; },
    dismissNotice: async () => assert.fail('cancelled recovery must not touch the modal'),
    call: async (_page, method) => { if (method === 'inspectRoom') throw Error('ROOM_NOT_READY'); return {}; },
  }), { name: 'AbortError' });
});
