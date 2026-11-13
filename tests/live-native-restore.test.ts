import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveGameSession } from '../src/app/live-session.ts';
import { GameActor } from '../src/application/game/actor.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import { ScriptedPage } from './live-helpers.ts';

class NativeRestorePage extends ScriptedPage {
  pending = false;
  authQueued = false;
  raceNextSync = false;
  syncError: string | null = null;
  gameUuid = 'contract-only-game-uuid';
  reason: string | null = null;
  overflow = false;
  async evaluate(source:any, argument?:any):Promise<any> {
    if (argument?.method === 'sync' && (this.raceNextSync || this.syncError)) {
      this.calls.push('sync');
      if (this.raceNextSync) {
        this.raceNextSync = false; this.pending = true;
        throw Error('SYNC_NATIVE_RESTORE_PENDING');
      }
      throw Error(this.syncError!);
    }
    const result = await super.evaluate(source, argument);
    if (!['read','drain'].includes(argument?.method)) return result;
    const state = { ...result, connected:true, freshConnection:true, gameUuid:this.gameUuid,
      authSummary:result.authSummary ?? {}, nativeRestorePending:this.pending, reason:this.reason, overflow:this.overflow };
    if (argument.method === 'drain' && this.authQueued) {
      this.authQueued = false;
      state.records = [{ kind:'auth-summary', receivedAt:this.at }];
    }
    return state;
  }
}

async function scenario() {
  const directory = await mkdtemp(join(tmpdir(),'maji-native-restore-'));
  const storage = new StorageClient(join(directory,'state.sqlite'));
  const actor = await GameActor.open(storage,'native-restore-session','process');
  const page = new NativeRestorePage(join(directory,'state.sqlite'));
  const live = new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
  await live.synchronize(false);
  return { page, actor, live, cleanup:async() => {
    await actor.idle(); await storage.close(); await rm(directory,{recursive:true,force:true});
  } };
}

test('reauthentication waits through native replay before synchronizing the same actor',async() => {
  const h = await scenario();
  try {
    const epoch = h.actor.projection.connectionEpoch;
    h.page.authQueued = true; h.page.pending = true;
    for (let i = 0; i < 3; i++) await h.live.pump();
    assert.equal(h.page.calls.filter(method => method === 'sync').length,1);
    assert.equal(h.live.recovering,true);
    assert.equal(h.actor.control.paused,true);
    assert.equal(h.actor.control.needsSync,true);
    assert.equal(h.live.counts.reconnects,0);
    h.page.pending = false;
    await h.live.pump();
    assert.equal(h.page.calls.filter(method => method === 'sync').length,2);
    assert.equal(h.live.recovering,false);
    assert.equal(h.live.counts.reconnects,1);
    assert.ok(h.actor.projection.connectionEpoch > epoch);
    assert.equal(h.page.sends,0);
  } finally { await h.cleanup(); }
});

test('native restore beginning after drain defers its pre-send refusal until a later pump',async() => {
  const h = await scenario();
  try {
    h.page.authQueued = true; h.page.raceNextSync = true;
    await h.live.pump();
    assert.equal(h.live.recovering,true);
    assert.equal(h.live.counts.reconnects,0);
    await h.live.pump();
    assert.equal(h.page.calls.filter(method => method === 'sync').length,2);
    h.page.pending = false;
    await h.live.pump();
    assert.equal(h.live.counts.reconnects,1);
    assert.equal(h.live.recovering,false);
    assert.equal(h.actor.control.paused,true);
    assert.equal(h.page.sends,0);
  } finally { await h.cleanup(); }
});

test('native restore deferral has one bounded deadline across repeated authentication notices',async t => {
  const h = await scenario();
  let now = performance.now();
  t.mock.method(performance,'now',() => now);
  try {
    h.page.pending = true; h.page.authQueued = true;
    await h.live.pump();
    now += 29_999;
    h.page.authQueued = true;
    await h.live.pump();
    now += 1;
    await assert.rejects(h.live.pump(),/SYNC_NATIVE_RESTORE_TIMEOUT/);
    assert.equal(h.page.calls.filter(method => method === 'sync').length,1);
    assert.equal(h.actor.control.paused,true);
  } finally { await h.cleanup(); }
});

test('deferred native restore still rejects changed games, page faults and unrelated sync failures',async t => {
  for (const kind of ['changed-game','page-fault','overflow','receipt-failure'] as const) await t.test(kind,async() => {
    const h = await scenario();
    try {
      h.page.authQueued = true; h.page.pending = true;
      await h.live.pump();
      if (kind === 'changed-game') h.page.gameUuid = 'replacement-game';
      if (kind === 'page-fault') h.page.reason = 'FRAME_DECODE_FAILED';
      if (kind === 'overflow') h.page.overflow = true;
      if (kind === 'receipt-failure') { h.page.pending = false; h.page.syncError = 'RPC_RECEIPT_TIMEOUT'; }
      const code = { 'changed-game':'OBSERVED_MATCH_CHANGED', 'page-fault':'BRIDGE_UNTRUSTED',
        overflow:'BRIDGE_QUEUE_OVERFLOW', 'receipt-failure':'RPC_RECEIPT_TIMEOUT' }[kind];
      await assert.rejects(h.live.pump(),new RegExp(code));
      assert.equal(h.live.counts.reconnects,0);
      assert.equal(h.page.sends,0);
    } finally { await h.cleanup(); }
  });
});
