import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { COUNTDOWN_CAPTURE_REGION as region, inspectClientCountdown, readCountdownPixels } from '../src/adapters/majsoul/countdown.ts';
import { DEFAULT_AUTO_WIN_PROFILE as profile, classifyAutoWinPixels } from '../src/adapters/majsoul/auto-win.ts';
import { screenshotPixelRow, type PixelImage, type PixelBox, type ScreenshotRegions } from '../src/adapters/browser/png.ts';
import { TOOLBAR_PALETTES } from '../src/adapters/majsoul/table-pixels.ts';
import type { BrowserPagePort } from '../src/ports/browser.ts';
import { fixtures,imageFor,png } from './countdown-helpers.ts';

const glyphs=JSON.parse(readFileSync(new URL('./fixtures/auto-win/glyphs.json',import.meta.url),'utf8'));
const linux=JSON.parse(readFileSync(new URL('./fixtures/countdown/linux-masks.json',import.meta.url),'utf8'));
function cropped(image:PixelImage,box:PixelBox):PixelImage {
  const rgba=new Uint8Array(box.width*box.height*4);
  for(let y=0;y<box.height;y++)rgba.set(screenshotPixelRow(image,box.x,box.y+y,box.width),y*box.width*4);
  return {width:box.width,height:box.height,rgba};
}
function sparse(image:PixelImage,boxes:PixelBox[]=[region]):ScreenshotRegions {
  return {kind:'regions',width:image.width,height:image.height,
    regions:boxes.map(box=>({...box,rgba:cropped(image,box).rgba}))};
}
function withAutoWin(image:PixelImage,state:'enabled'|'disabled',palette:'legacy'|'linux'='legacy') {
  const sample=glyphs.samples.find((sample:any)=>sample.expected===state),rgba=Buffer.from(sample.rgba,'base64'),g=profile.glyph;
  for(let y=0;y<g.height;y++)image.rgba.set(rgba.subarray(y*g.width*4,(y+1)*g.width*4),((g.y+y)*image.width+g.x)*4);
  const anchors=palette==='legacy'?profile.anchors:profile.anchorAlternatives![0]!;
  anchors.forEach(anchor=>image.rgba.set([...anchor.rgb,255],(anchor.y*image.width+anchor.x)*4));
  return image;
}
function linuxImage(sample:any):PixelImage {
  const image={width:2036,height:918,rgba:new Uint8Array(2036*918*4)};
  for(let i=3;i<image.rgba.length;i+=4)image.rgba[i]=255;
  for(const anchor of TOOLBAR_PALETTES.linux)image.rgba.set([...anchor.rgb,255],(anchor.y*image.width+anchor.x)*4);
  const mask=Buffer.from(sample.bitmapBase64,'base64');
  for(let i=0;i<250*130;i++)if(mask[i>>3]!>>(i%8)&1)image.rgba.set(
    sample.kind==='bank-only'?[240,190,90,255]:[220,220,220,255],((630+Math.floor(i/250))*image.width+1380+i%250)*4);
  if(sample.bankBitmapBase64) {
    const bank=Buffer.from(sample.bankBitmapBase64,'base64');
    for(let i=0;i<122*62;i++)if(bank[i>>3]!>>(i%8)&1)image.rgba.set(
      [240,190,90,255],((680+Math.floor(i/122))*image.width+1544+i%122)*4);
  }
  return image;
}

test('one explicit region preserves all archived timer, bank, auto-win glyph and palette pixels',()=>{
  assert.deepEqual(region,{x:211,y:464,width:1455,height:296});
  for(const source of [fixtures.samples,
    JSON.parse(readFileSync(new URL('./fixtures/countdown/current-masks.json',import.meta.url),'utf8')).samples]) {
    for(const sample of source)for(const state of ['enabled','disabled'] as const) {
      const full=withAutoWin(imageFor(sample),state),crop=sparse(full);
      assert.deepEqual(readCountdownPixels(crop),readCountdownPixels(full),sample.name);
      assert.deepEqual(classifyAutoWinPixels(crop,profile),classifyAutoWinPixels(full,profile));
      assert.equal(classifyAutoWinPixels(crop,profile).state,state);
    }
  }
  for(const sample of linux.samples) {
    const full=withAutoWin(linuxImage(sample),'enabled','linux'),crop=sparse(full);
    assert.deepEqual(readCountdownPixels(crop,sample.readBank??true),readCountdownPixels(full,sample.readBank??true),sample.name);
    assert.deepEqual(classifyAutoWinPixels(crop,profile),classifyAutoWinPixels(full,profile));
  }
});

test('sparse pixel access rejects every absent palette anchor, bank, timer row and truncated pixel buffer',()=>{
  const full=withAutoWin(linuxImage(linux.samples.find((sample:any)=>sample.kind==='fixed')),'enabled','linux');
  const boxes=[{x:1380,y:630,width:250,height:130},{x:1544,y:680,width:122,height:62},profile.glyph,
    ...profile.anchors.map(anchor=>({x:anchor.x,y:anchor.y,width:1,height:1}))];
  for(let index=0;index<4;index++)assert.throws(()=>readCountdownPixels(sparse(full,boxes.filter((_box,i)=>i!==3+index)),true),
    /SCREENSHOT_PIXEL_UNAVAILABLE/);
  assert.throws(()=>readCountdownPixels(sparse(full,boxes.filter((_box,i)=>i!==0)),true),/SCREENSHOT_PIXEL_UNAVAILABLE/);
  assert.throws(()=>readCountdownPixels(sparse(full,boxes.filter((_box,i)=>i!==1)),true),/SCREENSHOT_PIXEL_UNAVAILABLE/);
  const truncated=sparse(full);truncated.regions[0]!.rgba=truncated.regions[0]!.rgba.subarray(4);
  assert.throws(()=>readCountdownPixels(truncated,true),/SCREENSHOT_PIXEL_UNAVAILABLE/);
  assert.equal('rgba' in sparse(full),false);
});

class RegionPage implements BrowserPagePort {
  state:Record<string,any>={pageEpoch:1,generation:2,lastStep:8,nativeRestoreRevision:3,sourceStream:4,
    gameUuid:'game',handSha256:'a'.repeat(64),controlEpoch:5,paused:true,connected:true,freshConnection:true,
    nativeRestorePending:false,handEnded:false,matchEnded:false,reason:null,overflow:false};
  layout:Record<string,number>={innerWidth:2036,innerHeight:918,devicePixelRatio:1,scrollX:0,scrollY:0};
  image=withAutoWin(imageFor(fixtures.samples[2]),'enabled');
  mono=1000;captureDelay=500;nativeCaptures=0;fullCaptures=0;unavailable=false;wrongSize=false;failure:string|null=null;
  onCapture?:()=>void;
  async evaluate(source:any,argument?:any):Promise<any> {
    const page=this;
    class ClockDate extends Date {
      constructor(value?:string|number) {super(value??Date.UTC(2026,10,13)+page.mono);}
      static now(){return Date.UTC(2026,10,13)+page.mono;}
    }
    return await runInNewContext(`(${source.toString()})(argument)`,{argument,Error,Date:ClockDate,
      performance:{now:()=>this.mono},...this.layout,
      document:{scripts:[{src:'https://example.invalid/WebGL-release-4.0.51(test).js'}]},
      window:{__majiBridge:{read:()=>({...this.state})}}});
  }
  async cdp():Promise<any> {return this.captureViewportPng();}
  async captureViewportPng():Promise<{data:string}> {
    this.fullCaptures++;this.mono+=this.captureDelay;this.onCapture?.();return {data:png(this.image)};
  }
  async captureViewportPngRegion(box:PixelBox):Promise<{data:string}> {
    assert.deepEqual(box,region);
    if(this.unavailable)throw Error('BROWSER_REGION_CAPTURE_UNAVAILABLE');
    if(this.failure)throw Error(this.failure);
    this.nativeCaptures++;this.mono+=this.captureDelay;this.onCapture?.();
    return {data:png(cropped(this.image,{...box,width:box.width-(this.wrongSize?1:0)}))};
  }
}

test('production opt-in takes one original-time region frame; default and unowned sessions retain full capture',async()=>{
  const native=new RegionPage(),sample=await inspectClientCountdown(native,false,{nativeRegion:true});
  assert.equal(native.nativeCaptures,1);assert.equal(native.fullCaptures,0);
  assert.equal(sample.remainingMs,129000);assert.equal(sample.sampledMonoMs,1000);
  assert.equal(sample.observedAt,'2026-11-13T00:00:01.000Z');assert.equal(sample.autoWinReadback?.observedAt,sample.observedAt);
  assert.equal(sample.autoWinReadback?.state,'enabled');
  const manual=new RegionPage();await inspectClientCountdown(manual);
  assert.equal(manual.nativeCaptures,0);assert.equal(manual.fullCaptures,1);
  const unowned=new RegionPage();unowned.unavailable=true;
  assert.equal((await inspectClientCountdown(unowned,false,{nativeRegion:true})).sampledMonoMs,1000);
  assert.equal(unowned.nativeCaptures,0);assert.equal(unowned.fullCaptures,1);
});

test('region capture retains the 2s sampling bound and never retimestamps a switch older than its 1s gate',async()=>{
  const oldSwitch=new RegionPage();oldSwitch.captureDelay=1500;
  const sample=await inspectClientCountdown(oldSwitch,false,{nativeRegion:true});
  assert.equal(sample.sampledMonoMs,1000);assert.equal(sample.autoWinReadback?.observedAt,'2026-11-13T00:00:01.000Z');
  assert.ok(Date.UTC(2026,10,13)+oldSwitch.mono-Date.parse(sample.autoWinReadback!.observedAt)>=1000);
  const stale=new RegionPage();stale.captureDelay=2001;
  await assert.rejects(inspectClientCountdown(stale,false,{nativeRegion:true}),/COUNTDOWN_SAMPLE_STALE/);
  const wrong=new RegionPage();wrong.wrongSize=true;
  await assert.rejects(inspectClientCountdown(wrong,false,{nativeRegion:true}),/COUNTDOWN_SCREENSHOT_REGION_INVALID/);
  for(const failure of ['BROWSER_SCREENSHOT_REGION_INVALID','BROWSER_DISCONNECTED']) {
    const page=new RegionPage();page.failure=failure;
    await assert.rejects(inspectClientCountdown(page,false,{nativeRegion:true}),new RegExp(failure));assert.equal(page.fullCaptures,0);
  }
});

test('region post-check rejects viewport drift without an event and every changed page/hand/native/control field',async()=>{
  for(const field of ['innerWidth','innerHeight','devicePixelRatio','scrollX','scrollY']) {
    const page=new RegionPage();page.onCapture=()=>{page.layout[field]=page.layout[field]!+1;};
    await assert.rejects(inspectClientCountdown(page,false,{nativeRegion:true}),/COUNTDOWN_VIEWPORT_MISMATCH/,field);
  }
  for(const field of ['pageEpoch','generation','lastStep','nativeRestoreRevision','sourceStream','gameUuid','handSha256','controlEpoch','paused']) {
    const page=new RegionPage();page.onCapture=()=>{
      const value=page.state[field];page.state[field]=typeof value==='number'?value+1:typeof value==='boolean'?!value:`${value}-changed`;
    };
    await assert.rejects(inspectClientCountdown(page,false,{nativeRegion:true}),/COUNTDOWN_READBACK_STALE/,field);
  }
  for(const [field,value] of Object.entries({connected:false,freshConnection:false,nativeRestorePending:true,
    handEnded:true,matchEnded:true,reason:'DISCONNECTED',overflow:true})) {
    const page=new RegionPage();page.onCapture=()=>{page.state[field]=value;};
    await assert.rejects(inspectClientCountdown(page,false,{nativeRegion:true}),/COUNTDOWN_READBACK_STALE/,field);
  }
});
