import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptLiveViaNode } from '../src/app/live-broker.ts';
import { COUNTDOWN_CAPTURE_REGION } from '../src/adapters/majsoul/countdown.ts';
import type { BrowserPagePort } from '../src/ports/browser.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';

test('worker automaticTiming RPC reaches the original parent page native region capability',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-countdown-region-broker-'));
  const runtime=join(directory,'worker.mjs');
  await writeFile(runtime,`#!${process.execPath}
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
  const message=JSON.parse(line);
  if(message.kind==='start')process.stdout.write(JSON.stringify({kind:'page',id:'timing',method:'automaticTiming',argument:null})+'\\n');
  if(message.id==='timing'){
    process.stdout.write(JSON.stringify({kind:'result',report:{reply:message}})+'\\n');
    lines.close();process.stdin.destroy();
  }
});
`);
  await chmod(runtime,0o700);
  let regions=0,full=0;
  const page:BrowserPagePort={
    async evaluate(_source,argument){
      if(argument?.method==='sync')return {is_end:false,game_restore:{actions:[{name:'ActionDealTile',payload:{
        operation:{time_fixed:300000,time_add:0,operation_list:[{type:1}]}}}]}};
      if(argument?.method==='read')return {pageEpoch:1,generation:2,lastStep:8,freshConnection:true,overflow:false};
      return {width:2036,height:918,devicePixelRatio:1,scrollX:0,scrollY:0,sampledMonoMs:1000,
        observedAt:new Date().toISOString(),scripts:['https://example.invalid/WebGL-release-4.0.51(test).js']};
    },
    async cdp(){full++;throw Error('UNEXPECTED_FULL_CAPTURE');},
    async captureViewportPng(){full++;throw Error('UNEXPECTED_FULL_CAPTURE');},
    async captureViewportPngRegion(box){
      assert.equal(this,page,'the parent must retain the viewport-owning instance');
      assert.deepEqual(box,COUNTDOWN_CAPTURE_REGION);regions++;
      // Stop before requiring a real browser or pixel fixture. This safe error
      // must return across the real stdio broker, proving where sampling ran.
      throw Error('TEST_NATIVE_REGION_REACHED');
    },
  };
  try{
    const report=await acceptLiveViaNode(page,{room:buildPhase1Fixture().projection.room!,outputDirectory:directory,
      sourceVersion:'contract-only'},runtime);
    assert.equal(report.reply.ok,false);assert.equal(report.reply.code,'TEST_NATIVE_REGION_REACHED');
    assert.equal(regions,1);assert.equal(full,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
