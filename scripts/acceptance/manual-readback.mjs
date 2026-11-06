// Private read-only evidence collection after an explicitly selected UI input.
// This does not enable a switch, retry an input, send a game RPC, or repair an
// offer's already-frozen prior proof. All page observations use the caller's
// diagnostic port; the production screenshot verifier and ACK remain intact.
import {createHash} from 'node:crypto';
import {classifyAutoWinPixels,decodeScreenshotPng,DEFAULT_AUTO_WIN_PROFILE,verifyAutoWin} from '../../src/adapters/majsoul/auto-win.ts';

const BUDGET_MS=8000,RETRY_MS=200;
const codes=new Set(['AUTO_WIN_READBACK_STALE','AUTO_WIN_UNVERIFIED','AUTO_WIN_CDP_UNAVAILABLE',
  'AUTO_WIN_PROFILE_UNVERIFIED','AUTO_WIN_VIEWPORT_MISMATCH','CLIENT_VERSION_MISMATCH',
  'AUTO_WIN_SCREENSHOT_INVALID','AUTO_WIN_SCREENSHOT_FORMAT','AUTO_WIN_SCREENSHOT_LIMIT',
  'AUTO_WIN_READBACK_INVALID','BRIDGE_UNTRUSTED','BRIDGE_MISSING',
  'MANUAL_READBACK_SCOPE_CHANGED','MANUAL_READBACK_HAND_ENDED','CLIENT_AUTO_WIN_WINDOW',
  'MANUAL_READBACK_OBSERVER_UNTRUSTED','MANUAL_READBACK_TIMEOUT','MANUAL_READBACK_FAILED']);
const codeOf=error=>codes.has(error?.message)?error.message:'MANUAL_READBACK_FAILED';
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
const readbackKeys=['source','state','observedAt','pageEpoch','generation','step','nativeRestoreRevision','rgbaSha256','profileVersion'];
const ackKeys=['state','pageEpoch','generation','nativeRestoreRevision','expiresInMs'];

// Both the last read and original ACK occur in this single synchronous Page
// evaluation. Returning diagnostics on refusal lets the existing port retain a
// win request even when it arrived immediately before this final guard.
function guardedPage({scope,deadlineMs,kind,readback}) {
  const bridge=window.__majiBridge;
  if(!bridge)return {manualReadback:{code:'BRIDGE_MISSING'}};
  const r=bridge.read();
  let code=null;
  if(r.pageEpoch!==scope.pageEpoch||r.sourceStream!==scope.sourceStream||
    r.nativeRestoreRevision!==scope.nativeRestoreRevision||r.controlEpoch!==scope.controlEpoch)
    code='MANUAL_READBACK_SCOPE_CHANGED';
  else if(r.operation?.value?.operation_list?.some(o=>o.type===8||o.type===9)||
    [r.lastClientWin,r.lastOwnWin].some(w=>w&&w.pageEpoch===r.pageEpoch&&w.sourceStream===r.sourceStream))
    code='CLIENT_AUTO_WIN_WINDOW';
  else if(r.handEnded||r.matchEnded)code='MANUAL_READBACK_HAND_ENDED';
  else if(r.paused!==true||r.phase2ActionsEnabled!==false||r.connected!==true||r.freshConnection!==true||r.reason||r.overflow)
    code='MANUAL_READBACK_OBSERVER_UNTRUSTED';
  else if(Date.now()>=deadlineMs)code='MANUAL_READBACK_TIMEOUT';
  if(code||kind==='read')return {...r,manualReadback:{code}};
  if(kind!=='ack')return {...r,manualReadback:{code:'MANUAL_READBACK_FAILED'}};
  try {return {...r,manualReadback:{code:null,ack:bridge.ackAutoWin(readback)}};}
  catch(error){return {...r,manualReadback:{code:['AUTO_WIN_READBACK_STALE','AUTO_WIN_READBACK_INVALID','BRIDGE_UNTRUSTED'].includes(error?.message)
    ?error.message:'MANUAL_READBACK_FAILED'}};}
}

export async function verifyAfterManualInput(port,{scope,audit,retainFailureFrame,
  clock={now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))}}={}) {
  const fields=['pageEpoch','sourceStream','nativeRestoreRevision','controlEpoch'];
  if(!scope||Object.keys(scope).length!==fields.length||!fields.every(key=>Number.isSafeInteger(scope[key])&&scope[key]>=0)||scope.pageEpoch<1)
    throw Error('MANUAL_READBACK_SCOPE_REQUIRED');
  if(typeof audit!=='function')throw Error('MANUAL_READBACK_AUDIT_REQUIRED');
  if(retainFailureFrame!==undefined&&typeof retainFailureFrame!=='function')throw Error('MANUAL_READBACK_FRAME_SINK_INVALID');
  const fixedScope=Object.freeze(pick(scope,fields)),startedAtMs=clock.now(),deadlineMs=startedAtMs+BUDGET_MS;
  let attempts=0,sample;
  const elapsed=()=>Math.max(0,clock.now()-startedAtMs);
  async function record(value) {
    try{await audit({at:new Date(clock.now()).toISOString(),scope:fixedScope,...value});}
    catch{throw Error('MANUAL_READBACK_AUDIT_FAILED');}
  }
  const verifiedPort={
    evaluate:async(source,input)=>{
      if(input?.method!=='read'&&input?.method!=='ackAutoWin')return port.evaluate(source,input);
      const kind=input.method==='read'?'read':'ack';
      if(kind==='ack')sample.readback=pick(input.argument,readbackKeys);
      const result=await port.evaluate(guardedPage,{scope:fixedScope,deadlineMs,kind,readback:input.argument});
      const checked=result?.manualReadback;
      if(!checked||checked.code)throw Error(checked?.code??'MANUAL_READBACK_FAILED');
      if(kind==='ack') {sample.ack=pick(checked.ack,ackKeys);return checked.ack;}
      return result;
    },
    cdp:async(method,args)=>{
      if(method!=='Page.captureScreenshot')throw Error('MANUAL_READBACK_FAILED');
      if(clock.now()>=deadlineMs)throw Error('MANUAL_READBACK_TIMEOUT');
      const captured=await port.cdp(method,args);
      if(retainFailureFrame&&typeof captured?.data==='string'&&captured.data.length<=12*1024*1024)sample.screenshot=captured.data;
      return captured;
    },
  };
  for(;;) {
    if(clock.now()>=deadlineMs) {
      await record({kind:'manual-readback-stopped',attempts,code:'MANUAL_READBACK_TIMEOUT',elapsedMs:elapsed()});
      return {status:'stopped',code:'MANUAL_READBACK_TIMEOUT',attempts};
    }
    attempts++;
    sample={readback:null,ack:null,screenshot:null};
    await record({kind:'manual-readback-attempt',attempt:attempts,elapsedMs:elapsed()});
    let proof;
    try {proof=await verifyAutoWin(verifiedPort);}
    catch(error) {
      const code=codeOf(error),state=sample.ack?.state??null;
      let failureFrame=null,classification=null,frameError=null;
      if(sample.screenshot!==null) {
        const png=Buffer.from(sample.screenshot,'base64');
        const pngSha256=createHash('sha256').update(png).digest('hex');
        const byteLength=png.length;
        try {classification=classifyAutoWinPixels(decodeScreenshotPng(png),DEFAULT_AUTO_WIN_PROFILE);}
        catch { /* The retained frame may be invalid or truncated. */ }
        try {
          const path=await retainFailureFrame({png,pngSha256,attempt:attempts,scope:fixedScope,code});
          if(typeof path!=='string'||path.length===0)throw Error('MANUAL_READBACK_FRAME_REFERENCE_INVALID');
          failureFrame={path,pngSha256,byteLength};
        } catch {
          frameError='MANUAL_READBACK_FRAME_RETAIN_FAILED';
          failureFrame={path:null,pngSha256,byteLength};
        }
      }
      const retryable=!frameError&&(code==='AUTO_WIN_READBACK_STALE'||code==='AUTO_WIN_UNVERIFIED'&&state==='unknown');
      await record({kind:'manual-readback-failed',attempt:attempts,code,readbackState:state,readback:sample.readback,
        ack:sample.ack,classification,failureFrame,frameError,retryable,elapsedMs:elapsed()});
      if(frameError)return {status:'stopped',code:frameError,attempts};
      if(!retryable)return {status:'stopped',code,attempts};
      await clock.sleep(Math.min(RETRY_MS,Math.max(0,deadlineMs-clock.now())));
      continue;
    }
    // No later scope/current-state read may turn this historical ACK into a
    // failure. A subsequent offer/win is independently captured by the port and
    // must itself contain the prior proof; this row never fills it in.
    const historical=pick(proof,[...readbackKeys,'clicked']);
    historical.verified=pick(proof.verified,ackKeys);
    await record({kind:'manual-readback-verified',attempt:attempts,elapsedMs:elapsed(),historicalAck:true,proof:historical});
    return {status:'verified',historicalAck:true,attempts,proof:historical};
  }
}
