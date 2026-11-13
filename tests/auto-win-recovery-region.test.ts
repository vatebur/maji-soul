import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {ensureAutoWin,hasRecoveryTableAnchors,DEFAULT_AUTO_WIN_PROFILE as profile,type AutoWinReadback} from '../src/adapters/majsoul/auto-win.ts';
import type {BrowserPagePort} from '../src/ports/browser.ts';
import {bridgeCall} from '../src/adapters/majsoul/ego-transport.ts';
import type {ScreenshotRegions} from '../src/adapters/browser/png.ts';
import {TOOLBAR_PALETTES,LINUX_TABLE_FRAME} from '../src/adapters/majsoul/table-pixels.ts';

const region={x:211,y:280,width:925,height:450};
const samples=JSON.parse(readFileSync('tests/fixtures/auto-win/glyphs.json','utf8')).samples;
const fixture=samples[0];
function png(box:typeof region,enabled=true,table=true) {
  const fixture=samples[enabled?0:1];
  const rgba=Buffer.alloc(box.width*box.height*4),glyph=Buffer.from(fixture.rgba,'base64');
  for(let at=3;at<rgba.length;at+=4)rgba[at]=255;
  for(let y=0;y<profile.glyph.height;y++)rgba.set(glyph.subarray(y*profile.glyph.width*4,(y+1)*profile.glyph.width*4),
    ((profile.glyph.y-box.y+y)*box.width+profile.glyph.x-box.x)*4);
  profile.anchors.forEach((anchor,index)=>rgba.set(fixture.anchors[index],((anchor.y-box.y)*box.width+anchor.x-box.x)*4));
  if(table)for(const [x,y]of[[900,390],[1135,335],[945,440],[1080,280]])rgba.set([69,67,78,255],((y!-box.y)*box.width+x!-box.x)*4);
  const stride=box.width*4,raw=Buffer.alloc((stride+1)*box.height);
  for(let y=0;y<box.height;y++)raw.set(rgba.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);
  const chunk=(name:string,data:Buffer)=>{
    const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(name,4);data.copy(bytes,8);
    let crc=0xffffffff;
    for(const byte of bytes.subarray(4,bytes.length-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(box.width);header.writeUInt32BE(box.height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const data={region:[png(region,false),png(region)],full:[png({x:0,y:0,width:2036,height:918},false),png({x:0,y:0,width:2036,height:918})],modal:png(region,true,false)};
const nativeCycle=()=>['authGame','syncGame','finishSyncGame'].flatMap((method,index)=>
  ['request','response','response-forwarded'].map((phase,offset)=>({method,owner:'client',phase,pageEpoch:1,
    observedMonoMs:100+index*10+offset,accepted:phase==='request'?'unknown':true,
    ...(method==='syncGame'&&phase!=='request'?{hasRestore:true}:{})})));
class Page implements BrowserPagePort {
  state:Record<string,any>={pageEpoch:1,generation:2,lastStep:0,nativeRestoreRevision:3,sourceStream:1,
    gameUuid:'PRIVATE_GAME_IDENTIFIER',handSha256:'PRIVATE_HAND_IDENTIFIER',controlEpoch:5,paused:true,
    connected:true,freshConnection:true,handEnded:false,matchEnded:false,reason:null,overflow:false,nativeLifecycleTrace:nativeCycle()};
  layout={innerWidth:2036,innerHeight:918,devicePixelRatio:1,scrollX:0,scrollY:0};
  enabled=true;captures=0;regionCalls=0;fullCalls=0;clicks=0;modal=false;unavailable=false;
  acknowledgements:AutoWinReadback[]=[];attempted:AutoWinReadback[]=[];
  onCapture?:()=>void;onRegion?:()=>void;onRelease?:()=>void;
  async evaluate(source:any,argument?:any):Promise<any> {
    return runInNewContext(`(${source.toString()})(argument)`,{argument,Error,Date,...this.layout,
      document:{scripts:[{src:'https://example.invalid/WebGL-release-4.0.51(test).js'}]},
      window:{__majiBridge:{read:()=>({...this.state}),ackAutoWin:(readback:AutoWinReadback)=>{
        this.attempted.push(readback);const age=Date.now()-Date.parse(readback.observedAt);
        if(age<0||age>=1000||readback.generation!==this.state.generation)throw Error('AUTO_WIN_READBACK_STALE');
        this.acknowledgements.push(readback);return {state:readback.state};
      }}}});
  }
  async cdp(method:string,input?:any):Promise<any> {
    if(method==='Page.captureScreenshot'){this.fullCalls++;this.captures++;this.onCapture?.();return {data:data.full[this.enabled?1:0]};}
    assert.equal(method,'Input.dispatchMouseEvent');
    if(input.type==='mousePressed'){this.clicks++;this.state.generation++;}
    if(input.type==='mouseReleased'){this.enabled=!this.enabled;this.onRelease?.();}
    return {};
  }
  async captureViewportPngRegion(box:typeof region) {
    assert.deepEqual(box,region);this.regionCalls++;this.onRegion?.();
    if(this.unavailable)throw Error('BROWSER_REGION_CAPTURE_UNAVAILABLE');
    this.captures++;this.onCapture?.();return {data:this.modal?data.modal:data.region[this.enabled?1:0]!};
  }
}

test('production resume, reconnect and new-hand recovery each use two real complete region samples and at most one toggle',async()=>{
  for(const purpose of ['resume','reconnect','new-hand'] as const)for(const enabled of [true,false]){
    const page=new Page();page.enabled=enabled;
    const argument=purpose==='resume'?undefined:purpose==='reconnect'?{purpose}:{purpose,expected:{pageEpoch:1,sourceStream:1,generation:2,step:0}};
    const result=await bridgeCall(page,'ensureAutoWin',argument);
    assert.equal(result.state,'enabled');assert.equal(result.clicked,!enabled);assert.ok(result.nativeRestore);
    assert.equal(page.regionCalls,enabled?2:3);assert.equal(page.fullCalls,0);assert.equal(page.clicks,enabled?0:1);
    assert.equal(page.acknowledgements.length,1);assert.equal(result.observedAt,page.acknowledgements[0]!.observedAt);
  }
});

test('default diagnostic recovery keeps complete screenshots even when a region method exists',async()=>{
  const page=new Page();await ensureAutoWin(page);
  assert.equal(page.regionCalls,0);assert.equal(page.fullCalls,2);assert.equal(page.clicks,0);
});

test('a centre-obscuring modal cannot count toward the required two positive samples',async()=>{
  const page=new Page();page.onCapture=()=>{page.modal=page.captures===1;};
  await bridgeCall(page,'ensureAutoWin');
  assert.equal(page.regionCalls,3);assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,1);
});

test('a persistent centre modal cannot authorize a toggle or ACK despite a recognised toolbar',async t=>{
  let mono=0;t.mock.method(performance,'now',()=>mono);
  const page=new Page();page.enabled=false;page.modal=true;page.onCapture=()=>{mono=10_001;};
  await assert.rejects(bridgeCall(page,'ensureAutoWin'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.captures,1);assert.equal(page.clicks,0);assert.equal(page.attempted.length,0);
});

test('recovery preserves every legacy frame alternative and the independent Linux palette using actual sparse pixels',()=>{
  const groups=[[[900,390,69,67,78],[1135,335,69,67,78],[945,440,69,67,78],[1080,280,69,67,78]],
    [[1000,291,98,93,103],[954,355,57,50,58],[960,386,47,42,55],[1070,428,98,93,103]],
    [[925,320,98,93,103],[925,400,98,93,103],[1000,280,69,67,78],[1115,320,98,93,103],[945,440,69,67,78]],
    [[925,320,98,93,103],[925,400,98,93,103],[1135,335,69,67,78],[1115,320,98,93,103],[945,440,69,67,78]]];
  const points=[...new Map([...Object.values(TOOLBAR_PALETTES).flat(),...LINUX_TABLE_FRAME,
    ...groups.flat().map(([x,y])=>({x:x!,y:y!}))].map(point=>[`${point.x},${point.y}`,point])).values()];
  for(const [index,group]of [...groups,LINUX_TABLE_FRAME.map(a=>[a.x,a.y,...a.rgb])].entries()){
    const rgba=new Uint8Array(region.width*region.height*4);
    for(let at=3;at<rgba.length;at+=4)rgba[at]=255;
    for(const [x,y,...rgb]of group)rgba.set([...rgb,255],((y!-region.y)*region.width+x!-region.x)*4);
    for(const a of index===4?TOOLBAR_PALETTES.linux:TOOLBAR_PALETTES.legacy)rgba.set([...a.rgb,255],((a.y-region.y)*region.width+a.x-region.x)*4);
    const image:ScreenshotRegions={kind:'regions',width:2036,height:918,regions:[{...region,rgba}]};
    assert.equal(hasRecoveryTableAnchors(image),true,`palette ${index}`);
    const sparse={...image,regions:points.map(({x,y})=>({x,y,width:1,height:1,
      rgba:rgba.slice(((y-region.y)*region.width+x-region.x)*4,((y-region.y)*region.width+x-region.x)*4+4)}))};
    assert.equal(hasRecoveryTableAnchors(sparse),true);
    for(let missing=0;missing<points.length;missing++)assert.equal(hasRecoveryTableAnchors({...sparse,
      regions:sparse.regions.filter((_,at)=>at!==missing)}),false,`palette ${index}, missing ${missing}`);
  }
  assert.equal(hasRecoveryTableAnchors({kind:'regions',width:2036,height:918,regions:[{x:211,y:464,width:58,height:266,
    rgba:new Uint8Array(58*266*4)}]}),false);
});

test('recovery region rejects all changed scope fields and actual viewport geometry before any click or ACK',async()=>{
  for(const key of ['pageEpoch','sourceStream','gameUuid','handSha256','generation','lastStep','nativeRestoreRevision','controlEpoch','paused']){
    const page=new Page();page.onCapture=()=>{const value=page.state[key];page.state[key]=typeof value==='number'?value+1:typeof value==='boolean'?!value:`${value}-changed`;};
    await assert.rejects(bridgeCall(page,'ensureAutoWin'),/AUTO_WIN_READBACK_STALE/,key);
    assert.equal(page.clicks,0);assert.equal(page.attempted.length,0);assert.equal(page.captures,1);
  }
  for(const [key,value]of Object.entries({innerWidth:2035,innerHeight:917,devicePixelRatio:2,scrollX:1,scrollY:1})){
    const page=new Page();page.onCapture=()=>{(page.layout as any)[key]=value;};
    await assert.rejects(bridgeCall(page,'ensureAutoWin'),/AUTO_WIN_VIEWPORT_MISMATCH/,key);
    assert.equal(page.clicks,0);assert.equal(page.attempted.length,0);
  }
});

test('region capability rejection alone falls back to the original full capture without retimestamping',async t=>{
  const page=new Page();page.unavailable=true;await bridgeCall(page,'ensureAutoWin');
  assert.equal(page.fullCalls,2);assert.equal(page.regionCalls,2);assert.equal(page.acknowledgements.length,1);
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const stale=new Page();stale.unavailable=true;const times:number[]=[];
  stale.onRegion=()=>{times.push(Date.now());t.mock.timers.tick(1000);};
  await assert.rejects(bridgeCall(stale,'ensureAutoWin'),/AUTO_WIN_READBACK_STALE/);
  assert.equal(stale.fullCalls,2);assert.equal(stale.attempted.length,1);
  assert.equal(Date.parse(stale.attempted[0]!.observedAt),times[1]);assert.equal(stale.acknowledgements.length,0);
  const broken=new Page(),failure=Error('CAPTURE_FAILED');broken.onRegion=()=>{throw failure;};
  await assert.rejects(bridgeCall(broken,'ensureAutoWin'),error=>error===failure);assert.equal(broken.fullCalls,0);
});

test('expired final recovery evidence cannot ACK or repeat the toggle and traces only bounded diagnostic fields',async t=>{
  const previous=process.env.MAJI_TIMING_TRACE;process.env.MAJI_TIMING_TRACE='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const messages:string[]=[];t.mock.method(console,'warn',(message:string)=>messages.push(message));
  const page=new Page();page.enabled=false;page.onCapture=()=>{t.mock.timers.tick(1000);};
  await assert.rejects(bridgeCall(page,'ensureAutoWin'),/AUTO_WIN_READBACK_STALE/);
  assert.equal(page.clicks,1);assert.equal(page.captures,3);assert.equal(page.acknowledgements.length,0);
  const trace=JSON.parse(messages[0]!);assert.equal(messages.length,1);
  assert.deepEqual(Object.keys(trace).sort(),['ackAgeMs','captureMode','captures','changedFields','event','phase','succeeded','totalMs']);
  assert.equal(trace.event,'timing.auto-win-ensure');assert.equal(trace.phase,'ack');assert.equal(trace.succeeded,false);
  assert.equal(trace.ackAgeMs,1000);assert.equal(trace.captureMode,'region');assert.equal(trace.captures,3);
  assert.deepEqual(trace.changedFields,[]);assert.ok(Number.isFinite(trace.totalMs)&&trace.totalMs>=0);
  assert.ok(!messages[0]!.includes('PRIVATE_'));assert.ok(!messages[0]!.includes(fixture.rgba));
});

test('scope failure trace names changed fields without values, and logging failures do not alter the result',async t=>{
  const previous=process.env.MAJI_TIMING_TRACE;process.env.MAJI_TIMING_TRACE='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  const messages:string[]=[];const warn=t.mock.method(console,'warn',(message:string)=>messages.push(message));
  const page=new Page();page.onCapture=()=>{page.state.lastStep++;};
  await assert.rejects(bridgeCall(page,'ensureAutoWin'),/AUTO_WIN_READBACK_STALE/);
  const trace=JSON.parse(messages[0]!);assert.deepEqual(trace.changedFields,['lastStep']);assert.equal(trace.phase,'recovery-table');assert.equal(trace.ackAgeMs,null);
  warn.mock.mockImplementation(()=>{throw Error('LOGGER_FAILED');});
  assert.equal((await bridgeCall(new Page(),'ensureAutoWin')).state,'enabled');
});

test('post-toggle native restore change still blocks and never starts a second click',async()=>{
  const page=new Page();page.enabled=false;page.onRelease=()=>{page.state.nativeRestoreRevision++;page.state.nativeLifecycleTrace=[];};
  await assert.rejects(bridgeCall(page,'ensureAutoWin'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.clicks,1);assert.equal(page.attempted.length,0);
});
