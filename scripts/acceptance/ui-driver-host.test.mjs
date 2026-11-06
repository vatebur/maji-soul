// Private host contract tests. Browser, CDP, SQLite readers, pixels and durable
// files are replaced with local mocks. Never opens the original live ledger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import * as driver from './ui-validation-driver.mjs';
import {createUiDriverHost} from './ui-driver-host.mjs';
import {digest} from '../../src/domain/game/value.ts';
import {handSourceStream} from '../../src/adapters/majsoul/sync.ts';
import {legalOperationActions} from '../../src/adapters/majsoul/actions.ts';

const clone=value=>structuredClone(value);

function harness(options={}) {
  const clock={now:1_800_000_000_000},events=[],files=new Map(),root='/mock',label='host-test',sessionId='live-test-main';
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
  const codes=['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','1p','2z','2z','9s'];
  const r={pageEpoch:3,sourceStream:2,generation:10,lastStep:8,controlEpoch:5,nativeRestoreRevision:4,
    gameUuid:'mock-public-match',handSha256:'a'.repeat(64),ownSeat:2,paused:true,connected:true,freshConnection:true,
    reason:null,overflow:false,queued:0,phase2ActionsEnabled:false,handEnded:false,matchEnded:false,
    stats:{bridgeActionSends:0,clientRequests:5},operation:{step:8,value:{seat:2,operation_list:[{type:1,combination:[]}]}}};
  function ack(proof){
    assert.equal(proof.pageEpoch,r.pageEpoch);assert.equal(proof.generation,r.generation);assert.equal(proof.step,r.lastStep);
    assert.equal(proof.nativeRestoreRevision,r.nativeRestoreRevision);
    r.autoWin={...clone(proof),expiresInMs:1000};r.lastAutoWinReadback={...clone(proof),sourceStream:r.sourceStream};
    return {state:proof.state};
  }
  const proof=()=>({source:'unity-button-pixels-v1',state:'enabled',pageEpoch:r.pageEpoch,generation:r.generation,step:r.lastStep,
    nativeRestoreRevision:r.nativeRestoreRevision,observedAt:new ClockDate().toISOString(),rgbaSha256:'b'.repeat(64)});
  ack(proof());
  const gameMatchKey=`game-${digest(r.gameUuid).slice(0,32)}`,gameHandKey=`hand-${digest([gameMatchKey,r.handSha256]).slice(0,32)}`;
  const state={sessionId,matchId:'mock-match',handId:'mock-hand',connectionEpoch:2,stateVersion:20,trust:'trusted',trustIssues:[],ownSeat:2,
    ownConcealed:codes.map((code,i)=>({instanceId:`p-${i}`,code})),drawnTileRef:{known:true,value:'p-13'},currentActor:{known:true,value:2},
    players:Object.fromEntries([0,1,2,3].map(seat=>[seat,{seat,score:25000,river:[],melds:[],riichi:'none',concealedCount:{known:true,value:seat===2?14:13}}]))};
  state.operationWindow={id:'mock-window',connectionEpoch:2,status:'open',candidates:legalOperationActions(state,r.operation.value,'mock-window','mock-evidence')};
  const checkpoint={sessionId,sequence:12,connectionEpoch:2,gameMatchKey,gameHandKey,
    sourceCursor:`${handSourceStream(gameMatchKey,gameHandKey)}:8`,handStatus:'playing',matchStatus:'playing',matchEndPending:false,
    recoveryRequired:false,unresolvedAttempts:0,state};
  let checkpointCalls=0,verifyCalls=0,pixelCalls=0,captures=0,statusFailure=options.failStatusOnce===true;
  const record=(kind,extra={})=>events.push({kind,at:clock.now,...clone(extra)});
  const fs={
    readFile:async path=>{if(!files.has(path)){const error=Error('missing');error.code='ENOENT';throw error;}return files.get(path);},
    open:async(path,mode)=>{
      if(mode==='wx'&&files.has(path)){const error=Error('exists');error.code='EEXIST';throw error;}
      if(mode==='w')files.set(path,'');
      return {writeFile:async text=>{files.set(path,Buffer.isBuffer(text)?Buffer.from(text):(mode==='a'?(files.get(path)??''):'')+String(text));record('file-write',{path});},
        sync:async()=>{record('file-sync',{path});await options.onSync?.(path,h);},close:async()=>{}};
    },
    mkdir:async()=>{},
    writeFile:async(path,value)=>{
      if(statusFailure&&path.endsWith('-ui-driver-status.json')){statusFailure=false;throw Error('TEST_STATUS_WRITE_FAILED');}
      files.set(path,typeof value==='string'?value:Buffer.from(value));record('file-write',{path});await options.onFile?.(path,h);
    },
  };
  const page={
    evaluate:async(fn,arg)=>{
      record('page-read');
      return vm.runInNewContext(`(${fn.toString()})(__arg)`,{window:{__majiBridge:{read:()=>clone(r),ackAutoWin:ack}},__arg:arg});
    },
    cdp:async(method,args)=>{
      if(method==='Page.captureScreenshot'){record('capture',{capture:++captures});await options.onCapture?.(h);return {data:Buffer.from('mock-png-'+captures).toString('base64')};}
      assert.equal(method,'Input.dispatchMouseEvent');record(args.type,{sourceStream:r.sourceStream,pageEpoch:r.pageEpoch,point:{x:args.x,y:args.y}});
      if(args.type==='mousePressed'){
        const persisted=JSON.parse(files.get(root+'/'+label+'-ui-driver-state.json'));
        assert.equal(persisted.latch.pending.pointerOutcome,'reserved');assert.equal(persisted.actions,1);
        assert.ok((files.get(root+'/'+label+'-ui-driver-audit.jsonl')??'').includes('input-reserved'));
        r.generation++;r.autoWin=null;r.lastAutoWinReadback=null;
        if(options.pressError)throw Error('TEST_PRESS_UNCERTAIN');
      }
      if(args.type==='mouseReleased'&&options.releaseError)throw Error('TEST_RELEASE_UNCERTAIN');
      await options.onInput?.(args,h);return {};
    },
    waitForTimeout:async ms=>{clock.now+=ms;await options.onWait?.(ms,h);},
  };
  const verifyAutoWin=async port=>{
    verifyCalls++;record('verify-start',{verifyCalls});
    const before=await port.evaluate(()=>window.__majiBridge.read());
    await port.cdp('Page.captureScreenshot',{format:'png'});
    if(options.verifyError?.(verifyCalls))throw Error(options.verifyError(verifyCalls));
    const after=await port.evaluate(()=>window.__majiBridge.read());
    if(before.generation!==after.generation||before.lastStep!==after.lastStep)throw Error('AUTO_WIN_READBACK_STALE');
    const value=proof();
    await port.evaluate(({method,argument})=>window.__majiBridge[method](argument),{method:'ackAutoWin',argument:value});
    record('verify-ack');return {...value,clicked:false};
  };
  const deps={...driver,
    readUiCheckpoint:async({databasePath,sessionId:expected,pageState})=>{
      assert.equal(databasePath,'/mock/ledger.sqlite');
      assert.equal(expected,sessionId);driver.assertCheckpointCurrent(checkpoint,pageState);checkpointCalls++;record('checkpoint',{checkpointCalls});
      await options.onCheckpoint?.(checkpointCalls,h);return clone(checkpoint);
    },
    readUiProgress:async({sessionId:expected})=>{assert.equal(expected,sessionId);record('progress');return {...clone(checkpoint),state:{trust:checkpoint.state.trust}};},
    readUiDiscardAuthority:async({plan})=>{record('authority');return options.noAuthority?null:{sessionId,gameMatchKey,gameHandKey,
      sourceCursor:plan.expectedSourceCursor,kind:'discard',actor:2,tiles:[plan.tileCode],tsumogiri:{known:true,value:plan.action.tsumogiri},riichiDeclaration:false};},
    planUiAction:args=>driver.planUiAction({...args,nowMs:clock.now}),
    assertUiPlanCurrent:(plan,args)=>{const result=driver.assertUiPlanCurrent(plan,{...args,nowMs:clock.now});options.afterGuard?.(h);return result;},
    claimUiWindow:(latch,plan,args)=>{record('claim');return driver.claimUiWindow(latch,plan,{...args,nowMs:clock.now});},
  };
  async function inspect(kind,code,drawn){pixelCalls++;record('pixel-inspect',{pixelCalls,pixelKind:kind,code,drawn});
    await options.onInspect?.({kind,code,drawn,pixelCalls},h);
    const error=options.pixelError?.({kind,code,drawn,pixelCalls},h);if(error)throw Error(error);
  }
  const inspectTileBinding=async(_png,code,{drawn})=>{await inspect('discard',code,drawn);return {code,drawn,slot:drawn?13:0,x:drawn?1504:430.5,y:850,pngSha256:'c'.repeat(64)};};
  const verifySkipPixels=async()=>{await inspect('skip');return {x:1302,y:700,pngSha256:'c'.repeat(64)};};
  const templates=async()=>{record('template-warm');if(options.templateError)throw Error(options.templateError);return [];};
  const {tick}=createUiDriverHost({fs,Date:ClockDate,verifyAutoWin,readers:deps,pixels:{inspectTileBinding,verifySkipPixels,templates}});
  const ctx={page,root,label,databasePath:'/mock/ledger.sqlite',control:{enabled:true,sessionId,deadlineMs:clock.now+60_000,maxActions:3},state:{}};
  const h={tick:()=>tick(ctx),ctx,r,checkpoint,clock,files,events,
    presses:()=>events.filter(e=>e.kind==='mousePressed').length,
    moves:()=>events.filter(e=>e.kind==='mouseMoved').length,
    releases:()=>events.filter(e=>e.kind==='mouseReleased').length,
    captures:()=>captures,
    claims:()=>events.filter(e=>e.kind==='claim').length,
    retry:async()=>{clock.now+=750;await tick(ctx);},
    restart:()=>{ctx.state={};},
    advance:()=>{r.lastStep++;r.generation++;r.operation=null;checkpoint.sequence++;checkpoint.sourceCursor=`${handSourceStream(gameMatchKey,gameHandKey)}:${r.lastStep}`;checkpoint.state.operationWindow.status='closed';},
    audit:()=>String(files.get(root+'/'+label+'-ui-driver-audit.jsonl')??'').trim().split('\n').filter(Boolean).map(JSON.parse),
    saved:()=>JSON.parse(files.get(root+'/'+label+'-ui-driver-state.json')),
  };
  return h;
}

test('initial and post-input readback failures keep their distinct original frames and audit entries',async()=>{
  const initial=harness({verifyError:()=>'AUTO_WIN_UNVERIFIED'});
  await assert.rejects(initial.tick(),/AUTO_WIN_UNVERIFIED/);
  const first=initial.audit().find(entry=>entry.kind==='readback-failed');
  assert.equal(first.stage,'before-input');
  assert.equal(first.code,'AUTO_WIN_UNVERIFIED');
  assert.equal(initial.presses(),0);
  assert.ok(initial.audit().some(entry=>entry.kind==='readback-started'&&entry.readbackId===first.readbackId));
  const frame=initial.files.get(initial.ctx.root+'/'+initial.ctx.label+'-ui/'+first.frame);
  assert.deepEqual(frame,Buffer.from('mock-png-1'));
  assert.equal(first.pngSha256,createHash('sha256').update(frame).digest('hex'));

  const after=harness({verifyError:n=>n===2?'AUTO_WIN_READBACK_STALE':null});
  await after.tick();after.advance();await after.tick();
  const failure=after.audit().find(entry=>entry.kind==='readback-failed');
  assert.equal(failure.stage,'after-input');
  assert.equal(failure.input,1);
  assert.deepEqual(after.files.get(after.ctx.root+'/'+after.ctx.label+'-ui/'+failure.frame),Buffer.from('mock-png-2'));
  assert.equal(after.presses(),1);
});

test('scope advancement after a successful ACK preserves historical proof and the failure frame',async()=>{
  const h=harness();
  const evaluate=h.ctx.page.evaluate;
  h.ctx.page.evaluate=async(...args)=>{
    const result=await evaluate(...args);
    if(args[1]?.argument?.source==='unity-button-pixels-v1')h.r.generation++;
    return result;
  };
  await h.tick();
  const failure=h.audit().find(entry=>entry.kind==='readback-failed');
  assert.equal(failure.code,'UI_PIXEL_RETRY_SCOPE_CHANGED');
  assert.equal(failure.proof.state,'enabled');
  assert.equal(failure.ack.state,'enabled');
  assert.ok(failure.frame);
  assert.equal(h.presses(),0);
});

test('a slow post-input frame is retained when the eight-second budget expires before ACK',async()=>{
  const h=harness({onCapture:h=>{if(h.captures()===2)h.clock.now+=8000;}});
  await h.tick();h.advance();
  await assert.rejects(h.tick(),/UI_POST_INPUT_PROOF_TIMEOUT/);
  const failure=h.audit().find(entry=>entry.kind==='readback-failed');
  assert.equal(failure.stage,'after-input');
  assert.equal(failure.code,'UI_POST_INPUT_PROOF_TIMEOUT');
  assert.equal(failure.ack,null);
  assert.ok(failure.frame);
  assert.equal(h.events.filter(event=>event.kind==='verify-ack').length,1);
  assert.equal(h.presses(),1);
});

test('disabled control, invalid labels and concurrent ticks are rejected before pointer input',async()=>{
  const disabled=harness();disabled.ctx.control.enabled=false;
  await assert.rejects(disabled.tick(),/UI_CONTROL_LIMIT/);
  assert.equal(disabled.events.length,0);
  const invalid=harness();invalid.ctx.label='../other-run';
  await assert.rejects(invalid.tick(),/UI_RUN_PATH_REQUIRED/);
  assert.equal(invalid.events.length,0);
  let releaseCapture;
  const captureWaiting=new Promise(resolve=>{releaseCapture=resolve;});
  const concurrent=harness({onCapture:()=>captureWaiting});
  const first=concurrent.tick();
  await assert.rejects(concurrent.tick(),/UI_TICK_IN_PROGRESS/);
  releaseCapture();
  await first;
  assert.equal(concurrent.presses(),1);
});

test('host persists reservation before one press/release and verifies pending proof on an opponent turn',async()=>{
  const h=harness();await h.tick();assert.equal(h.presses(),1);assert.equal(h.releases(),1);
  assert.equal(h.ctx.state.latch.pending.pointerOutcome,'released');assert.equal(h.ctx.state.pendingProof.verified,false);
  const at=h.events.length;h.advance();await h.tick();
  const events=h.events.slice(at);assert.ok(events.findIndex(e=>e.kind==='verify-ack')<events.findIndex(e=>e.kind==='progress'));
  assert.equal(h.ctx.state.latch.pending,null);assert.equal(h.ctx.state.pendingProof,null);assert.equal(h.presses(),1);
  assert.equal(h.audit().find(e=>e.kind==='input-reconciled').status,'discard-observed');
});

test('hover scope changes or new 8/9 windows prevent pressing and preserve a consumed stopped reservation',async()=>{
  for(const change of [h=>h.r.pageEpoch++,h=>h.r.sourceStream++,h=>h.r.generation++,h=>h.r.controlEpoch++,h=>h.r.nativeRestoreRevision++,
    h=>h.r.lastStep++,h=>h.r.operation.value.operation_list.push({type:8}),h=>h.r.operation.value.operation_list.push({type:9})]){
    const h=harness({onWait:(ms,h)=>{if(ms===150)change(h);}});
    await assert.rejects(h.tick());assert.equal(h.moves(),1);assert.equal(h.presses(),0);
    assert.equal(h.ctx.state.latch.halted,true);assert.equal(h.ctx.state.latch.pending.pointerOutcome,'not-started');
    await assert.rejects(h.tick());assert.equal(h.presses(),0);
  }
});

test('new win offers are blocked both before any input and atomically before readback ACK',async()=>{
  for(const type of [8,9]){
    const initial=harness();initial.r.operation.value.operation_list.push({type});
    await assert.rejects(initial.tick(),/CLIENT_AUTO_WIN_WINDOW/);assert.equal(initial.moves(),0);
    const during=harness({onCapture:h=>{h.r.operation.value.operation_list.push({type});}});
    await assert.rejects(during.tick(),/UI_READBACK_SCOPE_CHANGED/);assert.equal(during.moves(),0);
  }
});

test('readback ACK refuses lost paused/fresh/connected state and reads flow through the observer port',async()=>{
  for(const mutate of [r=>r.paused=false,r=>r.phase2ActionsEnabled=true,r=>r.connected=false,r=>r.freshConnection=false,r=>r.reason='DISCONNECTED',r=>r.overflow=true]){
    const h=harness({onCapture:h=>mutate(h.r)});await assert.rejects(h.tick(),/UI_READBACK_SCOPE_CHANGED/);assert.equal(h.moves(),0);
  }
  const h=harness();let reads=0,captures=0;
  h.ctx.port={evaluate:async(...args)=>{reads++;return h.ctx.page.evaluate(...args);},cdp:async(...args)=>{captures++;return h.ctx.page.cdp(...args);}};
  await h.tick();assert.ok(reads>0);assert.equal(captures,1);assert.equal(h.presses(),1);
});

test('uncertain press or release always attempts release and cannot produce another pointer batch',async()=>{
  for(const failure of [{pressError:true},{releaseError:true}]){
    const h=harness(failure);await assert.rejects(h.tick(),/TEST_(PRESS|RELEASE)_UNCERTAIN/);
    assert.equal(h.presses(),1);assert.equal(h.releases(),1);assert.equal(h.saved().latch.halted,true);
    assert.equal(h.saved().latch.pending.pointerOutcome,'uncertain');
    await assert.rejects(h.tick(),/UI_INPUT_PENDING/);assert.equal(h.presses(),1);assert.equal(h.moves(),1);
  }
});

test('pending or halted persisted state rejects restart before reading or moving the page',async()=>{
  for(const partial of [{pending:{plan:{}}},{halted:true},{pendingProof:{scope:{}}}]){
    const h=harness();h.files.set('/mock/host-test-ui-driver-state.json',JSON.stringify({schemaVersion:1,sessionId:h.ctx.control.sessionId,
      actions:1,latch:{...driver.createUiLatch(),...partial},pendingProof:partial.pendingProof??null}));
    await assert.rejects(h.tick(),/UI_RESTART_REQUIRES_RECONCILIATION/);assert.equal(h.events.filter(e=>e.kind==='page-read').length,0);assert.equal(h.moves(),0);
  }
});

test('entry deadlines, invalid action caps and exhausted persisted action counts reject all input',async()=>{
  for(const mutate of [h=>h.ctx.control.deadlineMs=h.clock.now,h=>h.ctx.control.maxActions=101,h=>h.ctx.control.maxActions=0]){
    const h=harness();mutate(h);await assert.rejects(h.tick(),/UI_CONTROL_LIMIT/);assert.equal(h.moves(),0);
  }
  const h=harness();h.files.set('/mock/host-test-ui-driver-state.json',JSON.stringify({schemaVersion:1,sessionId:h.ctx.control.sessionId,
    actions:h.ctx.control.maxActions,latch:driver.createUiLatch(),pendingProof:null}));
  await assert.rejects(h.tick(),/UI_ACTION_LIMIT/);assert.equal(h.moves(),0);
});

test('the last permitted input may complete and reconcile before the action cap stops later inputs',async()=>{
  const h=harness();h.ctx.control.maxActions=1;await h.tick();assert.equal(h.presses(),1);
  h.advance();await h.tick();assert.equal(h.ctx.state.latch.pending,null);assert.equal(h.ctx.state.pendingProof,null);
  await assert.rejects(h.tick(),/UI_ACTION_LIMIT/);assert.equal(h.presses(),1);
});

test('native riichi autoplay and a fresh riichi offer stop private UI selection',async()=>{
  for(const riichi of ['declared','accepted']){
    const h=harness();h.checkpoint.state.players[2].riichi=riichi;
    h.checkpoint.state.operationWindow.candidates=legalOperationActions(h.checkpoint.state,h.r.operation.value,'mock-window','mock-evidence');
    await assert.rejects(h.tick(),/UI_NATIVE_RIICHI_AUTOPLAY/);assert.equal(h.moves(),0);
  }
  const h=harness();h.r.operation.value.operation_list.push({type:7,combination:['2z']});
  await assert.rejects(h.tick(),/UI_RIICHI_REVIEW_REQUIRED/);assert.equal(h.moves(),0);
});

test('pending proof retries only a readback race, stops at eight seconds, and never retries input',async()=>{
  const h=harness({verifyError:n=>n>=2?'AUTO_WIN_READBACK_STALE':null});await h.tick();h.advance();
  await h.tick();assert.equal(h.presses(),1);assert.ok(h.ctx.state.pendingProof);assert.equal(h.ctx.state.pendingProof.verified,false);
  h.clock.now=h.ctx.state.pendingProof.startedAtMs+8001;
  await assert.rejects(h.tick(),/UI_POST_INPUT_PROOF_TIMEOUT/);assert.equal(h.presses(),1);
});

test('scope change during the awaited final checkpoint is detected before pressing',async()=>{
  const h=harness({onCheckpoint:(n,h)=>{if(n===2)h.r.sourceStream++;}});
  await assert.rejects(h.tick());assert.equal(h.presses(),0);
});

test('deadline expiration during planning cannot reserve or move the pointer',async()=>{
  const h=harness({onCheckpoint:(n,h)=>{if(n===1)h.clock.now+=200;}});h.ctx.control.deadlineMs=h.clock.now+100;
  await assert.rejects(h.tick(),/UI_CONTROL_LIMIT/);assert.equal(h.moves(),0);assert.equal(h.presses(),0);
});

test('deadline expiration during durable reservation prevents even the hover input',async()=>{
  const h=harness({onFile:(path,h)=>{if(path.endsWith('-before.png'))h.clock.now+=200;}});h.ctx.control.deadlineMs=h.clock.now+100;
  await assert.rejects(h.tick(),/UI_CONTROL_LIMIT/);assert.equal(h.moves(),0);assert.equal(h.presses(),0);
});

test('deadline expiration during hover prevents pressing despite a still-valid pixel plan',async()=>{
  const h=harness();h.ctx.control.deadlineMs=h.clock.now+100;
  await assert.rejects(h.tick(),/UI_CONTROL_LIMIT/);assert.equal(h.moves(),1);assert.equal(h.presses(),0);
});

test('a control deadline crossed during synchronous final validation still forbids pressing',async()=>{
  const h=harness({afterGuard:h=>h.clock.now+=20});h.ctx.control.deadlineMs=h.clock.now+160;
  await assert.rejects(h.tick(),/UI_CONTROL_LIMIT/);assert.equal(h.presses(),0);
});

test('a pixel plan expiring during synchronous final validation still forbids pressing',async()=>{
  const h=harness({onFile:(path,h)=>{if(path.endsWith('-before.png'))h.clock.now+=590;},afterGuard:h=>h.clock.now+=20});
  await assert.rejects(h.tick(),/UI_PLAN_STALE/);assert.equal(h.presses(),0);
});

test('a post-release status failure retains its original cause and cannot retry the pointer',async()=>{
  const h=harness({failStatusOnce:true});await assert.rejects(h.tick(),/TEST_STATUS_WRITE_FAILED/);
  assert.equal(h.presses(),1);assert.equal(h.releases(),1);assert.ok(h.saved().latch.pending);
});

test('an eligible initial pixel failure preserves its frame without claiming, waits 750ms, then uses only a new verified frame',async()=>{
  const h=harness({pixelError:({code,pixelCalls})=>pixelCalls===1?'UI_TILE_PIXELS_UNVERIFIED_'+code:null});
  await h.tick();assert.equal(h.captures(),1);assert.equal(h.claims(),0);assert.equal(h.moves(),0);assert.equal(h.saved().actions,0);
  const failure=h.audit().find(e=>e.kind==='pixel-frame-failed');
  assert.equal(failure.autoWinVerified,true);assert.equal(failure.cause,'unproven');assert.equal(failure.resample,0);
  assert.deepEqual(failure.scope,driver.pageScope(h.r));
  const png=h.files.get('/mock/host-test-ui/'+failure.frame);
  assert.equal(failure.pngSha256,createHash('sha256').update(png).digest('hex'));
  h.clock.now+=749;await h.tick();assert.equal(h.captures(),1);assert.equal(h.claims(),0);
  h.clock.now++;await h.tick();assert.equal(h.captures(),2);assert.equal(h.claims(),1);assert.equal(h.presses(),1);assert.equal(h.releases(),1);
  assert.equal(h.saved().pixelSampling.windows[0].count,1);assert.equal(h.saved().pixelSampling.activeKey,null);
  const planned=h.audit().find(e=>e.kind==='input-reserved').plan;
  assert.ok(planned.visualProof.observedAtMs>failure.observedAtMs);
  const inspected=h.events.filter(e=>e.kind==='pixel-inspect');assert.equal(inspected[0].code,inspected[1].code);assert.equal(inspected[0].drawn,inspected[1].drawn);
});

test('three extra frames exhaust the durable window budget and throw the original error without any input',async()=>{
  const h=harness({pixelError:({code,pixelCalls})=>pixelCalls===1?'UI_TILE_PIXELS_UNVERIFIED_'+code:'UI_TABLE_ANCHOR_MISMATCH'});
  await h.tick();const original=h.saved().pixelSampling.windows[0].originalCode;
  await h.retry();await h.retry();await assert.rejects(h.retry(),error=>error.message===original);
  assert.equal(h.captures(),4);assert.equal(h.claims(),0);assert.equal(h.moves(),0);assert.equal(h.presses(),0);assert.equal(h.releases(),0);
  const failed=h.audit().filter(e=>e.kind==='pixel-frame-failed');assert.equal(failed.length,4);
  assert.equal(new Set(failed.map(e=>e.frame)).size,4);assert.ok(failed.every(e=>e.autoWinVerified));
  const frames=h.events.filter(e=>e.kind==='capture');assert.ok(frames.slice(1).every((e,i)=>e.at-frames[i].at>=750));
  assert.equal(h.saved().pixelSampling.windows[0].phase,'closed');assert.equal(h.saved().pixelSampling.windows[0].count,3);
  h.restart();await assert.rejects(h.tick(),error=>error.message===original);assert.equal(h.captures(),4);assert.equal(h.claims(),0);
});

test('waiting pixel resampling stops on scope, win, terminal, connection or input-state changes before another frame',async()=>{
  for(const mutate of [h=>h.r.pageEpoch++,h=>h.r.sourceStream++,h=>h.r.generation++,h=>h.r.controlEpoch++,h=>h.r.nativeRestoreRevision++,
    h=>h.r.lastStep++,h=>h.r.ownSeat=1,h=>h.r.gameUuid='different-game',h=>h.r.handSha256='d'.repeat(64),h=>h.r.queued=1,
    h=>h.r.operation.value.operation_list.push({type:8}),h=>h.r.operation.value.operation_list.push({type:9}),
    h=>h.r.lastClientWin={pageEpoch:h.r.pageEpoch,sourceStream:h.r.sourceStream},h=>h.r.handEnded=true,h=>h.r.matchEnded=true,
    h=>h.r.connected=false,h=>h.r.reason='DISCONNECTED',h=>h.r.paused=false,h=>h.r.phase2ActionsEnabled=true,
    h=>h.ctx.state.pendingProof={verified:false},h=>h.ctx.state.latch.pending={pointerOutcome:'reserved'},
    h=>h.ctx.state.latch.halted=true,h=>h.ctx.state.actions++]){
    const h=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code});await h.tick();mutate(h);
    await assert.rejects(h.retry());assert.equal(h.captures(),1);assert.equal(h.claims(),0);assert.equal(h.moves(),0);
    assert.equal(h.saved().pixelSampling.windows[0].phase,'closed');
  }
});

test('a new checkpoint or scope change during durable retry reservation stops before screenshot acquisition',async()=>{
  const cp=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code});await cp.tick();cp.checkpoint.sequence++;
  await assert.rejects(cp.retry(),/UI_PIXEL_RETRY_SCOPE_CHANGED/);assert.equal(cp.captures(),1);assert.equal(cp.claims(),0);
  let changed=false;
  const h=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code,onSync:(path,h)=>{
    if(path.endsWith('-ui-driver-state.json')&&!changed&&h.ctx.state.pixelSampling?.windows[0]?.count===1){changed=true;h.r.sourceStream++;}
  }});
  await h.tick();await assert.rejects(h.retry(),/UI_PIXEL_RETRY_SCOPE_CHANGED/);
  assert.equal(h.saved().pixelSampling.windows[0].count,1);assert.equal(h.captures(),1);assert.equal(h.claims(),0);
});

test('failed verify never qualifies for pixel resampling and a later verification failure closes the budget immediately',async()=>{
  const first=harness({verifyError:()=> 'AUTO_WIN_UNVERIFIED'});
  await assert.rejects(first.tick(),/AUTO_WIN_UNVERIFIED/);assert.equal(first.captures(),1);assert.equal(first.claims(),0);
  assert.equal(first.ctx.state.pixelSampling.windows.length,0);assert.equal(first.events.filter(e=>e.kind==='pixel-inspect').length,0);
  const retry=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code,verifyError:n=>n===2?'AUTO_WIN_READBACK_STALE':null});
  await retry.tick();await assert.rejects(retry.retry(),/AUTO_WIN_READBACK_STALE/);
  assert.equal(retry.captures(),2);assert.equal(retry.claims(),0);assert.equal(retry.events.filter(e=>e.kind==='pixel-inspect').length,1);
  const failures=retry.audit().filter(e=>e.kind==='pixel-frame-failed');assert.equal(failures.length,2);
  assert.equal(failures[1].autoWinVerified,false);assert.ok(failures[1].frame);assert.equal(retry.saved().pixelSampling.windows[0].phase,'closed');
});

test('missing templates, unrelated pixel errors and a different legal-code error stop immediately',async()=>{
  for(const code of [c=>'UI_TILE_TEMPLATE_UNAVAILABLE_'+c,()=> 'UI_TILE_SOURCE_HASH_MISMATCH',()=> 'UI_SKIP_PIXELS_UNVERIFIED',
    c=>'UI_TILE_PIXELS_UNVERIFIED_'+(c==='1m'?'2m':'1m')]){
    const h=harness({pixelError:({code:tile})=>code(tile)});await assert.rejects(h.tick());
    assert.equal(h.captures(),1);assert.equal(h.claims(),0);assert.equal(h.moves(),0);assert.equal(h.ctx.state.pixelSampling.windows.length,0);
    assert.equal(h.audit().filter(e=>e.kind==='pixel-frame-failed').length,1);
  }
  const preload=harness({templateError:'UI_TILE_SOURCE_UNAVAILABLE'});
  await assert.rejects(preload.tick(),/UI_TILE_SOURCE_UNAVAILABLE/);assert.equal(preload.captures(),0);assert.equal(preload.claims(),0);
});

test('original sampling deadline survives restart and cannot be extended by later control',async()=>{
  const h=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code});h.ctx.control.deadlineMs=h.clock.now+600;
  await h.tick();const original=h.saved().pixelSampling.windows[0].deadlineMs;
  h.restart();h.ctx.control.deadlineMs+=60_000;h.clock.now=original;
  await assert.rejects(h.tick(),/UI_CONTROL_LIMIT/);assert.equal(h.captures(),1);assert.equal(h.claims(),0);
  assert.equal(h.saved().pixelSampling.windows[0].deadlineMs,original);
  const shorter=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code});await shorter.tick();shorter.ctx.control.deadlineMs=shorter.clock.now+500;
  await assert.rejects(shorter.retry(),/UI_CONTROL_LIMIT/);assert.equal(shorter.captures(),1);assert.equal(shorter.claims(),0);
});

test('a successful resample still obeys the original frame TTL and the pinned deadline before claim',async()=>{
  for(const expiry of ['frame','deadline']){
    const h=harness({pixelError:({code,pixelCalls})=>pixelCalls===1?'UI_TILE_PIXELS_UNVERIFIED_'+code:null,onSync:(path,h)=>{
      if(path.endsWith('-ui-driver-state.json')&&h.ctx.state.pixelSampling?.windows[0]?.phase==='verified')h.clock.now+=expiry==='frame'?1001:500;
    }});
    if(expiry==='deadline')h.ctx.control.deadlineMs=h.clock.now+1000;
    await h.tick();if(expiry==='deadline')h.ctx.control.deadlineMs+=60_000;
    await assert.rejects(h.retry(),expiry==='frame'?/UI_VISUAL_PROOF_REQUIRED/:/UI_CONTROL_LIMIT/);
    assert.equal(h.captures(),2);assert.equal(h.claims(),0);assert.equal(h.moves(),0);assert.equal(h.presses(),0);
  }
});

test('retry count and interval persist across restarts; an interrupted reserved frame cannot be retried',async()=>{
  const h=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code});await h.tick();await h.retry();
  assert.equal(h.saved().pixelSampling.windows[0].count,1);h.restart();h.clock.now+=749;await h.tick();assert.equal(h.captures(),2);
  h.clock.now++;await h.tick();assert.equal(h.captures(),3);assert.equal(h.saved().pixelSampling.windows[0].count,2);
  h.restart();await assert.rejects(h.retry(),/UI_TILE_PIXELS_UNVERIFIED_/);assert.equal(h.captures(),4);assert.equal(h.saved().pixelSampling.windows[0].count,3);
  let injected=false;
  const interrupted=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code,onSync:(path,h)=>{
    if(path.endsWith('-ui-driver-state.json')&&!injected&&h.ctx.state.pixelSampling?.windows[0]?.count===1){injected=true;throw Error('TEST_FSYNC_INTERRUPTED');}
  }});
  await interrupted.tick();await assert.rejects(interrupted.retry(),/TEST_FSYNC_INTERRUPTED/);assert.equal(interrupted.captures(),1);
  interrupted.restart();await assert.rejects(interrupted.tick(),/UI_PIXEL_RETRY_INTERRUPTED/);
  assert.equal(interrupted.captures(),1);assert.equal(interrupted.claims(),0);assert.equal(interrupted.saved().pixelSampling.windows[0].count,1);
});

test('malformed persisted retry accounting is rejected instead of resetting the allowance',async()=>{
  for(const mutate of [s=>s.windows[0].count=4,s=>s.activeKey=null,s=>s.windows.push(structuredClone(s.windows[0])),
    s=>s.windows[0].scope.sourceStream=-1,s=>s.windows[0].originalCode='UI_TILE_TEMPLATE_UNAVAILABLE_1m']){
    const h=harness({pixelError:({code})=>'UI_TILE_PIXELS_UNVERIFIED_'+code});await h.tick();
    const saved=h.saved();mutate(saved.pixelSampling);h.files.set('/mock/host-test-ui-driver-state.json',JSON.stringify(saved));h.restart();
    await assert.rejects(h.tick(),/UI_PIXEL_RETRY_STATE_INVALID/);assert.equal(h.captures(),1);assert.equal(h.claims(),0);
  }
});

test('skip and table-anchor failures only resample the same legal skip window, preserving original click count',async()=>{
  for(const error of ['UI_SKIP_PIXELS_UNVERIFIED','UI_TABLE_ANCHOR_MISMATCH']){
    const h=harness({pixelError:({pixelCalls})=>pixelCalls===1?error:null}),s=h.checkpoint.state;
    s.ownConcealed.pop();s.players[2].concealedCount.value=13;s.drawnTileRef={known:true,value:null};s.currentActor={known:false,reason:'awaiting-call'};
    s.players[1].river.push({tile:'1p',tsumogiri:true,riichiDeclaration:false,eventId:'offer-discard'});
    s.latestAction={eventId:'offer-discard',handId:s.handId,actor:1,kind:'discard',tiles:['1p'],tsumogiri:{known:true,value:true},origin:'unknown',observedAt:new Date(h.clock.now).toISOString()};
    h.r.operation.value.operation_list=[{type:3,combination:['1p|1p']}];
    s.operationWindow.candidates=legalOperationActions(s,h.r.operation.value,'mock-window','mock-evidence');
    await h.tick();assert.equal(h.claims(),0);assert.equal(h.moves(),0);await h.retry();
    assert.equal(h.captures(),2);assert.equal(h.claims(),1);assert.equal(h.presses(),1);assert.equal(h.releases(),1);
    const plan=h.audit().find(e=>e.kind==='input-reserved').plan;assert.equal(plan.kind,'skip');assert.deepEqual(plan.point,{x:1302,y:700});
  }
});
