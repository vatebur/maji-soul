import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {deflateSync} from 'node:zlib';
import {createContext,runInContext} from 'node:vm';
import {verifyAfterManualInput} from './manual-readback.mjs';
import {clickWithExpectedScope} from './manual-click.mjs';
import {DEFAULT_AUTO_WIN_PROFILE as profile} from '../../src/adapters/majsoul/auto-win.ts';

const glyphs=JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/auto-win/glyphs.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
function image(state) {
  const sample=glyphs.samples.find(row=>row.expected===(state==='disabled'?'disabled':'enabled'));
  const {width,height}=profile.viewport,stride=width*4,rgba=Buffer.alloc(stride*height);
  for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  const bytes=Buffer.from(sample.rgba,'base64'),g=profile.glyph;
  for(let y=0;y<g.height;y++)bytes.copy(rgba,((y+g.y)*width+g.x)*4,y*g.width*4,(y+1)*g.width*4);
  profile.anchors.forEach((a,i)=>rgba.set(sample.anchors[i],(a.y*width+a.x)*4));
  if(state==='unknown'){const a=profile.anchors[0];rgba.set([0,0,0,255],(a.y*width+a.x)*4);}
  const raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++)rgba.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);
  const chunk=(name,data)=>{
    const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);result.write(name,4);data.copy(result,8);
    let crc=0xffffffff;for(const b of result.subarray(4,-4)){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const images=Object.fromEntries(['enabled','disabled','unknown'].map(state=>[state,image(state)]));

function fixture(options={}) {
  const clock={now:Date.now()},events=[],audit=[],history=[],acks=[],cdps=[];
  const state={pageEpoch:1,sourceStream:0,nativeRestoreRevision:2,controlEpoch:3,generation:10,lastStep:15,
    paused:true,phase2ActionsEnabled:false,connected:true,freshConnection:true,reason:null,overflow:false,
    handEnded:false,matchEnded:false,lastClientWin:null,lastOwnWin:null,lastAutoWinReadback:null,
    operation:null,stats:{bridgeActionSends:0,clientWinRequests:0,authoritativeOwnWins:0}};
  const scope={pageEpoch:1,sourceStream:0,nativeRestoreRevision:2,controlEpoch:3};
  const bridge={
    read:()=>clone(state),
    ackAutoWin(readback){
      if(readback.pageEpoch!==state.pageEpoch||readback.generation!==state.generation||readback.step!==state.lastStep||
        readback.nativeRestoreRevision!==state.nativeRestoreRevision||Date.now()-Date.parse(readback.observedAt)>=1000)
        throw Error('AUTO_WIN_READBACK_STALE');
      acks.push(clone(readback));events.push('ack-'+readback.state);
      state.lastAutoWinReadback={...clone(readback),sourceStream:state.sourceStream};
      return {state:readback.state,pageEpoch:state.pageEpoch,generation:state.generation,
        nativeRestoreRevision:state.nativeRestoreRevision,expiresInMs:999};
    },
  };
  class PageDate extends Date {static now(){return clock.now;}}
  const context=createContext({Date:PageDate,innerWidth:2036,innerHeight:918,devicePixelRatio:1,scrollX:0,scrollY:0,
    document:{scripts:[{src:'https://example.invalid/WebGL-release-4.0.51(test).js'}]},__majiBridge:bridge});
  context.window=context;
  const h={state,scope,clock,events,audit,history,acks,cdps,context,captures:0};
  const port={
    async evaluate(source,arg){
      if(arg?.kind==='ack')await options.beforeAck?.(h);
      context.__arg=arg;
      const result=runInContext(`(${source.toString()})(__arg)`,context);
      if(result?.lastClientWin||result?.lastOwnWin)history.push(clone({request:result.lastClientWin,authority:result.lastOwnWin}));
      if(arg?.kind==='ack'&&result.manualReadback?.ack)await options.afterAck?.(h);
      return clone(result);
    },
    async cdp(method,args){
      assert.equal(method,'Page.captureScreenshot');assert.equal(args.format,'png');cdps.push(method);h.captures++;
      await options.capture?.(h);
      return {data:images[options.image?.(h)??'enabled']};
    },
  };
  h.port=port;
  h.run=()=>verifyAfterManualInput(port,{scope,audit:async row=>{
    await options.audit?.(row,h);audit.push(clone(row));events.push(row.kind);
  },retainFailureFrame:options.retainFailureFrame,clock:{now:()=>clock.now,sleep:async ms=>{assert.ok(ms>=0&&ms<=200);clock.now+=ms;}}});
  return h;
}

test('real screenshot verifier and original ACK produce one immediately audited historical proof with no input',async()=>{
  const h=fixture(),result=await h.run();
  assert.equal(result.status,'verified');assert.equal(result.historicalAck,true);assert.equal(result.attempts,1);
  assert.equal(result.proof.state,'enabled');assert.equal(result.proof.clicked,false);assert.equal(h.acks.length,1);
  assert.deepEqual(h.events,['manual-readback-attempt','ack-enabled','manual-readback-verified']);
  assert.deepEqual(h.cdps,['Page.captureScreenshot']);assert.equal(h.state.stats.bridgeActionSends,0);
});

test('local input and real step advancement during a sample invalidate that sample but allow a new same-hand proof',async()=>{
  for(const change of [s=>{s.generation++;s.lastAutoWinReadback=null;},s=>{s.generation++;s.lastStep++;}]){
    const h=fixture({capture:h=>{if(h.captures===1)change(h.state);}}),result=await h.run();
    assert.equal(result.status,'verified');assert.equal(result.attempts,2);assert.equal(h.acks.length,1);
    assert.equal(result.proof.generation,11);assert.equal(result.proof.step,h.state.lastStep);
    assert.equal(h.audit.find(row=>row.kind==='manual-readback-failed').code,'AUTO_WIN_READBACK_STALE');
  }
});

test('hand, reconnect, native restore and control changes terminate rather than verifying the replacement scope',async()=>{
  for(const key of ['sourceStream','pageEpoch','nativeRestoreRevision','controlEpoch']){
    const h=fixture({capture:h=>{h.state[key]++;h.state.generation++;}}),result=await h.run();
    assert.equal(result.status,'stopped');assert.equal(result.code,'MANUAL_READBACK_SCOPE_CHANGED');
    assert.equal(h.captures,1);assert.equal(h.acks.length,0);
  }
});

test('local input after the final sample is rejected by the original ACK and resampled once',async()=>{
  let changed=false;const h=fixture({beforeAck:h=>{if(!changed){changed=true;h.state.generation++;h.state.lastAutoWinReadback=null;}}});
  const result=await h.run();assert.equal(result.status,'verified');assert.equal(result.attempts,2);
  assert.equal(h.acks.length,1);assert.equal(result.proof.generation,11);
  assert.equal(h.audit.find(row=>row.kind==='manual-readback-failed').code,'AUTO_WIN_READBACK_STALE');
});

test('failed readback retains the exact existing frame and diagnostics before a retry',async()=>{
  const retained=[],h=fixture({image:h=>h.captures===1?'unknown':'enabled',retainFailureFrame:async frame=>{
    retained.push(frame);
    return 'readback-1-failed.png';
  }});
  assert.equal((await h.run()).status,'verified');
  assert.equal(h.captures,2);
  assert.equal(retained.length,1);
  const original=Buffer.from(images.unknown,'base64'),pngSha256=createHash('sha256').update(original).digest('hex');
  assert.deepEqual(retained[0].png,original);
  assert.equal(retained[0].pngSha256,pngSha256);
  const failed=h.audit.find(row=>row.kind==='manual-readback-failed');
  assert.equal(failed.readback.state,'unknown');
  assert.equal(failed.ack.state,'unknown');
  assert.equal(failed.classification.rgbaSha256,failed.readback.rgbaSha256);
  assert.deepEqual(failed.failureFrame,{path:'readback-1-failed.png',pngSha256,byteLength:original.length});

  const failedSink=fixture({image:()=> 'unknown',retainFailureFrame:async()=>{throw Error('TEST_FRAME_WRITE_FAILED');}});
  assert.equal((await failedSink.run()).code,'MANUAL_READBACK_FRAME_RETAIN_FAILED');
  assert.equal(failedSink.captures,1);
  assert.equal(failedSink.audit.at(-1).retryable,false);
  assert.equal(failedSink.audit.at(-1).failureFrame.path,null);
});

test('win offer, client request or own authority immediately before ACK stop atomically and remain visible through the port',async()=>{
  for(const change of [s=>{s.operation={value:{operation_list:[{type:9}]}};},
    s=>{s.lastClientWin={pageEpoch:s.pageEpoch,sourceStream:s.sourceStream,requestId:7,priorAutoWinReadback:null};},
    s=>{s.lastOwnWin={pageEpoch:s.pageEpoch,sourceStream:s.sourceStream,clientWinRequestId:7};}]){
    const h=fixture({beforeAck:h=>change(h.state)}),result=await h.run();
    assert.equal(result.code,'CLIENT_AUTO_WIN_WINDOW');assert.equal(h.acks.length,0);assert.equal(h.captures,1);
    assert.equal(h.audit.some(row=>row.kind==='manual-readback-verified'),false);
    if(h.state.lastClientWin||h.state.lastOwnWin)assert.equal(h.history.length,1);
  }
});

test('a win after the actual ACK cannot erase its historical success or fabricate a late prior',async()=>{
  const h=fixture({afterAck:h=>{
    h.state.lastClientWin={pageEpoch:1,sourceStream:0,requestId:9,priorAutoWinReadback:clone(h.state.lastAutoWinReadback)};
    h.state.lastOwnWin={pageEpoch:1,sourceStream:0,clientWinRequestId:9};h.state.handEnded=true;
    h.state.lastAutoWinReadback=null;h.state.generation++;h.events.push('win-after-ack');
  }}),result=await h.run();
  assert.equal(result.status,'verified');assert.equal(result.historicalAck,true);
  assert.deepEqual(h.events,['manual-readback-attempt','ack-enabled','win-after-ack','manual-readback-verified']);
  await h.port.evaluate(()=>window.__majiBridge.read());
  assert.equal(h.history.at(-1).request.priorAutoWinReadback.observedAt,result.proof.observedAt);
  assert.equal(h.history.at(-1).authority.clientWinRequestId,9);assert.equal(h.acks.length,1);
});

test('ended, disconnected, active executor and preexisting winning windows stop before a screenshot',async()=>{
  for(const change of [{handEnded:true},{matchEnded:true},{connected:false},{paused:false},{phase2ActionsEnabled:true},
    {reason:'DISCONNECTED'},{overflow:true},{operation:{value:{operation_list:[{type:8}]}}}]){
    const h=fixture();Object.assign(h.state,change);const result=await h.run();
    assert.equal(result.status,'stopped');assert.equal(h.captures,0);assert.equal(h.acks.length,0);
  }
});

test('unknown pixel readback can be sampled again while explicit disabled evidence stops without toggling',async()=>{
  const h=fixture({image:h=>h.captures===1?'unknown':'enabled'}),result=await h.run();
  assert.equal(result.status,'verified');assert.equal(result.attempts,2);assert.deepEqual(h.acks.map(x=>x.state),['unknown','enabled']);
  assert.equal(h.audit.find(row=>row.kind==='manual-readback-failed').readbackState,'unknown');
  const disabled=fixture({image:()=> 'disabled'}),stopped=await disabled.run();
  assert.equal(stopped.code,'AUTO_WIN_UNVERIFIED');assert.equal(stopped.attempts,1);assert.equal(disabled.acks[0].state,'disabled');
  assert.deepEqual(disabled.cdps,['Page.captureScreenshot']);
});

test('eight-second budget rejects a slow final sample and bounds repeated stale samples',async()=>{
  const slow=fixture({capture:h=>{h.clock.now+=8000;}}),expired=await slow.run();
  assert.equal(expired.code,'MANUAL_READBACK_TIMEOUT');assert.equal(slow.acks.length,0);
  const stale=fixture({capture:h=>{h.state.generation++;h.clock.now+=300;}}),start=stale.clock.now,result=await stale.run();
  assert.equal(result.code,'MANUAL_READBACK_TIMEOUT');assert.equal(stale.clock.now-start,8000);
  assert.equal(stale.captures,16);assert.equal(stale.acks.length,0);
  assert.equal(stale.audit.filter(x=>x.kind==='manual-readback-failed').length,16);
  const final=fixture({beforeAck:h=>{h.clock.now+=8000;}}),finalResult=await final.run();
  assert.equal(finalResult.code,'MANUAL_READBACK_TIMEOUT');assert.equal(final.acks.length,0);
});

test('diagnostics use fixed error codes and an audit write failure cannot silently become success',async()=>{
  const h=fixture({capture:()=>{throw Error('PRIVATE_ACCOUNT_SENTINEL');}}),result=await h.run();
  assert.equal(result.code,'MANUAL_READBACK_FAILED');assert.equal(JSON.stringify(h.audit).includes('PRIVATE_ACCOUNT_SENTINEL'),false);
  const broken=fixture({audit:row=>{if(row.kind==='manual-readback-verified')throw Error('PRIVATE_PATH_SENTINEL');}});
  await assert.rejects(broken.run(),/MANUAL_READBACK_AUDIT_FAILED/);assert.equal(broken.acks.length,1);
});

test('the real manual click helper returns its pre-input hand scope and always releases once',async()=>{
  const h=fixture(),events=[];h.state.queued=0;
  const page={...h.port,waitForTimeout:async()=>{},cdp:async(method,args)=>{
    assert.equal(method,'Input.dispatchMouseEvent');events.push(args.type);
    if(args.type==='mousePressed'){h.state.generation++;h.state.lastAutoWinReadback=null;}
  }};
  const command={kind:'click',x:800,y:825,expectedStep:15,expectedPageEpoch:1,expectedSourceStream:0};
  assert.deepEqual(await clickWithExpectedScope(page,command),h.scope);
  assert.deepEqual(events,['mouseMoved','mousePressed','mouseReleased']);
  const failed=[];let waits=0;
  await assert.rejects(clickWithExpectedScope({...page,waitForTimeout:async()=>{if(++waits===2)throw Error('MOCK_WAIT_FAILED');},
    cdp:async(_method,args)=>failed.push(args.type)},command),/MOCK_WAIT_FAILED/);
  assert.deepEqual(failed,['mouseMoved','mousePressed','mouseReleased']);
});

test('result-page input cannot authorize a new hand through post-input readback',async()=>{
  const h=fixture();h.state.queued=0;h.state.handEnded=true;const sent=[];
  const page={...h.port,waitForTimeout:async()=>{},cdp:async(_method,args)=>sent.push(args.type)};
  const returned=await clickWithExpectedScope(page,{kind:'result-click',x:1000,y:700,expectedStep:15,expectedPageEpoch:1,expectedSourceStream:0});
  assert.deepEqual(returned,h.scope);assert.deepEqual(sent,['mouseMoved','mousePressed','mouseReleased']);
  const result=await h.run();assert.equal(result.code,'MANUAL_READBACK_HAND_ENDED');assert.equal(h.captures,0);assert.equal(h.acks.length,0);
});
