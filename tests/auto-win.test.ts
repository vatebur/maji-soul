import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { classifyAutoWinPixels, decodeScreenshotPng, DEFAULT_AUTO_WIN_PROFILE as profile,
  ensureAutoWin, verifyAutoWin, type PixelImage } from '../src/adapters/majsoul/auto-win.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';

const fixture=JSON.parse(readFileSync('tests/fixtures/auto-win/glyphs.json','utf8'));
function imageFor(sample=fixture.samples[0]):PixelImage {
  const width=profile.viewport.width,height=profile.viewport.height,rgba=new Uint8Array(width*height*4);
  for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  const bytes=Buffer.from(sample.rgba,'base64'),g=profile.glyph;
  for(let y=0;y<g.height;y++)rgba.set(bytes.subarray(y*g.width*4,(y+1)*g.width*4),((y+g.y)*width+g.x)*4);
  profile.anchors.forEach((a,i)=>rgba.set(sample.anchors[i],(a.y*width+a.x)*4));
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
  viewport={...profile.viewport};changeDuringCapture=false;clickWorks=true;
  images=[png(imageFor(fixture.samples[1])).toString('base64'),png(imageFor(fixture.samples[0])).toString('base64')];
  async evaluate(_source:unknown,input?:any):Promise<any>{
    if(input?.method==='read')return {pageEpoch:this.epoch,generation:this.generation,lastStep:this.step,paused:this.paused,freshConnection:true,reason:null,overflow:false};
    if(input?.method==='ackAutoWin'){this.acknowledgements.push(input.argument);return {state:input.argument.state,pageEpoch:this.epoch};}
    return {...this.viewport,scrollX:0,scrollY:0,scripts:['https://example.invalid/WebGL-release-4.0.51(test).js']};
  }
  async cdp(method:string,input?:any):Promise<any>{
    if(method==='Page.captureScreenshot') {
      if(this.changeDuringCapture)this.generation++;
      if(this.unknown){const image=imageFor();const a=profile.anchors[0]!;image.rgba.set([0,0,0,255],(a.y*image.width+a.x)*4);return {data:png(image).toString('base64')};}
      return {data:this.images[this.enabled?1:0]};
    }
    if(method==='Input.dispatchMouseEvent'&&input.type==='mouseReleased'){this.clicks++;if(this.clickWorks)this.enabled=!this.enabled;}
    return {};
  }
}
test('production CDP adapter reads, clicks once, confirms and restores after reconnect',async()=>{
  const page=new Page();const first=await ensureAutoWin(page);
  assert.equal(first.clicked,true);assert.equal(first.state,'enabled');assert.equal(page.clicks,1);
  await verifyAutoWin(page);assert.equal(page.clicks,1);
  page.epoch=2;page.enabled=false;const restored=await ensureAutoWin(page);
  assert.equal(restored.pageEpoch,2);assert.equal(page.clicks,2);assert.equal(page.acknowledgements.at(-1).pageEpoch,2);
});
test('unknown UI, stale capture and unsupported viewport never click or verify',async()=>{
  for(const fault of ['unknown','stale','viewport']){
    const page=new Page();if(fault==='unknown')page.unknown=true;else if(fault==='stale')page.changeDuringCapture=true;else page.viewport.width--;
    await assert.rejects(ensureAutoWin(page),/AUTO_WIN_(READBACK_UNKNOWN|READBACK_STALE|VIEWPORT_MISMATCH)/);
    assert.equal(page.clicks,0);assert.equal(page.acknowledgements.length,fault==='unknown'?1:0);
    assert.ok(page.acknowledgements.every(a=>a.state!=='enabled'));
  }
});
test('final verification is read-only; failed re-enable never retries a click',async()=>{
  const page=new Page();await assert.rejects(verifyAutoWin(page),/AUTO_WIN_UNVERIFIED/);assert.equal(page.clicks,0);
  page.paused=false;await assert.rejects(ensureAutoWin(page),/AUTO_WIN_TOGGLE_REQUIRES_PAUSE/);assert.equal(page.clicks,0);
  page.paused=true;page.clickWorks=false;await assert.rejects(ensureAutoWin(page),/AUTO_WIN_READBACK_FAILED/);
  assert.equal(page.clicks,1);assert.ok(page.acknowledgements.every(a=>a.state!=='enabled'));
  await assert.rejects(ensureAutoWin(page,profile,true,'pause-cleanup'),/AUTO_WIN_PURPOSE_INVALID/);
});
