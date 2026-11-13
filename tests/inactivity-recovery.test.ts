import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAutomation } from '../src/app/console/automation-loop.ts';
import { monitorMatch, MatchMonitorInterrupted } from '../src/app/console/automation-monitor.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import { digest } from '../src/domain/game/value.ts';

const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;
const page = { evaluate: async () => null };
const ready = { akagiEnabled: true, audienceRoomsVersion: 6, authSummary: {}, connected: true,
  paused: true, executorActive: false, controlEpoch: 0, pageEpoch: 2, generation: 3, matchEnded: false };
const monitor: typeof monitorMatch = (work, read, signal, progress) => monitorMatch(work, read, signal, progress,
  { pollMs: 5, stalledMs: 5_000, readTimeoutMs: 1_000 });

test('inactivity interruption retains only a fully drained worker report', async () => {
  const report = { programPaused: true }; let drained = false;
  await assert.rejects(monitor(async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await delay(10); drained = true; return report;
  }, async () => { throw Error('INACTIVITY_NOTICE_DETECTED'); }, new AbortController().signal, async () => {}), error => {
    assert.equal(drained, true); assert.ok(error instanceof MatchMonitorInterrupted);
    assert.equal(error.message, 'INACTIVITY_NOTICE_DETECTED'); assert.equal(error.report, report); return true;
  });
});

test('detected notice drains, dismisses and synchronizes a new actor in the same game without recreating its room', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maji-inactivity-'));
  let accepts = 0, drained = false, dismissed = false, openings = 0;
  const sessions = new Set<string>();
  try {
    await writeFile(join(dir, 'control.json'), '{"enabled":true}');
    await runAutomation(page, process.execPath, { room, outputDirectory: dir, sourceVersion: 'test' }, dir, {
      monitor, install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async () => ({ ...ready, ...(accepts ? { gameUuid: 'game' } : {}) }),
      inspectInactivity: async () => ({ visible: !dismissed, width: 2036, height: 918 }),
      dismissInactivity: async () => { assert.equal(drained, true); dismissed = true; return true; },
      opening: async (_page, uuid) => { assert.equal(dismissed, true); assert.equal(uuid, 'game'); openings++; return true; },
      recoverRoom: async () => assert.fail('must keep the same game and room'),
      accept: async (_page, options, _runtime, signal) => {
        accepts++; sessions.add(options.sessionId!);
        assert.equal(options.room.roomId, room.roomId); assert.equal(options.resumeMatch, true);
        if (accepts === 1) {
          await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
          await delay(10); drained = true;
          return { status: 'blocked', programPaused: true, unmatchedOwnDiscards: 3,
            recovery: { canResume: false, unresolvedAttempts: 0, gameMatchKey: `game-${digest('game').slice(0,32)}` } };
        }
        assert.equal(dismissed, true); assert.equal(openings, 1);
        await writeFile(join(dir, 'control.json'), '{"enabled":false}');
        return { status: 'passed', lifecycle: { matchStatus: 'finished' } };
      },
    });
    assert.equal(accepts, 2); assert.equal(sessions.size, 2);
    const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
    assert.equal(status.status, 'stopped'); assert.equal(status.completedMatches, 1); assert.equal(status.recoveryCount, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown or unsafe drained state never dismisses a notice; user stop also prevents the click', async t => {
  for (const mode of ['pending-action', 'not-paused', 'unreleased', 'changed-game', 'no-report', 'stop'] as const) await t.test(mode, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maji-inactivity-block-'));
    let accepts = 0, drained = false;
    try {
      await writeFile(join(dir, 'control.json'), '{"enabled":true}');
      await runAutomation(page, process.execPath, { room, outputDirectory: dir, sourceVersion: 'test' }, dir, {
        monitor, install: async () => { throw Error('MUST_NOT_RELOAD'); },
        call: async () => ({ ...ready, ...(accepts ? { gameUuid: mode === 'changed-game' && drained ? 'other' : 'game',
          executorActive: mode === 'unreleased' && drained } : {}) }),
        inspectInactivity: async () => ({ visible: true, width: 2036, height: 918 }),
        dismissInactivity: async () => assert.fail('unsafe recovery must not click'),
        accept: async (_page, _options, _runtime, signal) => {
          accepts++;
          await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
          drained = true;
          if (mode === 'stop') await writeFile(join(dir, 'control.json'), '{"enabled":false}');
          if (mode === 'no-report') throw Error('LIVE_CHILD_FAILED');
          return { status: 'blocked', programPaused: mode !== 'not-paused', recovery: {
            canResume: true, unresolvedAttempts: mode === 'pending-action' ? 1 : 0,
            gameMatchKey: `game-${digest('game').slice(0,32)}` } };
        },
      });
      assert.equal(accepts, 1);
      const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
      assert.equal(status.status, mode === 'stop' ? 'stopped' : 'faulted');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test('a worker that fails its visual check before the monitor tick still dismisses the notice and resumes the same game',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'maji-inactivity-race-'));
 let accepts=0,dismissed=false,openings=0;
 try{
  await writeFile(join(dir,'control.json'),'{"enabled":true}');
  await runAutomation(page,process.execPath,{room,outputDirectory:dir,sourceVersion:'test'},dir,{
   install:async()=>assert.fail('must not reload'),
   call:async()=>({...ready,...(accepts?{gameUuid:'game'}:{})}),
   inspectInactivity:async()=>({visible:!dismissed,width:2036,height:918}),
   dismissInactivity:async()=>{assert.equal(accepts,1);dismissed=true;return true;},
   opening:async()=>{assert.equal(dismissed,true);openings++;return true;},
   recoverRoom:async()=>assert.fail('must not recreate the room'),
   accept:async()=>{
    if(++accepts===1)return{status:'blocked',code:'AUTO_WIN_UNVERIFIED',programPaused:true,
     recovery:{canResume:false,unresolvedAttempts:0,gameMatchKey:`game-${digest('game').slice(0,32)}`}};
    assert.equal(openings,1);
    await writeFile(join(dir,'control.json'),'{"enabled":false}');
    return{status:'passed',lifecycle:{matchStatus:'finished'}};
   },
  });
  assert.equal(accepts,2);
  const status=JSON.parse(await readFile(join(dir,'status.json'),'utf8'));
  assert.equal(status.status,'stopped');assert.equal(status.recoveryCount,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
