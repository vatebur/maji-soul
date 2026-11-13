import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {verifyAutoWin,DEFAULT_AUTO_WIN_PROFILE as profile,type AutoWinReadback} from '../src/adapters/majsoul/auto-win.ts';
import type {BrowserPagePort} from '../src/ports/browser.ts';

const region={x:211,y:464,width:58,height:266};
const fixture=JSON.parse(readFileSync('tests/fixtures/auto-win/glyphs.json','utf8')).samples[0];
function png(box:typeof region) {
  const rgba=Buffer.alloc(box.width*box.height*4),glyph=Buffer.from(fixture.rgba,'base64');
  for(let at=3;at<rgba.length;at+=4)rgba[at]=255;
  for(let y=0;y<profile.glyph.height;y++)rgba.set(glyph.subarray(y*profile.glyph.width*4,(y+1)*profile.glyph.width*4),
    ((profile.glyph.y-box.y+y)*box.width+profile.glyph.x-box.x)*4);
  profile.anchors.forEach((anchor,index)=>rgba.set(fixture.anchors[index],((anchor.y-box.y)*box.width+anchor.x-box.x)*4));
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
const regionData=png(region),fullData=png({x:0,y:0,width:2036,height:918});
class Page implements BrowserPagePort {
  state:Record<string,any>={pageEpoch:1,generation:2,lastStep:8,nativeRestoreRevision:3,sourceStream:4,
    gameUuid:'PRIVATE_GAME_IDENTIFIER',handSha256:'PRIVATE_HAND_IDENTIFIER',controlEpoch:5,paused:false,
    connected:true,freshConnection:true,handEnded:false,matchEnded:false,reason:null,overflow:false};
  evaluations:string[]=[];captures=0;reads=0;acknowledgements:AutoWinReadback[]=[];attempted:AutoWinReadback[]=[];
  onLayout?:()=>void;onCapture?:()=>void;
  async evaluate(source:any,argument?:any):Promise<any> {
    this.evaluations.push(argument?.method??'layout');
    if(!argument)this.onLayout?.();
    return runInNewContext(`(${source.toString()})(argument)`,{argument,Error,Date,
      innerWidth:2036,innerHeight:918,devicePixelRatio:1,scrollX:0,scrollY:0,
      document:{scripts:[{src:'https://example.invalid/WebGL-release-4.0.51(test).js'}]},
      window:{__majiBridge:{read:()=>{this.reads++;return {...this.state};},ackAutoWin:(readback:AutoWinReadback)=>{
        this.attempted.push(readback);const age=Date.now()-Date.parse(readback.observedAt);
        if(age<0||age>=1000)throw Error('AUTO_WIN_READBACK_STALE');
        this.acknowledgements.push(readback);return {state:readback.state};
      }}}});
  }
  async cdp(method:string):Promise<any> {assert.equal(method,'Page.captureScreenshot');this.captures++;this.onCapture?.();return {data:fullData};}
  async captureViewportPngRegion(box:typeof region) {assert.deepEqual(box,region);this.captures++;this.onCapture?.();return {data:regionData};}
}

test('atomic verification reuses the initial scope and still rejects every scope change before capture',async()=>{
  const page=new Page();await verifyAutoWin(page,undefined,{atomicAck:true});
  assert.deepEqual(page.evaluations,['read','layout','verifyAutoWinReadback']);assert.equal(page.reads,2);
  for(const key of ['pageEpoch','sourceStream','gameUuid','handSha256','generation','lastStep','nativeRestoreRevision','controlEpoch','paused']){
    const changed=new Page();changed.onLayout=()=>{const value=changed.state[key];changed.state[key]=typeof value==='number'?value+1:typeof value==='boolean'?!value:`${value}-changed`;};
    await assert.rejects(verifyAutoWin(changed,undefined,{atomicAck:true}),/AUTO_WIN_READBACK_STALE/,key);
    assert.equal(changed.attempted.length,0,key);assert.equal(changed.captures,1,key);
  }
});

test('verification timing is off by default and keeps diagnostic read/ACK calls separate',async t=>{
  const previous=process.env.MAJI_TIMING_TRACE;delete process.env.MAJI_TIMING_TRACE;
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  const warn=t.mock.method(console,'warn',()=>{throw Error('UNEXPECTED_DIAGNOSTIC');});
  const page=new Page();await verifyAutoWin(page);
  assert.deepEqual(page.evaluations,['read','read','layout','read','ackAutoWin']);assert.equal(warn.mock.callCount(),0);
});

test('enabled timing reports bounded numeric phase costs and region/full without payloads',async t=>{
  const previous=process.env.MAJI_TIMING_TRACE;process.env.MAJI_TIMING_TRACE='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  const messages:string[]=[];t.mock.method(console,'warn',(message:string)=>{messages.push(message);});
  for(const atomicAck of [true,false])await verifyAutoWin(new Page(),undefined,{atomicAck});
  assert.equal(messages.length,2);
  for(const [index,message]of messages.entries()){
    const trace=JSON.parse(message);
    assert.deepEqual(Object.keys(trace).sort(),['atomicAck','attempts','event','succeeded','totalMs']);
    assert.equal(trace.event,'timing.auto-win-verify');assert.equal(trace.succeeded,true);assert.equal(trace.atomicAck,index===0);
    assert.equal(trace.attempts.length,1);const attempt=trace.attempts[0];
    assert.deepEqual(Object.keys(attempt).sort(),['ackMs','captureMs','decodeMs','mode']);assert.equal(attempt.mode,index===0?'region':'full');
    for(const value of [trace.totalMs,attempt.captureMs,attempt.decodeMs,attempt.ackMs])assert.ok(Number.isFinite(value)&&value>=0);
    assert.ok(trace.totalMs>=attempt.captureMs+attempt.decodeMs+attempt.ackMs);
    assert.ok(!message.includes('PRIVATE_'));assert.ok(!message.includes(fixture.rgba));assert.ok(!message.includes(fixture.rgbaSha256));
  }
});

test('timing preserves the 1s capture timestamp and bounded retry on expired ACK',async t=>{
  const previous=process.env.MAJI_TIMING_TRACE;process.env.MAJI_TIMING_TRACE='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const messages:string[]=[];t.mock.method(console,'warn',(message:string)=>{messages.push(message);});
  const page=new Page(),times:number[]=[];page.onCapture=()=>{times.push(Date.now());t.mock.timers.tick(1000);};
  await assert.rejects(verifyAutoWin(page,undefined,{atomicAck:true}),/AUTO_WIN_READBACK_STALE/);
  assert.equal(page.captures,2);assert.equal(page.acknowledgements.length,0);
  assert.deepEqual(page.attempted.map(readback=>Date.parse(readback.observedAt)),times);
  const trace=JSON.parse(messages[0]!);assert.equal(messages.length,1);assert.equal(trace.succeeded,false);assert.equal(trace.attempts.length,2);
  assert.ok(trace.attempts.every((attempt:any)=>attempt.mode==='region'&&Number.isFinite(attempt.ackMs)));
});

test('diagnostics cannot replace a capture error or interrupt successful verification',async t=>{
  const previous=process.env.MAJI_TIMING_TRACE;process.env.MAJI_TIMING_TRACE='1';
  t.after(()=>{if(previous===undefined)delete process.env.MAJI_TIMING_TRACE;else process.env.MAJI_TIMING_TRACE=previous;});
  t.mock.method(console,'warn',()=>{throw Error('LOGGING_FAILED');});
  assert.equal((await verifyAutoWin(new Page(),undefined,{atomicAck:true})).state,'enabled');
  const page=new Page(),failure=Error('PRIVATE_CAPTURE_FAILURE');page.onCapture=()=>{throw failure;};
  await assert.rejects(verifyAutoWin(page,undefined,{atomicAck:true}),error=>error===failure);
  assert.equal(page.attempted.length,0);
});
