import files from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {verifyAutoWin as verifyAutoWinPixels} from '../../src/adapters/majsoul/auto-win.ts';
import * as driver from './ui-validation-driver.mjs';

const runningRuns=new Set();
const runningPages=new WeakSet();

// The caller supplies the page and diagnostic pixel reader. Importing the host
// never opens a browser, starts observation or selects a ledger.
export function createUiDriverHost({
  pixels, fs=files, Date=globalThis.Date, verifyAutoWin=verifyAutoWinPixels, readers=driver,
}) {
  const {inspectTileBinding,verifySkipPixels,templates}=pixels;
  const {readUiCheckpoint,readUiProgress,chooseUiAction,pageScope,planUiAction,assertUiPlanCurrent,
    createUiLatch,claimUiWindow,noteUiPointerOutcome,readUiDiscardAuthority,reconcileUiWindow}={...driver,...readers};

  const sameHand=(a,b)=>a.pageEpoch===b.pageEpoch&&a.sourceStream===b.sourceStream&&
    a.nativeRestoreRevision===b.nativeRestoreRevision&&a.controlEpoch===b.controlEpoch;
  const win=r=>r.operation?.value?.operation_list?.some(o=>o.type===8||o.type===9)||
   [r.lastClientWin,r.lastOwnWin].some(w=>w&&w.pageEpoch===r.pageEpoch&&w.sourceStream===r.sourceStream);
  const read=page=>page.evaluate(()=>window.__majiBridge.read());
  const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const PIXEL_RESAMPLES=3,PIXEL_INTERVAL_MS=750;
  async function durable(path,value,append=false){const h=await fs.open(path,append?'a':'w',0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}}
  async function audit(ctx,value){await durable(ctx.root+'/'+ctx.label+'-ui-driver-audit.jsonl',{at:new Date().toISOString(),...value},true);}
  async function persist(ctx){await durable(ctx.root+'/'+ctx.label+'-ui-driver-state.json',{schemaVersion:1,sessionId:ctx.control.sessionId,latch:ctx.state.latch,actions:ctx.state.actions,pendingProof:ctx.state.pendingProof??null,pixelSampling:ctx.state.pixelSampling});}
  async function status(ctx,code,extra={}){if(ctx.state.status!==code){ctx.state.status=code;await audit(ctx,{kind:'status',code,...extra});}await fs.writeFile(ctx.root+'/'+ctx.label+'-ui-driver-status.json',JSON.stringify({at:new Date().toISOString(),code,actions:ctx.state.actions,...extra}));}

  function retryablePixelError(code,choice){return code==='UI_TABLE_ANCHOR_MISMATCH'||
   (choice?.kind==='discard'?code==='UI_TILE_PIXELS_UNVERIFIED_'+choice.tileCode:choice?.kind==='skip'&&code==='UI_SKIP_PIXELS_UNVERIFIED');}
  function samplingState(value){
   const state=value??{schemaVersion:1,activeKey:null,windows:[]},integer=n=>Number.isSafeInteger(n)&&n>=0,sha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
   if(state.schemaVersion!==1||!Array.isArray(state.windows)||state.windows.length>2048||
     new Set(state.windows.map(e=>e.key)).size!==state.windows.length)throw Error('UI_PIXEL_RETRY_STATE_INVALID');
   for(const e of state.windows){
     if(!sha(e.key)||!sha(e.signature)||!sha(e.operationHash)||!sha(e.identityHash)||!integer(e.actions)||
       !integer(e.count)||e.count>PIXEL_RESAMPLES||!integer(e.deadlineMs)||!integer(e.nextAtMs)||
       !Number.isSafeInteger(e.ownSeat)||e.ownSeat<0||e.ownSeat>3||
       !['waiting','sampling','verified','closed'].includes(e.phase)||!retryablePixelError(e.originalCode,e.choice)||
       !['discard','skip'].includes(e.choice?.kind)||e.choice.kind==='discard'&&!/^(?:[1-9][mps]|[1-7]z|5[mps]r)$/.test(e.choice.tileCode)||
       !e.scope||Object.entries(e.scope).length!==6||!['pageEpoch','sourceStream','generation','step','controlEpoch','nativeRestoreRevision'].every(k=>integer(e.scope[k]))||e.scope.pageEpoch<1)
       throw Error('UI_PIXEL_RETRY_STATE_INVALID');
   }
   const active=state.windows.filter(e=>e.phase==='waiting'||e.phase==='sampling');
   if(active.length>1||state.activeKey!==(active[0]?.key??null)||active[0]?.phase==='waiting'&&active[0].count>=PIXEL_RESAMPLES)
     throw Error('UI_PIXEL_RETRY_STATE_INVALID');
   return state;
  }
  function assertPixelWindow(ctx,r,entry){
   if(Date.now()>=Math.min(ctx.control.deadlineMs,entry.deadlineMs))throw Error('UI_CONTROL_LIMIT');
   if(ctx.state.pendingProof||ctx.state.latch.pending||ctx.state.latch.halted||ctx.state.actions!==entry.actions)throw Error('UI_INPUT_PENDING');
   if(win(r))throw Error('CLIENT_AUTO_WIN_WINDOW');
   if(r.handEnded||r.matchEnded)throw Error('UI_HAND_ENDED');
   if(r.paused!==true||r.phase2ActionsEnabled!==false||!r.connected||!r.freshConnection||r.reason||r.overflow)throw Error('UI_OBSERVER_NOT_READY');
   if(r.queued!==0||!equal(pageScope(r),entry.scope)||r.ownSeat!==entry.ownSeat||hash(r.operation)!==entry.operationHash||
     hash([r.gameUuid,r.handSha256])!==entry.identityHash)throw Error('UI_PIXEL_RETRY_SCOPE_CHANGED');
  }
  async function closeSampling(ctx,entry,error,scope=entry.scope){
   entry.phase='closed';entry.stopCode=error.message;ctx.state.pixelSampling.activeKey=null;
   await persist(ctx);await audit(ctx,{kind:'pixel-resample-stopped',windowKey:entry.key,count:entry.count,code:error.message,scope});
  }
  async function retainFrame(ctx,name,capture){
    if(!capture.frame)return {frame:null,pngSha256:null};
    const directory=ctx.root+'/'+ctx.label+'-ui';
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    await fs.writeFile(directory+'/'+name,capture.frame,{flag:'wx',mode:0o600,flush:true});
    return {frame:name,pngSha256:hash(capture.frame)};
  }
  async function retainPixelFailure(ctx,entry,capture,error,{autoWinVerified,scope}){
    const evidence=capture.failedFrame??await retainFrame(ctx,entry.key+'-pixels-'+entry.count+'-failed.png',capture);
    await audit(ctx,{kind:'pixel-frame-failed',windowKey:entry.key,resample:entry.count,code:error.message,scope,
      autoWinVerified,...evidence,observedAtMs:capture.observedAtMs??null,cause:'unproven'});
  }

  // A real screenshot and the existing production ACK are retained. This extra
  // private guard prevents a late verifier from ACKing a newly offered win.
  async function verify(ctx,scope,context,capture,{deadlineMs,assertCurrent,validate}){
    const page=ctx.port??ctx.page;
    const readbackId=randomUUID();
    const details={...context,scope,readbackId};
    const port={
      async evaluate(source,arg){
        if(arg?.method!=='ackAutoWin')return page.evaluate(source,arg);
        capture.readback=arg.argument;
        assertCurrent();
        const result=await page.evaluate(({argument,expected,deadlineMs})=>{
          const r=window.__majiBridge.read();
          if(r.paused!==true||r.phase2ActionsEnabled!==false||!r.connected||!r.freshConnection||r.reason||r.overflow||
            r.pageEpoch!==expected.pageEpoch||r.sourceStream!==expected.sourceStream||r.nativeRestoreRevision!==expected.nativeRestoreRevision||
            r.controlEpoch!==expected.controlEpoch||r.handEnded||r.matchEnded||r.operation?.value?.operation_list?.some(o=>o.type===8||o.type===9)||
            [r.lastClientWin,r.lastOwnWin].some(w=>w&&w.pageEpoch===r.pageEpoch&&w.sourceStream===r.sourceStream))
            return {...r,readbackFailure:'UI_READBACK_SCOPE_CHANGED'};
          if(Date.now()>=deadlineMs)return {...r,readbackFailure:'UI_READBACK_DEADLINE'};
          return {ack:window.__majiBridge.ackAutoWin(argument)};
        },{argument:arg.argument,expected:scope,deadlineMs});
        if(result.readbackFailure)throw Error(result.readbackFailure);
        capture.ack=result.ack;
        return capture.ack;
      },
      async cdp(method,args){
        if(method!=='Page.captureScreenshot')throw Error('UI_READBACK_METHOD_INVALID');
        capture.observedAtMs=Date.now();
        const result=await page.cdp(method,args);
        if(typeof result?.data==='string'&&result.data.length<=12*1024*1024)capture.frame=Buffer.from(result.data,'base64');
        return result;
      },
    };
    await audit(ctx,{kind:'readback-started',...details});
    let proof,result;
    try{
      assertCurrent();
      proof=await verifyAutoWin(port);
      result=await validate(proof);
    }catch(error){
      capture.failedFrame=await retainFrame(ctx,'readback-'+readbackId+'-failed.png',capture);
      await audit(ctx,{kind:'readback-failed',...details,code:error.message,proof:proof??null,
        readback:capture.readback??null,ack:capture.ack??null,observedAtMs:capture.observedAtMs??null,...capture.failedFrame});
      throw error;
    }
    await audit(ctx,{kind:'readback-verified',...details,proof,observedAtMs:capture.observedAtMs??null,
      pngSha256:capture.frame?hash(capture.frame):null});
    return {proof,frame:capture.frame,observedAtMs:capture.observedAtMs,result};
  }

  // One fresh frame per tick. Only the three extra frames after an eligible
  // verified-but-unbound frame are retried; no input reservation exists here.
  async function selectedPixels(ctx,checkpoint,r,choice,assertControl,restrictDeadline){
   const state=ctx.state,scope=pageScope(r),key=hash([checkpoint.gameMatchKey,checkpoint.gameHandKey,checkpoint.sourceCursor]);
   const basis={key,scope,ownSeat:r.ownSeat,actions:state.actions,operationHash:hash(r.operation),identityHash:hash([r.gameUuid,r.handSha256]),
     signature:hash([scope,checkpoint,choice]),choice:{kind:choice.kind,...(choice.kind==='discard'?{tileCode:choice.tileCode}:{})}};
   let entry=state.pixelSampling.windows.find(e=>e.key===key);
   if(entry){
     restrictDeadline(entry.deadlineMs);assertControl();
     if(entry.phase==='closed')throw Error(entry.stopCode??entry.originalCode);
     if(entry.phase==='verified')throw Error('UI_PIXEL_RETRY_COMPLETED');
     if(entry.phase==='sampling')throw Error('UI_PIXEL_RETRY_INTERRUPTED');
     try{assertPixelWindow(ctx,r,entry);if(entry.signature!==basis.signature)throw Error('UI_PIXEL_RETRY_SCOPE_CHANGED');}
     catch(error){await closeSampling(ctx,entry,error,scope);throw error;}
     if(Date.now()<entry.nextAtMs)return null;
     if(entry.count>=PIXEL_RESAMPLES)throw Error(entry.originalCode);
     // Count before acquisition; process interruption cannot create a free retry.
     entry.count++;entry.phase='sampling';await persist(ctx);
     await audit(ctx,{kind:'pixel-resample-reserved',windowKey:key,count:entry.count,scope});
     try{assertControl();assertPixelWindow(ctx,await read(ctx.port??ctx.page),entry);}
     catch(error){await closeSampling(ctx,entry,error);throw error;}
   }
   const captured={};let v,fresh;
   try{
     const deadlineMs=Math.min(entry?.deadlineMs??Infinity,ctx.control.deadlineMs);
     v=await verify(ctx,scope,{stage:'before-input',windowKey:key,resample:entry?.count??0},captured,{
       deadlineMs,assertCurrent:assertControl,
       async validate(proof){
         const current=await read(ctx.port??ctx.page);
         if(!equal(pageScope(current),scope))throw Error('UI_PIXEL_RETRY_SCOPE_CHANGED');
         if(proof?.state!=='enabled'||!captured.frame)throw Error('AUTO_WIN_UNVERIFIED');
         assertControl();assertPixelWindow(ctx,current,{...basis,deadlineMs});
         return current;
       },
     });
     fresh=v.result;
   }catch(error){
     if(entry){await retainPixelFailure(ctx,entry,captured,error,{autoWinVerified:false,scope});await closeSampling(ctx,entry,error);}
     if(!entry&&error.message==='UI_PIXEL_RETRY_SCOPE_CHANGED')return null;
     throw error;
   }
   let binding;
   try{binding=choice.kind==='discard'?await inspectTileBinding(v.frame,choice.tileCode,{drawn:choice.action.tsumogiri}):await verifySkipPixels(v.frame);}
   catch(error){
     const allowed=retryablePixelError(error.message,choice);
     if(!entry&&allowed){
       if(state.pixelSampling.windows.length>=2048)throw Error('UI_PIXEL_RETRY_HISTORY_FULL');
       entry={...basis,deadlineMs:ctx.control.deadlineMs,originalCode:error.message,count:0,nextAtMs:0,phase:'sampling'};
       state.pixelSampling.windows.push(entry);state.pixelSampling.activeKey=key;await persist(ctx);
     }
     // Missing templates and all other failures are archived then thrown directly.
     await retainPixelFailure(ctx,entry??{...basis,count:0},v,error,{autoWinVerified:true,scope});
     if(!allowed){if(entry)await closeSampling(ctx,entry,error);throw error;}
     try{assertControl();assertPixelWindow(ctx,await read(ctx.port??ctx.page),entry);}
     catch(boundary){await closeSampling(ctx,entry,boundary);throw boundary;}
     if(entry.count>=PIXEL_RESAMPLES){const exhausted=Error(entry.originalCode);await closeSampling(ctx,entry,exhausted);throw exhausted;}
     entry.phase='waiting';entry.nextAtMs=Date.now()+PIXEL_INTERVAL_MS;await persist(ctx);return null;
   }
   if(entry){
     entry.phase='verified';state.pixelSampling.activeKey=null;await persist(ctx);
     await audit(ctx,{kind:'pixel-resample-verified',windowKey:key,count:entry.count,scope,pngSha256:hash(v.frame),observedAtMs:v.observedAtMs});
   }
   return {v,fresh,binding};
  }

  async function tick(ctx){
   const {page,control,state,root,label,databasePath}=ctx;
   if(!isAbsolute(root)||!isAbsolute(databasePath)||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(label))throw Error('UI_RUN_PATH_REQUIRED');
   const observation=ctx.port??page;
   let deadlineMs=control.deadlineMs;
   const restrictDeadline=value=>{deadlineMs=Math.min(deadlineMs,value);};
   const assertControl=()=>{if(control.enabled!==true||Date.now()>=Math.min(control.deadlineMs,deadlineMs))throw Error('UI_CONTROL_LIMIT');};
   if(control.enabled!==true||!/^live-[a-z0-9-]+$/.test(control.sessionId??'')||!Number.isSafeInteger(control.deadlineMs)||Date.now()>=control.deadlineMs||
     !Number.isSafeInteger(control.maxActions)||control.maxActions<1||control.maxActions>100)throw Error('UI_CONTROL_LIMIT');
   if(!state.initialized){
     const previous=await fs.readFile(root+'/'+label+'-ui-driver-state.json','utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
     if(previous&&(previous.sessionId!==control.sessionId||previous.latch?.pending||previous.latch?.halted||previous.pendingProof))throw Error('UI_RESTART_REQUIRES_RECONCILIATION');
     await templates();
     state.pixelSampling=samplingState(previous?.pixelSampling);
     state.latch=previous?.latch??createUiLatch();state.actions=previous?.actions??0;state.sessionId=control.sessionId;state.initialized=true;
   }
   if(state.sessionId!==control.sessionId)throw Error('UI_SESSION_CHANGED');
   const r=await read(observation);
   const active=state.pixelSampling.windows.find(e=>e.key===state.pixelSampling.activeKey);
   if(active){
     restrictDeadline(active.deadlineMs);
     try{if(active.phase==='sampling')throw Error('UI_PIXEL_RETRY_INTERRUPTED');assertPixelWindow(ctx,r,active);}
     catch(error){await closeSampling(ctx,active,error,pageScope(r));throw error;}
     if(Date.now()<active.nextAtMs)return;
   }
   if(win(r)){await status(ctx,'CLIENT_AUTO_WIN_WINDOW',{scope:pageScope(r)});throw Error('CLIENT_AUTO_WIN_WINDOW');}
   if(r.paused!==true||r.phase2ActionsEnabled!==false||!r.connected||!r.freshConnection||r.reason||r.overflow)throw Error('UI_OBSERVER_NOT_READY');
   if(r.handEnded||r.matchEnded){await status(ctx,'UI_HAND_ENDED',{scope:pageScope(r)});throw Error('UI_HAND_ENDED');}
   // This block precedes own-offer/checkpoint filtering. It can verify between
   // our discard and the next opponent discard, which is essential to win proof.
   if(state.pendingProof){
     const pending=state.pendingProof;
     if(!sameHand(r,pending.scope))throw Error('UI_POST_INPUT_SCOPE_CHANGED');
     const proofDeadline=pending.startedAtMs+8000;
     const assertProofCurrent=()=>{
       assertControl();
       if(Date.now()>=proofDeadline)throw Error('UI_POST_INPUT_PROOF_TIMEOUT');
     };
     assertProofCurrent();
     if(!pending.verified){
       try{
         const v=await verify(ctx,pending.scope,{stage:'after-input',input:state.actions},{},{
           deadlineMs:Math.min(proofDeadline,deadlineMs),assertCurrent:assertProofCurrent,
           async validate(proof){
             const after=await read(observation);
             if(!sameHand(after,pending.scope)||win(after))throw Error('UI_READBACK_SCOPE_CHANGED');
             const retained=after.lastAutoWinReadback;
             if(retained?.state!=='enabled'||retained.observedAt!==proof.observedAt||retained.rgbaSha256!==proof.rgbaSha256)throw Error('AUTO_WIN_READBACK_STALE');
             return after;
           },
         });
         pending.verified=true;await audit(ctx,{kind:'post-input-readback',input:state.actions,proof:v.proof,scope:pageScope(v.result)});await persist(ctx);
       }catch(error){
         if(error.message==='AUTO_WIN_READBACK_STALE')return;throw error;
       }
     }
     if(state.latch.pending){
       const progress=await readUiProgress({databasePath,sessionId:control.sessionId}),current=await read(observation),plan=state.latch.pending.plan;
       const authority=plan.kind==='discard'?await readUiDiscardAuthority({databasePath,plan}):null;
       const result=reconcileUiWindow(state.latch,{checkpoint:progress,pageState:current,authority});
       state.latch=result.latch;
       if(result.status==='awaiting-authority')return;
       await audit(ctx,{kind:'input-reconciled',input:state.actions,status:result.status,authority});
       if(state.latch.halted){await persist(ctx);throw Error('UI_AUTHORITY_RECONCILIATION_FAILED');}
     }
     state.pendingProof=null;await persist(ctx);await status(ctx,'UI_INPUT_RECONCILED');return;
   }
   if(state.latch.halted||state.latch.pending)throw Error('UI_INPUT_PENDING');
   if(state.actions>=control.maxActions)throw Error('UI_ACTION_LIMIT');
   if(r.queued)return;
   const scope=pageScope(r);
   if(!state.initialScope||!sameHand(state.initialScope,scope)){
     const proof=r.lastAutoWinReadback;
     if(proof?.state!=='enabled'||proof.pageEpoch!==r.pageEpoch||proof.sourceStream!==r.sourceStream||proof.nativeRestoreRevision!==r.nativeRestoreRevision){await status(ctx,'WAIT_OBSERVER_AUTO_WIN_RECOVERY');return;}
     state.initialScope=scope;await audit(ctx,{kind:'observer-proof-bootstrap',proof});
   }
   if(r.operation?.step!==r.lastStep||r.operation.value?.seat!==r.ownSeat)return;
   if(r.operation.value.operation_list.some(o=>o.type===7))throw Error('UI_RIICHI_REVIEW_REQUIRED');
   let checkpoint;
   try{checkpoint=await readUiCheckpoint({databasePath,sessionId:control.sessionId,pageState:r});}
   catch(error){if(['UI_CHECKPOINT_STALE','UI_LEGAL_WINDOW_REQUIRED','UI_OWN_OFFER_REQUIRED'].includes(error.message))return;throw error;}
   if(checkpoint.state.players[checkpoint.state.ownSeat].riichi!=='none')throw Error('UI_NATIVE_RIICHI_AUTOPLAY');
   const choice=chooseUiAction(checkpoint,r);if(choice.kind==='wait'){await status(ctx,choice.code);return;}
   const pixels=await selectedPixels(ctx,checkpoint,r,choice,assertControl,restrictDeadline);if(!pixels)return;
   const {v,fresh,binding}=pixels;
   const visual={kind:choice.kind==='discard'?'verified-selected-tile':'verified-skip-button',label:choice.kind==='skip'?'skip':undefined,
     clientVersion:'4.0.51',width:2036,height:918,devicePixelRatio:1,layoutVerified:true,rgbaSha256:binding.pngSha256,
     observedAtMs:v.observedAtMs,scope:pageScope(fresh),selectedBinding:binding};
   const plan=planUiAction({checkpoint,pageState:fresh,choice,visual});
   const current=await read(observation);assertControl();
   state.latch=claimUiWindow(state.latch,plan,{checkpoint,pageState:current});
   state.actions++;await persist(ctx);await audit(ctx,{kind:'input-reserved',input:state.actions,plan});
   let pressed=false,released=false,pressAt=null,releaseAt=null;
   try{
     const evidence=await retainFrame(ctx,state.actions+'-before.png',v);
     await audit(ctx,{kind:'input-frame-retained',input:state.actions,...evidence});
     assertControl();
     await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...plan.point});await page.waitForTimeout(150);
     const beforeDb=await read(observation),cp=await readUiCheckpoint({databasePath,sessionId:control.sessionId,pageState:beforeDb});
     const before=await read(observation);assertControl();
     assertUiPlanCurrent(plan,{checkpoint:cp,pageState:before});
     assertControl();if(Date.now()>=plan.expiresAtMs)throw Error('UI_PLAN_STALE');
     pressed=true;pressAt=new Date().toISOString();
     try{await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',...plan.point,button:'left',clickCount:1});await page.waitForTimeout(100);}
     finally{await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...plan.point,button:'left',clickCount:1});released=true;releaseAt=new Date().toISOString();}
     state.latch=noteUiPointerOutcome(state.latch,'released');state.pendingProof={scope:plan.scope,startedAtMs:Date.now(),verified:false};
     await audit(ctx,{kind:'pointer-released',input:state.actions,pressAt,releaseAt,scope:plan.scope});await persist(ctx);await status(ctx,'WAIT_POST_INPUT_PROOF');
   }catch(error){
     if(state.latch.pending?.pointerOutcome==='reserved')state.latch=noteUiPointerOutcome(state.latch,pressed?'uncertain':'not-started');
     else state.latch.halted=true;
     await persist(ctx);await audit(ctx,{kind:'pointer-failed',input:state.actions,code:error.message,pressed,released,pressAt,releaseAt});throw error;
   }
  }

  return {
    async tick(ctx) {
      const {page}=ctx;
      if(typeof ctx.root!=='string'||!page||typeof page!=='object')throw Error('UI_RUN_PATH_REQUIRED');
      const key=JSON.stringify([resolve(ctx.root),ctx.label]);
      if(runningRuns.has(key)||runningPages.has(page))throw Error('UI_TICK_IN_PROGRESS');
      runningRuns.add(key);runningPages.add(page);
      try{await tick(ctx);}
      finally{runningRuns.delete(key);runningPages.delete(page);}
    },
  };
}
