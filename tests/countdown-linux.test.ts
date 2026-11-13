import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCountdownPixels, classifyLinuxBankGlyph } from '../src/adapters/majsoul/countdown.ts';
import { LINUX_COUNTDOWN_GLYPHS } from '../src/adapters/majsoul/countdown-glyphs-linux.ts';
import { TOOLBAR_PALETTES } from '../src/adapters/majsoul/table-pixels.ts';
import type { PixelImage } from '../src/adapters/majsoul/auto-win.ts';
import { imageFor } from './countdown-helpers.ts';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/countdown/linux-masks.json',import.meta.url),'utf8'));
function linuxImage(sample=fixture.samples[0]):PixelImage {
  const image:PixelImage={width:2036,height:918,rgba:new Uint8Array(2036*918*4)};
  for(let i=3;i<image.rgba.length;i+=4)image.rgba[i]=255;
  for(const a of TOOLBAR_PALETTES.linux)image.rgba.set([...a.rgb,255],(a.y*2036+a.x)*4);
  const packed=Buffer.from(sample.bitmapBase64,'base64');
  for(let i=0;i<250*130;i++)if(packed[i>>3]!>>(i%8)&1){
    const x=i%250,y=Math.floor(i/250);
    image.rgba.set(sample.kind==='bank-only'?[240,190,90,255]:[220,220,220,255],((630+y)*2036+1380+x)*4);
  }
  if(sample.bankBitmapBase64){
    const bank=Buffer.from(sample.bankBitmapBase64,'base64');
    for(let i=0;i<122*62;i++)if(bank[i>>3]!>>(i%8)&1){
      const x=i%122,y=Math.floor(i/122);
      image.rgba.set([240,190,90,255],((680+y)*2036+1544+x)*4);
    }
  }
  return image;
}

test('real Linux timer masks keep measured digit geometry and strict confidence',()=>{
  assert.equal(fixture.evidenceKind,'linux-current-client-glyph-extraction');
  for(const sample of fixture.samples){
    const result=readCountdownPixels(linuxImage(sample),sample.readBank??true);
    assert.equal(result.seconds,sample.expectedSeconds,sample.name);
    assert.equal(result.remainingMs,sample.kind==='bank-only'?0:sample.expectedSeconds*1000);
    assert.equal(result.bankRemainingMs,sample.kind==='bank-only'?sample.expectedSeconds*1000:
      sample.readBank===false?undefined:sample.expectedBankSeconds*1000);
    assert.ok(result.profileVersion.endsWith('/linux'));
    assert.ok(result.digits.every(digit=>digit.score>=.96&&digit.runnerUpGap>=.18));
  }
});

test('Linux palette requires its complete measured group and never adopts legacy digit pixels',()=>{
  const mixed=linuxImage(),a=TOOLBAR_PALETTES.legacy[0]!;
  mixed.rgba.set([...a.rgb,255],(a.y*2036+a.x)*4);
  assert.throws(()=>readCountdownPixels(mixed,true),/COUNTDOWN_LAYOUT_UNVERIFIED/);
  const legacy=imageFor();
  for(const a of TOOLBAR_PALETTES.linux)legacy.rgba.set([...a.rgb,255],(a.y*2036+a.x)*4);
  assert.throws(()=>readCountdownPixels(legacy,true),/COUNTDOWN_GLYPH_UNVERIFIED/);
});

test('held-out real small bank 0 and 2 pass cross-size OCR while ambiguous 3 requires its measured small example',()=>{
  const large=LINUX_COUNTDOWN_GLYPHS.filter(example=>example.kind==='bank-only');
  const heldOut=(digit:string)=>{
    const sample=LINUX_COUNTDOWN_GLYPHS.find(example=>example.kind==='bank'&&example.digit===digit)!;
    assert.ok(sample,`missing real small ${digit}`);
    const bytes=Buffer.from(sample.bitmapBase64,'base64');
    return Uint8Array.from({length:32*48},(_,i)=>(bytes[i>>3]!>>(i%8))&1);
  };
  for(const digit of ['0','2']){
    const result=classifyLinuxBankGlyph(heldOut(digit),large);
    assert.equal(result.value,digit);
    assert.ok(result.score>=.96&&result.runnerUpGap>=.18);
  }
  assert.throws(()=>classifyLinuxBankGlyph(heldOut('3'),large),/COUNTDOWN_BANK_UNREADABLE/);
  assert.equal(classifyLinuxBankGlyph(heldOut('3')).value,'3');
});

test('Linux bank digits reject alteration and unobserved shifts without weakening original checks',()=>{
  const shifted=linuxImage(),copy=new Uint8Array(shifted.rgba);
  for(let y=645;y<745;y++)for(let x=1400;x<1615;x++)shifted.rgba.set(copy.subarray((y*2036+x-5)*4,(y*2036+x-5)*4+4),(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(shifted,true),/COUNTDOWN_LAYOUT_UNVERIFIED/);
  const altered=linuxImage();
  for(let y=680;y<695;y++)for(let x=1410;x<1470;x++)altered.rgba.set([240,190,90,255],(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(altered,true),/COUNTDOWN_GLYPH_UNVERIFIED/);
  // Removing the first glyph does not make the captured two-digit origin
  // proof of a single-digit Linux countdown.
  const removed=linuxImage();
  for(let y=645;y<745;y++)for(let x=1400;x<1470;x++)removed.rgba.set([0,0,0,255],(y*2036+x)*4);
  assert.throws(()=>readCountdownPixels(removed,true),/COUNTDOWN_GLYPH_UNVERIFIED/);
});
