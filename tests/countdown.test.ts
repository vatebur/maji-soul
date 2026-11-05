import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCountdownPixels, inspectClientCountdown } from '../src/adapters/majsoul/countdown.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';

import { fixtures, anchors, imageFor, png } from './countdown-helpers.ts';

test('all ten current-client digit shapes read the independently labelled archived countdown masks',()=>{
  assert.equal(fixtures.evidenceKind,'current-client-glyph-extraction');
  const covered=new Set<string>();
  for(const sample of fixtures.samples){
    const result=readCountdownPixels(imageFor(sample));assert.equal(result.seconds,sample.expectedSeconds,sample.name);
    assert.equal(result.remainingMs,sample.expectedSeconds*1000);
    for(const digit of result.digits){covered.add(digit.value);assert.ok(digit.score>=.96);assert.ok(digit.runnerUpGap>=.18);}
  }
  assert.equal([...covered].sort().join(''),'0123456789');
});

test('blank, altered and displaced digits and unsupported layout block without guessing',()=>{
  const wrongSize=imageFor();assert.throws(()=>readCountdownPixels({...wrongSize,width:2035}),/COUNTDOWN_VIEWPORT_MISMATCH/);
  const wrongAnchor=imageFor(),anchor=anchors[0]!;wrongAnchor.rgba.set([0,0,0,255],(anchor.y*2036+anchor.x)*4);
  assert.throws(()=>readCountdownPixels(wrongAnchor),/COUNTDOWN_LAYOUT_UNVERIFIED/);
  const blank=imageFor();
  for(let y=630;y<760;y++)for(let x=1380;x<1630;x++)blank.rgba.set([0,0,0,255],(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(blank),/COUNTDOWN_DIGITS_UNREADABLE/);
  const altered=imageFor();
  for(let y=680;y<695;y++)for(let x=1410;x<1470;x++)altered.rgba.set([220,220,220,255],(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(altered),/COUNTDOWN_GLYPH_UNVERIFIED/);
  const shifted=imageFor(),copy=new Uint8Array(shifted.rgba);
  for(let y=645;y<745;y++)for(let x=1400;x<1615;x++)shifted.rgba.set(copy.subarray((y*2036+x-5)*4,(y*2036+x-5)*4+4),(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(shifted),/COUNTDOWN_LAYOUT_UNVERIFIED/);
});

test('synthetic one-digit deadline uses the same measured glyph and zero remains expired',()=>{
  for(const [sampleIndex,fromX,toX,width,expected] of [[0,164,36,52,0],[2,167,39,51,9]]){
    const image=imageFor(fixtures.samples[sampleIndex!]),copy=new Uint8Array(image.rgba);
    for(let y=645;y<745;y++)for(let x=1400;x<1615;x++)image.rgba.set([0,0,0,255],(y*2036+x)*4);
    for(let y=645;y<745;y++)for(let x=0;x<width!;x++){
      const source=(y*2036+1380+fromX!+x)*4,target=(y*2036+1380+toX!+x)*4;
      image.rgba.set(copy.subarray(source,source+4),target);
    }
    assert.equal(readCountdownPixels(image).seconds,expected);
  }
});

class Page implements EgoPagePort {
  generation=4;epoch=2;step=9;captureDelay=100;stale=false;version='4.0.51';width=2036;
  data=png(imageFor(fixtures.samples[2]));
  async evaluate(source:unknown,input?:any):Promise<any>{
    if(input?.method==='read')return{pageEpoch:this.epoch,generation:this.generation,lastStep:this.step,freshConnection:true,overflow:false};
    if(String(source).includes('scripts:'))return{width:this.width,height:918,devicePixelRatio:1,scrollX:0,scrollY:0,
      sampledMonoMs:1000,observedAt:'2026-11-05T00:00:00.000Z',scripts:[`https://example.invalid/WebGL-release-${this.version}(test).js`]};
    return 1000+this.captureDelay;
  }
  async cdp(method:string):Promise<any>{assert.equal(method,'Page.captureScreenshot');if(this.stale)this.generation++;return{data:this.data};}
}
test('production screenshot acquisition reads pixels automatically and preserves its starting monotonic anchor',async()=>{
  const page=new Page(),result=await inspectClientCountdown(page);
  assert.equal(result.remainingMs,129000);assert.equal(result.sampledMonoMs,1000);
  assert.equal(result.pageEpoch,2);assert.equal(result.step,9);
});
test('a generation change, slow capture, client-version drift and viewport drift cannot return a usable sample',async()=>{
  const stale=new Page();stale.stale=true;await assert.rejects(inspectClientCountdown(stale),/COUNTDOWN_READBACK_STALE/);
  const delayed=new Page();delayed.captureDelay=2001;await assert.rejects(inspectClientCountdown(delayed),/COUNTDOWN_SAMPLE_STALE/);
  const version=new Page();version.version='4.0.52';await assert.rejects(inspectClientCountdown(version),/CLIENT_VERSION_MISMATCH/);
  const viewport=new Page();viewport.width=2035;await assert.rejects(inspectClientCountdown(viewport),/COUNTDOWN_VIEWPORT_MISMATCH/);
});
