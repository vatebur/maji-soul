import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isMatchResultScreen,isMatchRewardsScreen,confirmMatchResult,startFriendRoom} from '../src/adapters/majsoul/result-screen.ts';
import {png} from './countdown-helpers.ts';
import type {EgoPagePort} from '../src/adapters/majsoul/ego-transport.ts';
const profile=JSON.parse(readFileSync('src/adapters/majsoul/result-screen-profile.json','utf8'));
const linuxProfile=JSON.parse(readFileSync('src/adapters/majsoul/result-screen-profile-linux.json','utf8'));
const roomProfile=JSON.parse(readFileSync('src/adapters/majsoul/room-screen-profile.json','utf8'));
const rewardsMarker=JSON.parse(readFileSync('src/adapters/majsoul/result-rewards-marker.json','utf8'));
const rewardsProfile={...profile,regions:[...profile.regions,rewardsMarker]};
const linuxRewardsMarker=JSON.parse(readFileSync('src/adapters/majsoul/result-rewards-marker-linux.json','utf8'));
const linuxRewardsProfile={...linuxProfile,regions:[...linuxProfile.regions,...linuxRewardsMarker.regions]};
function resultImage(panel=profile){
  const width=2036,height=918,rgba=new Uint8Array(width*height*4);
  for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  for(const {region,white,gold,mask} of panel.regions){
    const bits=Buffer.from(mask,'base64');
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++){
      const bit=(bits[(y*region.width+x)>>3]!>>((y*region.width+x)%8))&1;
      const color=gold?(bit?[235,200,100,255]:[0,0,0,255]):white?(bit?[240,240,240,255]:[0,0,0,255]):(bit?[100,70,60,255]:[255,200,80,255]);
      rgba.set(color,((region.y+y)*width+region.x+x)*4);
    }
  }
  for(const {x,y,rgba:color} of panel.points)rgba.set(color,(y*width+x)*4);
  return{width,height,rgba};
}
test('result confirmation requires both terminal title and confirmation label',()=>{
  const image=resultImage();assert.equal(isMatchResultScreen(image),true);
  for(const {region} of profile.regions){
    const copy={...image,rgba:new Uint8Array(image.rgba)};
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++)copy.rgba.set([0,0,0,255],((region.y+y)*copy.width+region.x+x)*4);
    assert.equal(isMatchResultScreen(copy),false);
  }
});
test('Linux result recognition uses its independently captured title, confirmation glyphs and button anchors',()=>{
  assert.equal(linuxProfile.evidenceKind,'native-client-redacted-glyph-masks');
  assert.match(linuxProfile.sourceSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(linuxProfile.regions.map((entry:any)=>entry.text),['終局','確認']);
  const image=resultImage(linuxProfile);
  assert.equal(isMatchResultScreen(image,profile),false,'Linux confirmation pixels do not satisfy the original Mac mask');
  assert.equal(isMatchResultScreen(image),true);
  assert.equal(isMatchRewardsScreen(image),false,'a Linux reward stage is not inferred from standings');
  for(const {region} of linuxProfile.regions){
    const copy={...image,rgba:new Uint8Array(image.rgba)};
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++)copy.rgba.set([0,0,0,255],((region.y+y)*copy.width+region.x+x)*4);
    assert.equal(isMatchResultScreen(copy),false);
  }
  for(const {x,y} of linuxProfile.points){
    const copy={...image,rgba:new Uint8Array(image.rgba)};
    copy.rgba.set([0,0,0,255],(y*copy.width+x)*4);
    assert.equal(isMatchResultScreen(copy),false);
  }
  assert.equal(isMatchResultScreen({...image,width:2035}),false);
});
test('a captured Linux result confirms once then recognizes the returned room',async()=>{
  let pressed=0;
  const page:EgoPagePort={
    evaluate:async()=>({gameUuid:'linux-ended',matchEnded:true,paused:true,pageEpoch:1,generation:1,matchResult:{result:{players:[{},{},{},{}]}}}),
    cdp:async(method,params)=>{
      if(method==='Emulation.setDeviceMetricsOverride')return{};
      if(method==='Page.captureScreenshot')return{data:png(resultImage(pressed?roomProfile:linuxProfile))};
      assert.equal(method,'Input.dispatchMouseEvent');
      if(params.type==='mousePressed'){
        assert.deepEqual({x:params.x,y:params.y},{x:1685,y:842});pressed++;
      }
      return{};
    },
  };
  await confirmMatchResult(page,'linux-ended');assert.equal(pressed,1);
});
test('Linux mission rewards need the stable replay label plus the title and visible confirmation button',()=>{
  assert.deepEqual(linuxRewardsMarker.regions.map((entry:any)=>entry.text),['查看牌譜']);
  assert.match(linuxRewardsMarker.sourceSha256,/^[a-f0-9]{64}$/);
  const image=resultImage(linuxRewardsProfile);
  assert.equal(isMatchRewardsScreen(image),true);
  assert.equal(isMatchRewardsScreen(resultImage(linuxProfile)),false);
  for(const {region} of linuxRewardsProfile.regions){
    const copy={...image,rgba:new Uint8Array(image.rgba)};
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++)copy.rgba.set([0,0,0,255],((region.y+y)*copy.width+region.x+x)*4);
    assert.equal(isMatchRewardsScreen(copy),false);
  }
});
test('Linux standings and observed mission rewards advance exactly once each',async()=>{
  let pressed=0,samples=0;
  const page:EgoPagePort={
    evaluate:async()=>({gameUuid:'linux-ended',matchEnded:true,paused:true,pageEpoch:1,generation:1,matchResult:{result:{players:[{},{},{},{}]}}}),
    cdp:async(method,params)=>{
      if(method==='Emulation.setDeviceMetricsOverride')return{};
      if(method==='Page.captureScreenshot')return{data:png(resultImage([linuxProfile,linuxProfile,linuxRewardsProfile,linuxRewardsProfile,roomProfile][samples++]!))};
      if(params.type==='mousePressed')pressed++;
      return{};
    },
  };
  await confirmMatchResult(page,'linux-ended');assert.equal(pressed,2);assert.equal(samples,5);
});
test('result confirmation clicks once and refuses a changed match before pressing',async()=>{
  for(const changed of [false,true]){
    const input:string[]=[];let moves=0;
    const page:EgoPagePort={
      evaluate:async()=>({gameUuid:changed&&moves?'other':'match',matchEnded:true,paused:true,pageEpoch:1,generation:1,matchResult:{result:{players:[{},{},{},{}]}}}),
      cdp:async(_method,params)=>{
        if(_method==='Emulation.setDeviceMetricsOverride')return{};
        if(_method==='Page.captureScreenshot')return{data:png(resultImage(input.includes('mouseReleased')?roomProfile:profile))};
        const type=(params as {type:string}).type;input.push(type);if(type==='mouseMoved')moves++;return{};
      },
    };
    if(changed){await assert.rejects(confirmMatchResult(page,'match'),/MATCH_RESULT_SCOPE_CHANGED/);assert.deepEqual(input,['mouseMoved']);}
    else{await confirmMatchResult(page,'match');assert.deepEqual(input,['mouseMoved','mousePressed','mouseReleased']);}
  }
});


test('an already confirmed result in the friend room is not clicked again and native start uses a fresh proof',async()=>{
  const input:string[]=[];
  let generation=5;
  const page:EgoPagePort={evaluate:async()=>({gameUuid:'ended',matchEnded:true,paused:true,pageEpoch:1,generation,matchResult:{result:{players:[{},{},{},{}]}}}),
    cdp:async(method,params)=>{
      if(method==='Emulation.setDeviceMetricsOverride')return{};
      if(method==='Page.captureScreenshot')return{data:png(resultImage(roomProfile))};
      input.push((params as {type:string}).type);return{};
    }};
  await confirmMatchResult(page,'ended');
  assert.deepEqual(input,[]);
  assert.equal(await startFriendRoom(page,{gameUuid:'ended',pageEpoch:1,generation:5}),true);
  assert.deepEqual(input,['mouseMoved','mousePressed','mouseReleased']);
  input.length=0;generation=6;
  assert.equal(await startFriendRoom(page,{gameUuid:'ended',pageEpoch:1,generation:5}),false);
  assert.deepEqual(input,[]);
});

test('terminal confirmation restores the exact glyph viewport before taking pixels',async()=>{
  let calibrated=false,pressed=0;
  const page:EgoPagePort={
    evaluate:async()=>({gameUuid:'ended',matchEnded:true,paused:true,pageEpoch:1,generation:1,
      matchResult:{result:{players:[{},{},{},{}]}}}),
    cdp:async(method,params)=>{
      if(method==='Emulation.setDeviceMetricsOverride'){
        assert.deepEqual(params,{width:2036,height:918,deviceScaleFactor:1,mobile:false});
        calibrated=true;return{};
      }
      if(method==='Page.captureScreenshot'){
        assert.equal(calibrated,true,'native window scaling invalidates the result glyph calibration');
        return{data:png(resultImage(pressed?roomProfile:profile))};
      }
      assert.equal(method,'Input.dispatchMouseEvent');
      if(params.type==='mousePressed')pressed++;
      return{};
    },
  };
  await confirmMatchResult(page,'ended');
  assert.equal(pressed,1);
});

test('terminal confirmation advances standings and mission rewards once each before returning to the room',async()=>{
  assert.equal(isMatchRewardsScreen(resultImage()),false);
  assert.equal(isMatchRewardsScreen(resultImage(rewardsProfile)),true);
  let pressed=0,samples=0;
  const page:EgoPagePort={
    evaluate:async()=>({gameUuid:'ended',matchEnded:true,paused:true,pageEpoch:1,generation:1,
      matchResult:{result:{players:[{},{},{},{}]}}}),
    cdp:async(method,params)=>{
      if(method==='Emulation.setDeviceMetricsOverride')return{};
      if(method==='Page.captureScreenshot'){
        // Retain each submitted screen for one extra sample to prove that
        // a slow transition cannot trigger a second press of the same stage.
        const stage=[profile,profile,rewardsProfile,rewardsProfile,roomProfile][samples++]!;
        return{data:png(resultImage(stage))};
      }
      if(params.type==='mousePressed')pressed++;
      return{};
    },
  };
  await confirmMatchResult(page,'ended');
  assert.equal(pressed,2);assert.equal(samples,5);
});

test('a stalled result screen times out without repeating a submitted confirmation',async t=>{
  let now=0,pressed=0;
  t.mock.method(performance,'now',()=>now+=10_000);
  const page:EgoPagePort={
    evaluate:async()=>({gameUuid:'ended',matchEnded:true,paused:true,pageEpoch:1,generation:1,
      matchResult:{result:{players:[{},{},{},{}]}}}),
    cdp:async(method,params)=>{
      if(method==='Emulation.setDeviceMetricsOverride')return{};
      if(method==='Page.captureScreenshot')return{data:png(resultImage())};
      if(params.type==='mousePressed')pressed++;
      return{};
    },
  };
  await assert.rejects(confirmMatchResult(page,'ended'),/RESULT_SCREEN_NOT_READY/);
  assert.equal(pressed,1);
});
