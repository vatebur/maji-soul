import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isMatchResultScreen,confirmMatchResult,startFriendRoom} from '../src/adapters/majsoul/result-screen.ts';
import {png} from './countdown-helpers.ts';
import type {EgoPagePort} from '../src/adapters/majsoul/ego-transport.ts';
const profile=JSON.parse(readFileSync('src/adapters/majsoul/result-screen-profile.json','utf8'));
const roomProfile=JSON.parse(readFileSync('src/adapters/majsoul/room-screen-profile.json','utf8'));
function resultImage(panel=profile){
  const width=2036,height=918,rgba=new Uint8Array(width*height*4);
  for(let i=3;i<rgba.length;i+=4)rgba[i]=255;
  for(const {region,white,mask} of panel.regions){
    const bits=Buffer.from(mask,'base64');
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++){
      const bit=(bits[(y*region.width+x)>>3]!>>((y*region.width+x)%8))&1;
      const color=white?(bit?[240,240,240,255]:[0,0,0,255]):(bit?[100,70,60,255]:[255,200,80,255]);
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
test('result confirmation clicks once and refuses a changed match before pressing',async()=>{
  for(const changed of [false,true]){
    const input:string[]=[];let moves=0;
    const page:EgoPagePort={
      evaluate:async()=>({gameUuid:changed&&moves?'other':'match',matchEnded:true,paused:true,pageEpoch:1,generation:1,matchResult:{result:{players:[{},{},{},{}]}}}),
      cdp:async(_method,params)=>{
        if(_method==='Page.captureScreenshot')return{data:png(resultImage())};
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
