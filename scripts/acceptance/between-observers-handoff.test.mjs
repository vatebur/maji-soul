import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createObserverHandoff} from './between-observers-handoff.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expected={gameUuid:'synthetic-game',handSha256:'a'.repeat(64),ownSeat:3,pageEpoch:5,sourceStream:1,afterStep:32};
const closure={actorExited:true,unresolvedAttempts:0};
const proto='syntax="proto3"; package lq; message Wrapper { string name=1; bytes data=2; }';
const rpcMap='{}';
const hash=value=>createHash('sha256').update(value).digest('hex');
const pins={clientVersion:'4.0.51',protoSha256:hash(proto),rpcMapSha256:hash(rpcMap)};
async function fixture(t) {
  const root=await fs.mkdtemp(join(tmpdir(),'maji-handoff-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=join(root,'evidence'),protocolDirectory=join(root,'protocol');
  await fs.mkdir(directory,{mode:0o700});
  await fs.mkdir(join(protocolDirectory,'proto'),{recursive:true});
  await Promise.all([
    fs.writeFile(join(protocolDirectory,'proto','liqi.proto'),proto),
    fs.writeFile(join(protocolDirectory,'liqi.json'),rpcMap),
  ]);
  const {archiveTail,handoff}=createObserverHandoff({evidenceDirectory:directory,protocol:{directory:protocolDirectory,pins}});
  const state={schemaVersion:1,allocator:'wire-multiplexer-v1',...expected,lastStep:34,
    generation:101,nativeRestoreRevision:2,controlEpoch:9,connected:true,freshConnection:true,
    paused:true,phase2ActionsEnabled:false,overflow:false,reason:null,handEnded:false,matchEnded:false,matchResult:null,
    pendingRpcCount:0,operation:null,lastClientWin:null,lastOwnWin:null,
    stats:{clientRequests:8,bridgeSyncRequests:1,bridgeActionSends:0,clientWinRequests:0,authoritativeOwnWins:0}};
  delete state.afterStep;
  const records=[33,34].map((step,index)=>({kind:'action',name:index?'ActionDiscardTile':'ActionDealTile',step,
    payload:index?{seat:2,tile:'7m',moqie:true}:{seat:2,tile:'',left_tile_count:40},
    pageEpoch:5,sourceStream:1,gameUuid:expected.gameUuid,handSha256:expected.handSha256,generation:100+index,
    receivedAt:'2026-11-06T00:00:00.000Z',receivedMonoMs:500+index}));
  const calls={evaluate:0,read:0,drain:0,reconnect:0,restore:0,order:[]};
  const events=new EventTarget();
  class Socket extends EventTarget {send(){}close(){} }
  const context=createContext({document:{scripts:[{src:'https://example.invalid/WebGL-release-4.0.51(bundle)/x.js'}]},
    WebSocket:Socket,Uint8Array,ArrayBuffer,TextDecoder,MessageEvent,performance,crypto:{randomUUID},setTimeout,clearTimeout,
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)});
  context.window=context;
  const bridge={
    read(){calls.read++;return {...clone(state),queued:records.length};},
    drain(){calls.drain++;const snapshot=bridge.read();return {...snapshot,records:clone(records.splice(0))};},
    reconnect(){calls.reconnect++;calls.order.push('reconnect');state.pageEpoch++;state.connected=false;state.reason='RECONNECT_REQUESTED';return {reconnectRequested:true};},
    restore(){calls.restore++;calls.order.push('restore');assert.equal(state.pendingRpcCount,0);delete context.__majiBridge;return {restored:true};},
  };
  context.__majiBridge=bridge;
  const h={directory,state,records,calls,context,bridge,path:directory+'/tail.json',onEvaluate:null};
  h.page={async evaluate(fn,arg){
    calls.evaluate++;context.__argument=clone(arg);
    const result=runInContext(`(${fn.toString()})(__argument)`,context);
    // A browser may receive a later task while the returned result is in transit.
    if(h.onEvaluate)await h.onEvaluate(arg,result);
    return clone(result);
  }};
  h.archive=(options={})=>archiveTail(h.page,{archivePath:h.path,expected:clone(expected),closure,...options});
  h.handoff=()=>handoff(h.page,h.path);
  h.artifact=()=>fs.readFile(h.path,'utf8').then(JSON.parse);
  return h;
}

test('actual ended/disconnected/overflow shape is rejected before drain or teardown',async t=>{
  const h=await fixture(t);
  Object.assign(h.state,{pageEpoch:61,generation:498,nativeRestoreRevision:2,sourceStream:3,lastStep:142,
    handEnded:true,matchEnded:true,connected:false,reason:'BRIDGE_QUEUE_OVERFLOW',overflow:true});
  const before=clone(h.records);
  await assert.rejects(h.archive(),/HANDOFF_BRIDGE_UNTRUSTED/);
  assert.deepEqual(h.records,before);assert.equal(h.calls.drain,0);assert.equal(h.calls.reconnect,0);assert.equal(h.calls.restore,0);
  assert.deepEqual(await fs.readdir(h.directory),[]);
});

test('active observer, pending RPC, terminal or untrusted scope cannot consume the queue',async t=>{
  const closed=await fixture(t);
  for(const value of [undefined,{actorExited:false,unresolvedAttempts:0},{actorExited:true,unresolvedAttempts:1}]) {
    await assert.rejects(closed.archive({closure:value}),/HANDOFF_OBSERVER_NOT_CLOSED/);
  }
  assert.equal(closed.calls.evaluate,0);
  for(const change of [{handEnded:true},{matchEnded:true},{connected:false},{freshConnection:false},{overflow:true},
    {reason:'DISCONNECTED'},{paused:false},{phase2ActionsEnabled:true},{pendingRpcCount:1},
    {pageEpoch:6},{sourceStream:2},{ownSeat:0},{handSha256:'b'.repeat(64)},
    {stats:{...closed.state.stats,bridgeActionSends:1}},
    {operation:{value:{operation_list:[{type:9}]}}},{lastClientWin:{type:9}}]) {
    const h=await fixture(t);Object.assign(h.state,change);await assert.rejects(h.archive(),/HANDOFF_/);
    assert.equal(h.calls.drain,0);assert.equal(h.calls.reconnect,0);assert.equal(h.records.length,2);
  }
});

test('contiguous same-hand tail is privately fsynced with integrity and exact cursor',async t=>{
  const h=await fixture(t),original=clone(h.records),result=await h.archive(),artifact=await h.artifact();
  assert.equal(result.eligible,true);assert.equal(result.records,2);assert.equal(result.afterStep,34);
  assert.equal(artifact.payloadSha256,digest(artifact.payload));assert.equal(artifact.payload.eligible,true);
  assert.deepEqual(artifact.payload.capture.records,original);assert.equal(artifact.payload.capture.after.queued,0);
  assert.equal(artifact.payload.capture.before.queued,2);assert.equal((await fs.stat(h.path)).mode&0o777,0o600);
  assert.equal(h.context.__majiBetweenObserversHandoff.phase,'saved');assert.equal(h.calls.reconnect,0);
});

test('boundary, identity, unknown kind and noncontiguous drained tails remain archived but ineligible',async t=>{
  for(const change of [r=>r.name='ActionHule',r=>r.name='ActionNewRound',r=>r.kind='fault',r=>r.kind='auth-summary',
    r=>r.sourceStream=2,r=>r.gameUuid='other-game',r=>r.step=35,r=>r.generation=500,r=>r.payload.gameend={scores:[]}]) {
    const h=await fixture(t);change(h.records[1]);const original=clone(h.records);
    await assert.rejects(h.archive(),/HANDOFF_TAIL_/);
    const artifact=await h.artifact();assert.equal(artifact.payload.eligible,false);assert.deepEqual(artifact.payload.capture.records,original);
    await assert.rejects(h.handoff(),/HANDOFF_TAIL_REJECTED/);
    assert.equal(h.calls.drain,1);assert.equal(h.calls.reconnect,0);assert.equal(h.calls.restore,0);
  }
});

test('new inbound tail during fsync is preserved and prevents handoff',async t=>{
  const h=await fixture(t);
  h.onEvaluate=(input)=>{if(input.kind==='archive') {
    h.state.lastStep=35;h.state.generation=102;
    h.records.push({kind:'action',name:'ActionDealTile',step:35,payload:{seat:1,tile:''},generation:102,
      pageEpoch:5,sourceStream:1,gameUuid:expected.gameUuid,handSha256:expected.handSha256});
  }};
  await h.archive();const newTail=clone(h.records);
  await assert.rejects(h.handoff(),/HANDOFF_CURSOR_CHANGED/);
  assert.deepEqual(h.records,newTail);assert.equal(h.calls.drain,1);assert.equal(h.calls.reconnect,0);
});

test('every control/source cursor and outstanding request are rechecked after archive',async t=>{
  const h=await fixture(t);await h.archive();const saved=clone(h.state);
  for(const change of [{pageEpoch:6},{generation:102},{nativeRestoreRevision:3},{controlEpoch:10},{sourceStream:2},
    {lastStep:35},{gameUuid:'other-game'},{handSha256:'b'.repeat(64)},{ownSeat:0},{pendingRpcCount:1},
    {stats:{...saved.stats,clientRequests:9}},{handEnded:true},{connected:false}]) {
    Object.assign(h.state,clone(saved),change);await assert.rejects(h.handoff(),/HANDOFF_/);
    assert.equal(h.calls.reconnect,0);assert.equal(h.calls.restore,0);
  }
});

test('client version, archive integrity, and pinned installer identity fail before teardown',async t=>{
  const h=await fixture(t);
  h.context.document.scripts[0].src='https://example.invalid/WebGL-release-0.0.0(other)/x.js';
  await assert.rejects(h.archive(),/CLIENT_VERSION_MISMATCH/);assert.equal(h.calls.drain,0);
  h.context.document.scripts[0].src='https://example.invalid/WebGL-release-4.0.51(bundle)/x.js';
  await h.archive();const original=await h.artifact();
  const modified=clone(original);modified.payload.capture.after.lastStep++;
  await fs.writeFile(h.path,JSON.stringify(modified));await assert.rejects(h.handoff(),/HANDOFF_ARCHIVE_INVALID/);
  const repinned=clone(original);repinned.payload.capture.pins.bridgeSha256='f'.repeat(64);repinned.payloadSha256=digest(repinned.payload);
  await fs.writeFile(h.path,JSON.stringify(repinned));await assert.rejects(h.handoff(),/HANDOFF_CODE_CHANGED/);
  await fs.writeFile(h.path,JSON.stringify(original));h.context.document.scripts[0].src='wrong-client';
  await assert.rejects(h.handoff(),/CLIENT_VERSION_MISMATCH/);assert.equal(h.calls.reconnect,0);
});

test('disk write failure retains the drained batch for retry to a new file without redrain',async t=>{
  const h=await fixture(t),original=clone(h.records);
  h.onEvaluate=async(input)=>{if(input.kind==='archive')await fs.writeFile(h.path,'exclusive-existing-file');};
  await assert.rejects(h.archive(),/EEXIST/);assert.equal(h.calls.drain,1);
  assert.equal(h.context.__majiBetweenObserversHandoff.phase,'drained');
  assert.deepEqual(clone(h.context.__majiBetweenObserversHandoff.capture.records),original);
  h.onEvaluate=null;h.path=h.directory+'/retried-tail.json';await h.archive();
  assert.equal(h.calls.drain,1);assert.deepEqual((await h.artifact()).payload.capture.records,original);
});

test('successful mock replacement uses current real installer in one turn, stays paused, and cannot be repeated',async t=>{
  const h=await fixture(t);await h.archive();const evaluations=h.calls.evaluate;
  const result=await h.handoff();
  assert.equal(h.calls.evaluate,evaluations+1);assert.deepEqual(h.calls.order,['reconnect','restore']);
  assert.equal(result.status,'bridge-replaced-awaiting-fresh-sync');assert.equal(result.automationEnabled,false);
  assert.notEqual(h.context.__majiBridge,h.bridge);
  const state=h.context.__majiBridge.read();assert.equal(state.paused,true);assert.equal(state.phase2ActionsEnabled,false);
  assert.equal(state.stats.bridgeActionSends,0);assert.equal(state.stats.bridgeSyncRequests,0);assert.equal(state.queued,0);
  assert.equal(state.autoWin,null);assert.equal(state.lastAutoWinReadback,null);assert.equal(state.freshConnection,false);
  await assert.rejects(h.handoff(),/HANDOFF_ARCHIVE_STALE/);assert.equal(h.calls.reconnect,1);
});

test('uncertain guarded teardown is latched and never retried',async t=>{
  const h=await fixture(t);await h.archive();
  h.bridge.restore=()=>{h.calls.restore++;throw Error('BRIDGE_PENDING_REQUESTS');};
  await assert.rejects(h.handoff(),/BRIDGE_PENDING_REQUESTS/);
  assert.equal(h.context.__majiBetweenObserversHandoff.phase,'handoff-started');assert.equal(h.calls.reconnect,1);
  await assert.rejects(h.handoff(),/HANDOFF_ARCHIVE_NOT_SAVED/);assert.equal(h.calls.reconnect,1);
});
