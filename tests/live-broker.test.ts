import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { acceptLiveViaNode } from '../src/app/live-broker.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { createLiveScenario } from './live-helpers.ts';

test('the stdio broker hosts a real Node child and SQLite worker for sync-only acceptance', async () => {
  const h = await createLiveScenario();
  try {
    const report = await acceptLiveViaNode(h.page, h.options, process.execPath);
    assert.equal(report.status, 'passed'); assert.equal(report.scope, 'complete-current-hand-sync');
    assert.equal(report.attempt, null); assert.equal(report.paused, true); assert.equal(h.page.sends, 0);
    assert.equal(h.page.calls.includes('sync'), true); assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(h.page.controls.at(-1)?.paused, true);
    const raw = new DatabaseSync(h.page.databasePath, { readOnly: true });
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 5);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM action_attempts').get()?.n, 0);
      const state = JSON.parse(raw.prepare('SELECT projection FROM checkpoints').get()!.projection as string);
      assert.equal(state.state.ownConcealed.length, 14); assert.equal(state.state.trust, 'trusted');
    } finally { raw.close(); }
  } finally { await h.cleanup(); }
});

test('the child broker carries a persisted dispatch and authority confirmation across the Page RPC boundary', async () => {
  const h = await createLiveScenario();
  try {
    // ScriptedPage.prepare independently reads the child worker's dispatching row.
    const report = await acceptLiveViaNode(h.page, { ...h.options, discardOnce: true }, process.execPath);
    assert.equal(report.status, 'passed'); assert.equal(report.attempt.status, 'confirmed');
    assert.equal(report.attempt.executionMode, 'live'); assert.equal(report.counts.confirmations, 1);
    assert.equal(report.counts.outbox, 1); assert.equal(h.page.sends, 1);
    assert.equal(h.page.calls.filter(method => method === 'prepare').length, 1);
    assert.equal(h.page.calls.filter(method => method === 'dispatch').length, 1);
    assert.equal(h.page.prepared.tile, '0m'); assert.equal(h.page.controls.at(-1)?.paused, true);
  } finally { await h.cleanup(); }
});

test('Page failure replies cross stdio as a safe code and cannot prepare or leak error details', async () => {
  const h = await createLiveScenario();
  try {
    const sensitive = 'COOKIE=SHOULD_NOT_LEAK';
    const page: EgoPagePort = { evaluate: async (source, argument) => {
      if ((argument as { method: string }).method === 'automaticTiming') throw new Error(sensitive);
      return h.page.evaluate(source, argument);
    } };
    const report = await acceptLiveViaNode(page, { ...h.options, discardOnce: true }, process.execPath);
    assert.equal(report.status, 'blocked'); assert.equal(report.code, 'EGO_PAGE_FAILED');
    assert.equal(h.page.sends, 0); assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(h.page.controls.at(-1)?.paused, true);
    assert.equal(JSON.stringify(report).includes(sensitive), false);
    assert.equal((await readFile(report.reportPath, 'utf8')).includes(sensitive), false);
    const raw = new DatabaseSync(h.page.databasePath, { readOnly: true });
    try {
      assert.equal(raw.prepare('SELECT count(*) AS n FROM game_events').get()?.n, 0);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM action_attempts').get()?.n, 0);
    } finally { raw.close(); }
  } finally { await h.cleanup(); }
});

test('native failure receipts retain the known-not-sent versus uncertain distinction across stdio', async t => {
  for (const delivery of ['not-sent', 'unknown'] as const) await t.test(delivery, async () => {
    const h = await createLiveScenario();
    try {
      h.page.delivery = delivery;
      const report = await acceptLiveViaNode(h.page, { ...h.options, discardOnce: true }, process.execPath);
      assert.equal(report.status, 'blocked');
      assert.equal(report.attempt.status, delivery === 'not-sent' ? 'not-dispatched' : 'uncertain');
      assert.equal(report.attempt.receipt.delivery, delivery);
      assert.equal(report.counts.confirmations, 0); assert.equal(report.counts.outbox, 0);
      assert.equal(h.page.sends, delivery === 'not-sent' ? 0 : 1);
      assert.equal(h.page.calls.filter(method => method === 'dispatch').length, 1);
      assert.equal(h.page.controls.at(-1)?.paused, true);
    } finally { await h.cleanup(); }
  });
});

test('an unavailable child runtime fails with a safe error before any gameplay RPC', async () => {
  const h = await createLiveScenario();
  try {
    await assert.rejects(acceptLiveViaNode(h.page, h.options, '/definitely-missing-maji-node'), /LIVE_NODE_UNAVAILABLE/);
    assert.equal(h.page.calls.every(method => method === 'pause'), true);
  } finally { await h.cleanup(); }
});


test('console stop is forwarded to the real child and closes a long observation early', async () => {
  const h = await createLiveScenario();
  const cancellation = new AbortController();
  let stopped = false;
  const page: EgoPagePort = { evaluate: async (source, argument) => {
    const result = await h.page.evaluate(source, argument);
    if (!stopped && (argument as {method:string}).method === 'drain') {
      stopped = true;
      cancellation.abort();
    }
    return result;
  } };
  try {
    const began = Date.now();
    const report = await acceptLiveViaNode(page, { ...h.options, observeMs: 60_000 }, process.execPath, cancellation.signal);
    assert.equal(stopped, true);
    assert.ok(Date.now() - began < 10_000);
    assert.equal(report.programPaused, true);
    assert.equal(h.page.sends, 0);
    assert.equal(h.page.controls.at(-1)?.paused, true);
  } finally { await h.cleanup(); }
});

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import type { LiveAcceptanceOptions } from '../src/app/live.ts';

const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;
const options: LiveAcceptanceOptions = { room, outputDirectory: '/tmp/maji-broker-output', sourceVersion: 'test', observeMs: 0 };
async function worker(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'maji-broker-test-'));
  const program = join(directory, 'fake-node.mjs');
  await writeFile(program, `#!${process.execPath}\n${source}`); await chmod(program, 0o700);
  return { program, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('broker waits for process exit after a result before allowing another executor', async () => {
  const fixture = await worker(`
    process.stdout.write(JSON.stringify({kind:'result',report:{status:'passed'}})+'\\n');
    setTimeout(()=>process.exit(0),80);
  `);
  try {
    const start = performance.now();
    assert.equal((await acceptLiveViaNode({ evaluate: async () => null }, options, fixture.program)).status, 'passed');
    assert.ok(performance.now() - start >= 75);
  } finally { await fixture.cleanup(); }
});

test('broker rejects queued single or combined dispatch after cancellation while allowing its drain', async t => {
 for(const blocked of ['dispatch','dispatchPrepared'])await t.test(blocked,async()=>{
  const fixture = await worker(`
    import {createInterface} from 'node:readline';
    const lines=createInterface({input:process.stdin});
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    lines.on('line',line=>{
      const message=JSON.parse(line);
      if(message.kind==='start')send({kind:'page',id:1,method:'read'});
      if(message.kind==='stop')send({kind:'page',id:2,method:'${blocked}'});
      if(message.id===2){send({kind:'result',report:{status:'blocked',code:message.code}});lines.close();process.stdin.destroy();}
    });
  `);
  const cancellation = new AbortController(), methods: string[] = [];
  try {
    const report = await acceptLiveViaNode({ evaluate: async (_source, argument) => {
      const method = argument.method; methods.push(method);
      if (method === 'read') cancellation.abort();
      return {};
    } }, options, fixture.program, cancellation.signal);
    assert.equal(report.code, 'LIVE_CANCELLED'); assert.equal(methods.includes(blocked), false); assert.equal(methods.includes('pause'), true);
  } finally { await fixture.cleanup(); }
 });
});

test('cooperative cancellation preserves the native page epoch and clamps a queued actor resume to paused',async()=>{
 const fixture=await worker(`
  import {createInterface} from 'node:readline';
  const lines=createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
  const control={processInstanceId:'actor',controlEpoch:2,paused:false};
  lines.on('line',line=>{
   const m=JSON.parse(line);
   if(m.kind==='start')send({kind:'page',id:1,method:'pause',argument:control});
   if(m.id===1)send({kind:'page',id:2,method:'read'});
   if(m.kind==='stop')send({kind:'page',id:3,method:'pause',argument:{...control,controlEpoch:3}});
   if(m.id===3){send({kind:'result',report:{programPaused:true}});lines.close();process.stdin.destroy();}
  });
 `);
 const stop=new AbortController();let pageEpoch=1,paused=false;const controls:any[]=[];
 try{
  const report=await acceptLiveViaNode({evaluate:async(_source,input)=>{
   if(input.method==='pause'){
    controls.push(input.argument);
    if(!input.argument)pageEpoch++;
    paused=input.argument?.paused!==false;
   }else if(input.method==='read')stop.abort();
   return{pageEpoch,paused};
  }},options,fixture.program,stop.signal);
  assert.equal(report.programPaused,true);assert.equal(pageEpoch,1);assert.equal(paused,true);
  assert.deepEqual(controls.map(c=>[c?.controlEpoch,c?.paused]),[[2,false],[2,true],[3,true]]);
 }finally{await fixture.cleanup();}
});

test('a rejected cancellation fence falls back to page invalidation and finishes before the broker returns',async()=>{
 const fixture=await worker(`
  import {createInterface} from 'node:readline';
  const lines=createInterface({input:process.stdin}),send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
  lines.on('line',line=>{
   const m=JSON.parse(line);
   if(m.kind==='start')send({kind:'page',id:1,method:'pause',argument:{processInstanceId:'actor',controlEpoch:1,paused:false}});
   if(m.id===1)send({kind:'page',id:2,method:'read'});
   if(m.kind==='stop'){send({kind:'result',report:{programPaused:true}});lines.close();process.stdin.destroy();}
  });
 `);
 const stop=new AbortController();let invalidated=false;
 try{
  await acceptLiveViaNode({evaluate:async(_source,input)=>{
   if(input.method==='read')stop.abort();
   if(input.method==='pause'&&input.argument?.paused===true)throw Error('FENCE_STALE');
   if(input.method==='pause'&&!input.argument){await new Promise(r=>setTimeout(r,60));invalidated=true;}
   return{};
  }},options,fixture.program,stop.signal);
  assert.equal(invalidated,true);
 }finally{await fixture.cleanup();}
});
