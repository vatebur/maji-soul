import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readCountdownPixels} from '../src/adapters/majsoul/countdown.ts';
import {LINUX_COUNTDOWN_GLYPHS} from '../src/adapters/majsoul/countdown-glyphs-linux.ts';
import {TOOLBAR_PALETTES} from '../src/adapters/majsoul/table-pixels.ts';
import type {PixelImage} from '../src/adapters/majsoul/auto-win.ts';

interface Sample {
  name:string;kind:'fixed';readBank:false;expectedSeconds:number;sourceSha256:string;
  sourceKind:'timer-clip';useForTraining:boolean;maskIndex:number;
}
const fixture=JSON.parse(readFileSync(new URL('./fixtures/countdown/linux-fixed60-masks.json',import.meta.url),'utf8')) as {
  samples:Sample[];masks:string[];labelMethod:string;excludedFrames:{name:string;reason:string}[];
};
function imageFor(sample:Sample):PixelImage {
  const rgba=new Uint8Array(2036*918*4);
  for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  for(const anchor of TOOLBAR_PALETTES.linux)rgba.set([...anchor.rgb,255],(anchor.y*2036+anchor.x)*4);
  const packed=Buffer.from(fixture.masks[sample.maskIndex]!,'base64');
  assert.equal(packed.length,Math.ceil(250*130/8));
  for(let i=0;i<250*130;i++)if(packed[i>>3]!>>(i%8)&1)
    rgba.set([220,220,220,255],((630+Math.floor(i/250))*2036+1380+i%250)*4);
  return {width:2036,height:918,rgba};
}
function sampleFor(seconds:number) {return fixture.samples.find(sample=>sample.expectedSeconds===seconds)!;}

test('visually labelled fixed 60-second captures retain separate training and held-out source frames',()=>{
  assert.equal(fixture.samples.length,132);
  assert.deepEqual(fixture.excludedFrames,[{name:'frame-132',reason:'stable=false'}]);
  const training=fixture.samples.filter(sample=>sample.useForTraining),heldOut=fixture.samples.filter(sample=>!sample.useForTraining);
  assert.equal(training.length,18);assert.equal(heldOut.length,114);
  const trainingHashes=new Set(training.map(sample=>sample.sourceSha256));
  const newGlyphs=LINUX_COUNTDOWN_GLYPHS.filter(glyph=>trainingHashes.has(glyph.sourceSha256));
  assert.equal(newGlyphs.length,20);
  for(const sample of fixture.samples){
    assert.match(sample.sourceSha256,/^[a-f0-9]{64}$/);
    assert.equal(sample.sourceKind,'timer-clip');assert.equal(sample.readBank,false);
  }
  for(const sample of heldOut)assert.ok(!LINUX_COUNTDOWN_GLYPHS.some(glyph=>glyph.sourceSha256===sample.sourceSha256),sample.name);
  const coverage=(count:number,index:number)=>[...new Set(newGlyphs.filter(glyph=>glyph.digitCount===count&&glyph.index===index)
    .map(glyph=>glyph.digit))].sort().join('');
  assert.equal(coverage(1,0),'6789');assert.equal(coverage(2,0),'123456');assert.equal(coverage(2,1),'0123456789');
  assert.ok(!LINUX_COUNTDOWN_GLYPHS.some(glyph=>glyph.kind==='fixed'&&glyph.digitCount===1&&glyph.digit==='0'));
  // There is only one captured 60 frame: its geometry is observed, but it is
  // not advertised as an independently held-out 60. Other values have repeats.
  assert.equal(fixture.samples.filter(sample=>sample.expectedSeconds===60).length,1);
});

test('all 132 real fixed-clock masks read exactly, including 114 held-out frames and transition pixels',()=>{
  const values=new Set<number>();
  for(const sample of fixture.samples){
    const result=readCountdownPixels(imageFor(sample));
    assert.equal(result.seconds,sample.expectedSeconds,sample.name);
    assert.equal(result.remainingMs,sample.expectedSeconds*1000);
    assert.equal(result.bankRemainingMs,undefined);
    assert.ok(result.profileVersion.endsWith('/linux'));
    assert.ok(result.digits.every(digit=>digit.score>=.96&&digit.runnerUpGap>=.18),sample.name);
    values.add(sample.expectedSeconds);
  }
  assert.deepEqual([...values].sort((a,b)=>a-b),Array.from({length:60},(_,i)=>i+1));
  // The visibly changing 3/2 frames were never selected as templates. Their
  // original bright masks must pass on their own, without retouching the ghost.
  for(const frame of ['frame-126','frame-128'])assert.equal(fixture.samples.find(sample=>sample.name.includes(frame))!.useForTraining,false);
});

test('new fixed digits preserve measured position, colour, complete anchors and unobserved-column rejection',()=>{
  const shifted=imageFor(sampleFor(60)),original=shifted.rgba.slice();
  for(let y=645;y<745;y++)for(let x=1400;x<1615;x++)
    shifted.rgba.set(original.subarray((y*2036+x-5)*4,(y*2036+x-5)*4+4),(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(shifted),/COUNTDOWN_LAYOUT_UNVERIFIED/);
  const missingFirst=imageFor(sampleFor(60));
  for(let y=645;y<745;y++)for(let x=1400;x<1475;x++)missingFirst.rgba.set([0,0,0,255],(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(missingFirst),/COUNTDOWN_GLYPH_UNVERIFIED/);
  const changedColour=imageFor(sampleFor(60));
  for(let y=645;y<745;y++)for(let x=1400;x<1615;x++){
    const at=(y*2036+x)*4;
    if(changedColour.rgba[at]===220)changedColour.rgba.set([240,190,90,255],at);
  }
  assert.throws(()=>readCountdownPixels(changedColour),/COUNTDOWN_DIGITS_UNREADABLE/);
  for(const anchor of TOOLBAR_PALETTES.linux){
    const incomplete=imageFor(sampleFor(60));incomplete.rgba.set([0,0,0,255],(anchor.y*2036+anchor.x)*4);
    assert.throws(()=>readCountdownPixels(incomplete),/COUNTDOWN_LAYOUT_UNVERIFIED/);
  }
});
