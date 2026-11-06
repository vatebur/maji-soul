import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {png} from '../../tests/countdown-helpers.ts';
import {createTilePixelReader} from './ui-tile-pixels.mjs';

test('pixel binding uses the supplied reviewed source and rejects bytes outside its digest pin',async t=>{
  const sourceDirectory=await mkdtemp(join(tmpdir(),'maji-pixel-source-test-'));
  t.after(()=>rm(sourceDirectory,{recursive:true,force:true}));
  const image={width:2036,height:918,rgba:new Uint8Array(2036*918*4)};
  const put=(x,y,pixel)=>image.rgba.set(pixel,(y*image.width+x)*4);
  for(const [x,y] of [[900,390],[1135,335],[945,440],[1080,280]])put(x,y,[69,67,78,255]);
  for(const [x,ink] of [[431,[0,0,0,255]],[511,[210,30,30,255]]]) {
    for(let y=801;y<=907;y++)for(let dx=-36;dx<=36;dx++) {
      put(x+dx,y,Math.abs(dx)<20&&y>816&&y<896?ink:[220,220,220,255]);
    }
  }
  const frame=Buffer.from(png(image),'base64'),sha256=createHash('sha256').update(frame).digest('hex');
  const path=join(sourceDirectory,'maji-reviewed.png');
  await writeFile(path,frame);
  const options={sourceDirectory,skipSourceName:'reviewed',sources:[{
    name:'reviewed',sha256,labels:['2m','3m',...Array(11).fill(null)],
  }]};
  const reader=createTilePixelReader(options);
  const binding=await reader.inspectTileBinding(frame,'2m');
  assert.equal(binding.slot,0);
  assert.equal(binding.runnerUpCode,'3m');
  assert.equal(binding.pngSha256,sha256);
  assert.equal((await reader.verifySkipPixels(frame)).score,0);

  await writeFile(path,Buffer.concat([frame,Buffer.from([0])]));
  await assert.rejects(createTilePixelReader(options).templates(),{message:'UI_TILE_SOURCE_HASH_MISMATCH'});
});
