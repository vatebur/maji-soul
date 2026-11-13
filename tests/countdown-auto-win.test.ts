import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectClientCountdown } from '../src/adapters/majsoul/countdown.ts';
import { collectAutomaticTiming } from '../src/adapters/majsoul/automatic-timing.ts';
import { DEFAULT_AUTO_WIN_PROFILE as profile } from '../src/adapters/majsoul/auto-win.ts';
import { fixtures,imageFor,png } from './countdown-helpers.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';

const glyphs=JSON.parse(readFileSync(new URL('./fixtures/auto-win/glyphs.json',import.meta.url),'utf8'));
function jointImage(seconds:number,state:'enabled'|'disabled') {
  const image=imageFor(fixtures.samples.find((sample:any)=>sample.expectedSeconds===seconds));
  const sample=glyphs.samples.find((sample:any)=>sample.expected===state),glyph=profile.glyph,bytes=Buffer.from(sample.rgba,'base64');
  for(let y=0;y<glyph.height;y++)image.rgba.set(bytes.subarray(y*glyph.width*4,(y+1)*glyph.width*4),((y+glyph.y)*image.width+glyph.x)*4);
  profile.anchors.forEach((anchor,index)=>image.rgba.set(sample.anchors[index],(anchor.y*image.width+anchor.x)*4));
  return png(image);
}

class JointPage implements EgoPagePort {
  index=0;windowStart=0;step=10;generation=2;nativeRestoreRevision=3;captures=0;changeNative=false;layoutPending=false;
  images=[jointImage(282,'enabled'),jointImage(274,'disabled')];
  readonly rules={category:1,mode:{mode:2,detail_rule:{time_fixed:300,time_add:0}}};
  get mono(){return 5000+(this.index-1)*8000;}
  get at(){return new Date(Date.UTC(2026,10,13,0,0,(this.index-1)*8,100)).toISOString();}
  async evaluate(source:any,input?:any):Promise<any> {
    if(input?.method==='read')return {pageEpoch:1,generation:this.generation,lastStep:this.step-1,
      nativeRestoreRevision:this.nativeRestoreRevision,sourceStream:0,gameUuid:'joint-game',handSha256:'a'.repeat(64),
      connected:true,freshConnection:true,overflow:false,authSummary:{roomId:'12345',gameConfig:this.rules}};
    if(input?.method==='sync') {
      this.index++;
      return {pageEpoch:1,generation:this.generation,step:this.step,gameUuid:'joint-game',is_end:false,
        requestedMonoMs:this.mono-100,receivedMonoMs:this.mono,receivedAt:new Date(Date.parse(this.at)-100).toISOString(),
        authSummary:{roomId:'12345',gameConfig:this.rules},
        game_restore:{game_state:1,last_pause_time_ms:0,passed_waiting_time:18+(this.index-1-this.windowStart)*8,actions:[
          {name:'ActionNewRound',step:0,payload:{sha256:'a'.repeat(64)}},
          {name:'ActionDealTile',step:this.step-1,payload:{operation:{time_fixed:300000,time_add:0,operation_list:[{type:1}]}}},
        ]}};
    }
    if(String(source).includes('scripts:')) {
      this.layoutPending=true;
      return {width:2036,height:918,devicePixelRatio:1,scrollX:0,scrollY:0,sampledMonoMs:this.mono+100,
        observedAt:this.at,scripts:['https://example.invalid/WebGL-release-4.0.51(test).js']};
    }
    if(this.layoutPending){this.layoutPending=false;return this.mono+200;}
    return this.mono+2200;
  }
  async cdp(method:string):Promise<any> {
    assert.equal(method,'Page.captureScreenshot');this.captures++;
    if(this.changeNative)this.nativeRestoreRevision++;
    return {data:this.images[this.index-1-this.windowStart]};
  }
  nextWindow(){this.step+=2;this.generation++;this.windowStart=this.index;}
}

test('one lossless frame yields countdown and auto-win with the original acquisition time',async()=>{
  const page=new JointPage();page.index=1;
  const sample=await inspectClientCountdown(page);
  assert.equal(page.captures,1);assert.equal(sample.remainingMs,282000);
  assert.equal(sample.autoWinReadback?.state,'enabled');assert.equal(sample.autoWinReadback?.observedAt,page.at);
  assert.equal(sample.autoWinReadback?.rgbaSha256,glyphs.samples.find((s:any)=>s.expected==='enabled').rgbaSha256);
  assert.equal(sample.autoWinReadback?.nativeRestoreRevision,3);assert.equal(sample.autoWinReadback?.step,9);
  page.changeNative=true;
  assert.equal((await inspectClientCountdown(page)).autoWinReadback,null);
});

test('paired and calibrated acquisition return only the latest new image, never a cached switch proof',async()=>{
  const page=new JointPage();
  const pair=await collectAutomaticTiming(page);
  assert.equal(page.captures,2);assert.equal(pair.autoWinReadback?.state,'disabled');
  assert.equal(pair.autoWinReadback?.observedAt,page.at);
  const old=pair.autoWinReadback;
  page.nextWindow();
  const current=await collectAutomaticTiming(page);
  assert.equal(page.captures,3);assert.equal(current.evidence?.samples.length,1);assert.ok(current.evidence?.calibration);
  assert.equal(current.autoWinReadback?.state,'enabled');assert.equal(current.autoWinReadback?.observedAt,page.at);
  assert.notEqual(current.autoWinReadback?.observedAt,old?.observedAt);
  assert.notEqual(current.autoWinReadback?.step,old?.step);
});
