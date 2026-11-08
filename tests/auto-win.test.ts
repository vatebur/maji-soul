import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { classifyAutoWinPixels, decodeScreenshotPng, DEFAULT_AUTO_WIN_PROFILE as profile,
  ensureAutoWin, verifyAutoWin, nativeRestoreProof, hasRecoveryTableAnchors, type PixelImage } from '../src/adapters/majsoul/auto-win.ts';
import {bridgeCall, type EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';

const fixture=JSON.parse(readFileSync('tests/fixtures/auto-win/glyphs.json','utf8'));
const recoveryFixture=JSON.parse(readFileSync('tests/fixtures/auto-win/recovery-anchors.json','utf8'));
function imageFor(sample=fixture.samples[0]):PixelImage {
  const width=profile.viewport.width,height=profile.viewport.height,rgba=new Uint8Array(width*height*4);
  for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  const bytes=Buffer.from(sample.rgba,'base64'),g=profile.glyph;
  for(let y=0;y<g.height;y++)rgba.set(bytes.subarray(y*g.width*4,(y+1)*g.width*4),((y+g.y)*width+g.x)*4);
  profile.anchors.forEach((a,i)=>rgba.set(sample.anchors[i],(a.y*width+a.x)*4));
  for (const [x,y] of [[900,390],[1135,335],[945,440],[1080,280]])rgba.set([69,67,78,255],(y!*width+x!)*4);
  return {width,height,rgba};
}
function png(image:PixelImage, filter=0) {
  const stride=image.width*4,raw=Buffer.alloc((stride+1)*image.height);
  const paeth=(a:number,b:number,c:number)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<image.height;y++) {
    raw[y*(stride+1)]=filter;
    for(let x=0;x<stride;x++) {
      const at=y*stride+x,left=x>=4?image.rgba[at-4]!:0,up=y?image.rgba[at-stride]!:0,before=y&&x>=4?image.rgba[at-stride-4]!:0;
      const predictor=[0,left,up,Math.floor((left+up)/2),paeth(left,up,before)][filter]!;
      raw[y*(stride+1)+1+x]=(image.rgba[at]!-predictor+256)&255;
    }
  }
  const chunk=(type:string,data:Buffer)=> {
    const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4);data.copy(bytes,8);
    let crc=0xffffffff;for(const b of bytes.subarray(4,bytes.length-4)){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(image.width);header.writeUInt32BE(image.height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

test('archived current-client glyphs distinguish grey and green despite enable animation',()=>{
  for(const sample of fixture.samples){const result=classifyAutoWinPixels(imageFor(sample),profile);assert.equal(result.state,sample.expected);assert.equal(result.rgbaSha256,sample.rgbaSha256);}
});
test('toolbar anchors, viewport and ambiguous glyphs fail closed',()=>{
  const im=imageFor();const anchor=profile.anchors[0]!;im.rgba.set([0,0,0,255],(anchor.y*im.width+anchor.x)*4);
  assert.equal(classifyAutoWinPixels(im,profile).state,'unknown');
  assert.throws(()=>classifyAutoWinPixels({...im,width:im.width-1},profile),/AUTO_WIN_VIEWPORT_MISMATCH/);
  const blank=imageFor();const g=profile.glyph;
  for(let y=g.y;y<g.y+g.height;y++)for(let x=g.x;x<g.x+g.width;x++)blank.rgba.set([0,0,0,255],(y*blank.width+x)*4);
  assert.equal(classifyAutoWinPixels(blank,profile).state,'unknown');
  for(let y=g.y;y<g.y+g.height;y++)for(let x=g.x;x<g.x+g.width;x++)blank.rgba.set([40,220,70,255],(y*blank.width+x)*4);
  assert.equal(classifyAutoWinPixels(blank,profile).state,'unknown');
});
test('screenshot decoder restores every PNG row filter and rejects malformed images',()=>{
  const original:PixelImage={width:4,height:5,rgba:Uint8Array.from({length:80},(_,i)=>(i*29)%256)};
  for(let filter=0;filter<=4;filter++){const decoded=decodeScreenshotPng(png(original,filter));assert.deepEqual(decoded,original);}
  assert.throws(()=>decodeScreenshotPng(new Uint8Array([1,2,3])),/AUTO_WIN_SCREENSHOT_INVALID/);
  assert.throws(()=>decodeScreenshotPng(png(original).subarray(0,50)),/AUTO_WIN_SCREENSHOT_INVALID/);
});

class Page implements EgoPagePort {
  epoch=1;generation=2;step=1;paused=true;enabled=false;unknown=false;clicks=0;acknowledgements:any[]=[];
  connected=true;handEnded=false;matchEnded=false;sourceStream=0;controlEpoch=1;
  nativeRestoreRevision=0;onAck?:()=>void;
  viewport={...profile.viewport};changeDuringCapture=false;clickWorks=true;
  onMouseMoved?:()=>void;onMouseReleased?:()=>void;
  nativeLifecycleTrace:any[]|undefined=nativeCycle();onRead?:()=>void;onCapture?:()=>void;reads=0;captures=0;captureRestoreProofs:any[]=[];
  recoveryModal=false;
  images=[png(imageFor(fixture.samples[1])).toString('base64'),png(imageFor(fixture.samples[0])).toString('base64')];
  async evaluate(_source:unknown,input?:any):Promise<any>{
    if(input?.method==='read'){this.reads++;this.onRead?.();return {pageEpoch:this.epoch,generation:this.generation,lastStep:this.step,paused:this.paused,
      connected:this.connected,handEnded:this.handEnded,matchEnded:this.matchEnded,sourceStream:this.sourceStream,controlEpoch:this.controlEpoch,
      nativeLifecycleTrace:this.nativeLifecycleTrace,nativeRestoreRevision:this.nativeRestoreRevision,freshConnection:true,reason:null,overflow:false};}
    if(input?.method==='ackAutoWin'){
      this.onAck?.();
      if(input.argument.nativeRestoreRevision!==this.nativeRestoreRevision)throw Error('AUTO_WIN_READBACK_STALE');
      this.acknowledgements.push(input.argument);return {state:input.argument.state,pageEpoch:this.epoch};
    }
    return {...this.viewport,scrollX:0,scrollY:0,scripts:['https://example.invalid/WebGL-release-4.0.51(test).js']};
  }
  async cdp(method:string,input?:any):Promise<any>{
    if(method==='Page.captureScreenshot') {
      this.captures++;this.captureRestoreProofs.push(nativeRestoreProof({pageEpoch:this.epoch,nativeLifecycleTrace:this.nativeLifecycleTrace}));
      this.onCapture?.();
      if(this.changeDuringCapture)this.generation++;
      if(this.unknown){const image=imageFor();const a=profile.anchors[0]!;image.rgba.set([0,0,0,255],(a.y*image.width+a.x)*4);return {data:png(image).toString('base64')};}
      if(this.recoveryModal){const image=imageFor(fixture.samples[this.enabled?0:1]);image.rgba.set([25,33,55,255],(390*image.width+900)*4);return {data:png(image).toString('base64')};}
      return {data:this.images[this.enabled?1:0]};
    }
    if(method==='Input.dispatchMouseEvent') {
      if(input.type==='mouseMoved')this.onMouseMoved?.();
      if(input.type==='mousePressed')this.generation++; // Page pointerdown invalidates prior proofs.
      if(input.type==='mouseReleased'){this.clicks++;if(this.clickWorks)this.enabled=!this.enabled;this.onMouseReleased?.();}
    }
    return {};
  }
}
test('production CDP adapter reads, clicks once, confirms and restores after reconnect',async()=>{
  const page=new Page();const first=await ensureAutoWin(page);
  assert.equal(first.clicked,true);assert.equal(first.state,'enabled');assert.equal(page.clicks,1);
  await verifyAutoWin(page);assert.equal(page.clicks,1);
  page.epoch=2;page.nativeLifecycleTrace=nativeCycle(2);page.enabled=false;const restored=await ensureAutoWin(page);
  assert.equal(restored.pageEpoch,2);assert.equal(page.clicks,2);assert.equal(page.acknowledgements.at(-1).pageEpoch,2);
});
test('unknown UI, stale capture and unsupported viewport never click or verify',async()=>{
  for(const fault of ['unknown','stale','viewport']){
    const page=new Page();if(fault==='unknown')page.unknown=true;else if(fault==='stale')page.changeDuringCapture=true;else page.viewport.width--;
    await assert.rejects(ensureAutoWin(page),/AUTO_WIN_(RECOVERY_NOT_READY|READBACK_STALE|VIEWPORT_MISMATCH)/);
    assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
    assert.ok(page.acknowledgements.every(a=>a.state!=='enabled'));
  }
});
test('final verification is read-only; failed re-enable never retries a click',async()=>{
  const page=new Page();await assert.rejects(verifyAutoWin(page),/AUTO_WIN_UNVERIFIED/);assert.equal(page.clicks,0);
  page.paused=false;await assert.rejects(ensureAutoWin(page),/AUTO_WIN_RECOVERY_NOT_READY/);assert.equal(page.clicks,0);
  page.paused=true;page.clickWorks=false;await assert.rejects(ensureAutoWin(page),/AUTO_WIN_READBACK_FAILED/);
  assert.equal(page.clicks,1);assert.ok(page.acknowledgements.every(a=>a.state!=='enabled'));
  await assert.rejects(ensureAutoWin(page,profile,true,'pause-cleanup'),/AUTO_WIN_PURPOSE_INVALID/);
});

test('a boundary or resume while moving the pointer cancels the old toggle before pressing',async()=>{
  for(const fault of ['reconnect','hand','resume']) {
    const page=new Page();
    page.onMouseMoved=()=>{
      page.enabled=true;
      if(fault==='reconnect'){page.epoch++;page.generation++;}
      else if(fault==='hand'){page.sourceStream++;page.generation++;}
      else{page.controlEpoch++;page.paused=false;}
    };
    await assert.rejects(ensureAutoWin(page),/AUTO_WIN_RECOVERY_NOT_READY/);
    assert.equal(page.clicks,0);assert.equal(page.enabled,true);assert.equal(page.acknowledgements.length,0);
  }
});

test('a post-click boundary cannot confirm a replacement connection or hand as the original toggle',async()=>{
  for(const fault of ['reconnect','hand']) {
    const page=new Page();
    page.onMouseReleased=()=>{
      if(fault==='reconnect')page.epoch++;
      else page.sourceStream++;
      page.generation++;
    };
    await assert.rejects(ensureAutoWin(page),/AUTO_WIN_RECOVERY_NOT_READY/);
    assert.equal(page.clicks,1);assert.equal(page.acknowledgements.length,0);
  }
});

test('terminal or disconnected pages cannot verify a residual enabled toolbar glyph',async()=>{
  for(const fault of ['handEnded','matchEnded','disconnected']) {
    const page=new Page();page.enabled=true;
    if(fault==='disconnected')page.connected=false;
    else page[fault as 'handEnded'|'matchEnded']=true;
    await assert.rejects(verifyAutoWin(page),/AUTO_WIN_READBACK_STALE/);
    assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
  }
});

function nativeCycle(pageEpoch=1,restoreMethod='syncGame',owner='client',hasRestore=true) {
  return ['authGame',restoreMethod,'finishSyncGame'].flatMap((method,index)=>
    ['request','response','response-forwarded'].map((phase,offset)=>({method,owner,phase,pageEpoch,
      observedMonoMs:100+index*10+offset,accepted:phase==='request'?'unknown':true,
      ...(method===restoreMethod && phase!=='request'?{hasRestore}:{})})));
}

test('only a complete current-client restore cycle can satisfy the reconnect prerequisite',()=>{
  for(const method of ['syncGame','enterGame']) {
    const trace=nativeCycle(5,method);
    assert.equal(nativeRestoreProof({pageEpoch:5,nativeLifecycleTrace:trace})?.restoreMethod,method);
  }
  const invalid=[
    nativeCycle(5,'syncGame','bridge'),nativeCycle(4),nativeCycle(5).slice(1),nativeCycle(5).slice(0,-1),
    [...nativeCycle(5),{method:'syncGame',owner:'client',phase:'request',pageEpoch:5,observedMonoMs:200}],
    [...nativeCycle(5).slice(0,4),nativeCycle(5)[3],...nativeCycle(5).slice(4)],
  ];
  for(const index of [2,5,8]) {
    const trace=nativeCycle(5);trace[index]!.accepted=false;invalid.push(trace);
  }
  const backwards=nativeCycle(5);backwards[8]!.observedMonoMs=1;invalid.push(backwards);
  for(const trace of invalid)assert.equal(nativeRestoreProof({pageEpoch:5,nativeLifecycleTrace:trace}),null);
  const trace=nativeCycle(5);
  const interleaved=[trace[0],trace[1],trace[3],trace[2],trace[4],trace[6],trace[5],trace[7],trace[8]]
    .map((event,index)=>({...event,observedMonoMs:100+index}));
  assert.ok(nativeRestoreProof({pageEpoch:5,nativeLifecycleTrace:interleaved}));
});

test('archived public centre-frame anchors reject the observed modal but are not native readiness',()=>{
  for(const sample of recoveryFixture.samples) {
    const image=imageFor();
    recoveryFixture.anchors.forEach((anchor:any,index:number)=>image.rgba.set(sample.rgba[index],(anchor.y*image.width+anchor.x)*4));
    assert.equal(hasRecoveryTableAnchors(image),sample.expected,sample.label);
  }
  assert.ok(recoveryFixture.samples.some((sample:any)=>sample.observation==='empty-table-center-visible'&&sample.expected===true));
  assert.equal(nativeRestoreProof({pageEpoch:1,nativeLifecycleTrace:nativeCycle().slice(0,5)}),null);
});

test('reconnect waits for the native restore before taking pixels and makes only one toggle',async()=>{
  const page=new Page();
  page.nativeLifecycleTrace=[...nativeCycle().slice(0,3),...nativeCycle(1,'syncGame','bridge')];
  page.onRead=()=>{if(page.reads===3){page.nativeLifecycleTrace=nativeCycle();page.nativeRestoreRevision++;}};
  const result=await ensureAutoWin(page,profile,true,'reconnect');
  assert.equal(result.state,'enabled');assert.equal(result.clicked,true);assert.equal(page.clicks,1);
  assert.equal(result.nativeRestore?.finishForwardedMonoMs,122);
  assert.ok(page.captureRestoreProofs.every(proof=>proof?.finishForwardedMonoMs===122));
  assert.equal(page.acknowledgements.length,1);
  assert.equal(result.nativeRestoreRevision,1);
});

test('an enabled switch is read afresh after reconnect readiness without toggling it',async()=>{
  const page=new Page();page.enabled=true;page.nativeLifecycleTrace=nativeCycle();
  const result=await ensureAutoWin(page,profile,true,'reconnect');
  assert.equal(result.clicked,false);assert.equal(page.clicks,0);assert.equal(page.captures,2);
  assert.equal(result.nativeRestore?.pageEpoch,page.epoch);
});

test('reconnect readiness cannot migrate to a changed scope while waiting',async()=>{
  for(const fault of ['epoch','hand','step','input','resume','disconnect','terminal']) {
    const page=new Page();page.nativeLifecycleTrace=nativeCycle().slice(0,3);
    page.onRead=()=>{
      if(page.reads!==2)return;
      if(fault==='epoch')page.epoch++;
      else if(fault==='hand')page.sourceStream++;
      else if(fault==='step')page.step++;
      else if(fault==='input')page.generation++;
      else if(fault==='resume'){page.controlEpoch++;page.paused=false;}
      else if(fault==='disconnect')page.connected=false;
      else page.handEnded=true;
    };
    await assert.rejects(ensureAutoWin(page,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
    assert.equal(page.clicks,0);assert.equal(page.captures,0);assert.equal(page.acknowledgements.length,0);
  }
});

test('a new native restore during pointer movement cancels the sole reconnect click',async()=>{
  const page=new Page();page.nativeLifecycleTrace=nativeCycle();
  page.onMouseMoved=()=>page.nativeLifecycleTrace!.push({method:'syncGame',owner:'client',phase:'request',pageEpoch:1,observedMonoMs:200});
  await assert.rejects(ensureAutoWin(page,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
});

test('native restore changes after the sole click cannot be acknowledged or retried',async()=>{
  const page=new Page();page.nativeLifecycleTrace=nativeCycle();
  page.onMouseReleased=()=>page.nativeLifecycleTrace!.push({method:'syncGame',owner:'client',phase:'request',pageEpoch:1,observedMonoMs:200});
  await assert.rejects(ensureAutoWin(page,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.clicks,1);assert.equal(page.acknowledgements.length,0);
});

test('missing and unfinished native recovery fail closed with no screenshot or click',async()=>{
  const missing=new Page();missing.nativeLifecycleTrace=undefined;
  await assert.rejects(ensureAutoWin(missing,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(missing.clicks,0);assert.equal(missing.captures,0);
  const unfinished=new Page();unfinished.nativeLifecycleTrace=nativeCycle().slice(0,3);
  await assert.rejects(ensureAutoWin(unfinished,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(unfinished.clicks,0);assert.equal(unfinished.captures,0);assert.equal(unfinished.acknowledgements.length,0);
});

test('the bridge routes the explicit reconnect purpose through the native prerequisite',async()=>{
  const page=new Page();page.nativeLifecycleTrace=undefined;
  await assert.rejects(bridgeCall(page,'ensureAutoWin',{purpose:'reconnect'}),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.clicks,0);assert.equal(page.captures,0);
  for(const argument of [{purpose:'resume'},{purpose:'reconnect',extra:true},true,[]])
    assert.throws(()=>bridgeCall(page,'ensureAutoWin',argument),/AUTO_WIN_PURPOSE_INVALID/);
});

test('new-hand recovery checks its exact target before screenshots, clicks or acknowledgements',async()=>{
  const expected={pageEpoch:1,sourceStream:0,generation:2,step:1};
  for(const field of ['pageEpoch','sourceStream','generation','step'] as const) {
    const page=new Page();
    if(field==='pageEpoch')page.epoch++;
    else page[field]++;
    await assert.rejects(bridgeCall(page,'ensureAutoWin',{purpose:'new-hand',expected}),/AUTO_WIN_READBACK_STALE/);
    assert.equal(page.captures,0);assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
  }
  const page=new Page();page.generation=0;page.step=0;
  const result=await bridgeCall(page,'ensureAutoWin',{purpose:'new-hand',expected:{...expected,generation:0,step:0}});
  assert.equal(result.clicked,true);assert.equal(result.state,'enabled');assert.equal(page.clicks,1);
  assert.ok(page.captures>=3);assert.equal(page.acknowledgements.length,1);
});

test('new-hand RPC arguments have a bounded four-field scope and cannot alter other purposes',async()=>{
  const page=new Page(),expected={pageEpoch:1,sourceStream:0,generation:0,step:0};
  const invalid=[{purpose:'new-hand'},{purpose:'new-hand',expected:null},{purpose:'new-hand',expected,extra:true},
    {purpose:'reconnect',expected},{expected},{purpose:'new-hand',expected:{...expected,extra:true}},
    {purpose:'new-hand',expected:{pageEpoch:1,sourceStream:0,step:0}},
    Object.assign(Object.create({purpose:'new-hand'}),{expected,extra:true})];
  for(const field of ['pageEpoch','sourceStream','generation','step'])
    for(const value of [-1,0.5,Number.MAX_SAFE_INTEGER+1,'1'])invalid.push({purpose:'new-hand',expected:{...expected,[field]:value}} as any);
  invalid.push({purpose:'new-hand',expected:{...expected,pageEpoch:0}});
  for(const argument of invalid)assert.throws(()=>bridgeCall(page,'ensureAutoWin',argument),/AUTO_WIN_PURPOSE_INVALID/);
  await assert.rejects(ensureAutoWin(page,profile,true,'new-hand'),/AUTO_WIN_PURPOSE_INVALID/);
  assert.equal(page.reads,0);assert.equal(page.captures,0);assert.equal(page.clicks,0);
});

test('default and initialization calls cannot bypass native readiness while pause cleanup can close the switch',async()=>{
  for (const purpose of ['resume','initialize','reconnect'] as const) {
    const page=new Page();page.nativeLifecycleTrace=undefined;
    await assert.rejects(ensureAutoWin(page,profile,true,purpose),/AUTO_WIN_RECOVERY_NOT_READY/);
    assert.equal(page.clicks,0);assert.equal(page.captures,0);
  }
  const page=new Page();page.nativeLifecycleTrace=undefined;page.enabled=true;
  const result=await ensureAutoWin(page,profile,false,'pause-cleanup');
  assert.equal(result.state,'disabled');assert.equal(page.clicks,1);
});

test('a proven new entry without restore needs no finish but unknown or empty sync responses cannot open the gate',async()=>{
  const trace=nativeCycle(1,'enterGame','client',false).slice(0,6);
  const proof=nativeRestoreProof({pageEpoch:1,nativeLifecycleTrace:trace});
  assert.equal(proof?.hasRestore,false);assert.equal(proof?.finishForwardedMonoMs,null);
  const page=new Page();page.nativeLifecycleTrace=trace;
  assert.equal((await ensureAutoWin(page)).state,'enabled');assert.equal(page.clicks,1);
  assert.equal(nativeRestoreProof({pageEpoch:1,nativeLifecycleTrace:nativeCycle(1,'syncGame','client',false).slice(0,6)}),null);
  const unknown=nativeCycle().map(event=>({...event,...(event.method==='syncGame'&&event.phase!=='request'?{hasRestore:'unknown'}:{})}));
  assert.equal(nativeRestoreProof({pageEpoch:1,nativeLifecycleTrace:unknown}),null);
  const missing=nativeCycle().map(({hasRestore,...event})=>event);
  assert.equal(nativeRestoreProof({pageEpoch:1,nativeLifecycleTrace:missing}),null);
});

test('the native prerequisite alone cannot click through the known reconnect modal',async()=>{
  const page=new Page();page.nativeLifecycleTrace=nativeCycle();page.recoveryModal=true;
  page.onCapture=()=>{
    if(page.captures<3)assert.equal(page.clicks,0);
    if(page.captures===3)page.recoveryModal=false;
  };
  page.onMouseMoved=()=>assert.ok(page.captures>=4,'two consecutive positive table samples are required');
  const result=await ensureAutoWin(page,profile,true,'reconnect');
  assert.equal(result.clicked,true);assert.equal(page.clicks,1);assert.equal(page.acknowledgements.length,1);
});

test('table animation may exceed three seconds while recovery still requires two positive samples',async t=>{
  let now=0;
  t.mock.method(performance,'now',()=>now);
  const page=new Page();page.recoveryModal=true;
  page.onCapture=()=>{
    if(page.captures===1)now=3500;
    if(page.captures===3)page.recoveryModal=false;
  };
  page.onMouseMoved=()=>assert.ok(page.captures>=4);
  const result=await ensureAutoWin(page,profile,true,'reconnect');
  assert.equal(result.state,'enabled');assert.equal(page.clicks,1);
  assert.equal(page.acknowledgements.length,1);
});

test('a new restore during the table wait cannot reuse the earlier native completion',async()=>{
  const page=new Page();page.nativeLifecycleTrace=nativeCycle();
  page.onCapture=()=>page.nativeLifecycleTrace!.push({method:'syncGame',owner:'client',phase:'request',pageEpoch:1,observedMonoMs:200});
  await assert.rejects(ensureAutoWin(page,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
});

test('a modal after the sole reconnect click cannot acknowledge an enabled glyph behind it',async()=>{
  const page=new Page();page.nativeLifecycleTrace=nativeCycle();
  page.onMouseReleased=()=>{page.recoveryModal=true;};
  await assert.rejects(ensureAutoWin(page,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.enabled,true);assert.equal(page.clicks,1);assert.equal(page.acknowledgements.length,0);
});

test('an absent positive table frame times out without clicking',async()=>{
  const page=new Page();page.nativeLifecycleTrace=nativeCycle();page.recoveryModal=true;
  await assert.rejects(ensureAutoWin(page,profile,true,'reconnect'),/AUTO_WIN_RECOVERY_NOT_READY/);
  assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);assert.ok(page.captures>1);
});

test('native revision changes during a capture or after the last read cannot be acknowledged',async()=>{
  for (const point of ['capture','ack']) {
    const page=new Page();page.enabled=true;
    if(point==='capture')page.onCapture=()=>{page.nativeRestoreRevision++;};
    else page.onAck=()=>{page.nativeRestoreRevision++;};
    await assert.rejects(ensureAutoWin(page),/AUTO_WIN_READBACK_STALE/);
    assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
  }
});

test('native revision changes after pointer movement cannot use the old click proof',async()=>{
  const page=new Page();page.onMouseMoved=()=>{page.nativeRestoreRevision++;};
  await assert.rejects(ensureAutoWin(page),/AUTO_WIN_(READBACK_STALE|TOGGLE_REQUIRES_PAUSE)/);
  assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,0);
});

test('missing or invalid native revisions cannot be read back even in read-only verification',async()=>{
  for (const revision of [undefined,-1,1.5,Number.NaN]) {
    const page=new Page();page.enabled=true;(page as any).nativeRestoreRevision=revision;
    await assert.rejects(verifyAutoWin(page),/AUTO_WIN_READBACK_STALE/);
    assert.equal(page.clicks,0);assert.equal(page.captures,0);assert.equal(page.acknowledgements.length,0);
  }
});


test('riichi and active-seat overlays retain a complete alternative frame proof', () => {
  const image=imageFor();
  for(const [x,y] of [[900,390],[1135,335],[945,440],[1080,280]])
    image.rgba.set([0,0,0,255],(y!*image.width+x!)*4);
  const points=[[925,320,98,93,103],[925,400,98,93,103],[1000,280,69,67,78],
    [1115,320,98,93,103],[945,440,69,67,78]];
  for(const [x,y,...rgb] of points) image.rgba.set([...rgb,255],(y!*image.width+x!)*4);
  assert.equal(hasRecoveryTableAnchors(image),true);
  for(const [x,y,...rgb] of points){
    image.rgba.set([0,0,0,255],(y!*image.width+x!)*4);
    assert.equal(hasRecoveryTableAnchors(image),false);
    image.rgba.set([...rgb,255],(y!*image.width+x!)*4);
  }
});

test('top riichi deposit with left active-seat glow retains five exposed frame anchors', async () => {
  const image=imageFor(fixture.samples[0]);
  // Measured from the failing current-client frame: the stick covers both
  // top border probes, while the left score/glow invalidates the bevel set.
  const points=[[900,390,69,67,78],[1135,335,69,67,78],[945,440,69,67,78],
    [1080,280,251,251,252],[1000,291,102,97,106],[954,355,232,176,99],
    [960,386,47,42,55],[1070,428,98,93,103],[925,320,98,93,103],
    [925,400,98,93,103],[1000,280,255,255,255],[1115,320,98,93,103]];
  for(const [x,y,...rgb] of points) image.rgba.set([...rgb,255],(y!*image.width+x!)*4);
  assert.equal(hasRecoveryTableAnchors(image),true);
  const page=new Page();page.enabled=true;page.images[1]=png(image).toString('base64');
  assert.equal((await ensureAutoWin(page)).state,'enabled');
  assert.equal(page.captures,2);assert.equal(page.clicks,0);
  for(const [x,y] of [[925,320],[925,400],[1135,335],[1115,320],[945,440]]) {
    const offset=(y!*image.width+x!)*4,original=image.rgba.slice(offset,offset+4);
    image.rgba.set([0,0,0,255],offset);
    assert.equal(hasRecoveryTableAnchors(image),false);
    image.rgba.set(original,offset);
  }
});
