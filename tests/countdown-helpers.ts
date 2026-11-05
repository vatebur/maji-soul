import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { PixelImage } from '../src/adapters/majsoul/auto-win.ts';

export const fixtures=JSON.parse(readFileSync(new URL('./fixtures/countdown/archived-masks.json',import.meta.url),'utf8'));
export const anchors=[{x:268,y:650,rgb:[139,88,37]},{x:237,y:729,rgb:[137,85,32]},{x:211,y:600,rgb:[21,37,67]},{x:263,y:600,rgb:[21,37,67]}];
export function imageFor(sample=fixtures.samples[0]):PixelImage {
  const image={width:2036,height:918,rgba:new Uint8Array(2036*918*4)};
  for(let i=3;i<image.rgba.length;i+=4)image.rgba[i]=255;
  for(const anchor of anchors)image.rgba.set([...anchor.rgb,255],(anchor.y*image.width+anchor.x)*4);
  const bytes=Buffer.from(sample.bitmapBase64,'base64');
  for(let y=0;y<130;y++)for(let x=0;x<250;x++){
    const bit=y*250+x;if((bytes[bit>>3]!>>(bit%8))&1)image.rgba.set([220,220,220,255],((y+630)*image.width+x+1380)*4);
  }
  return image;
}
export function png(image:PixelImage):string {
  const stride=image.width*4,raw=Buffer.alloc((stride+1)*image.height);
  for(let y=0;y<image.height;y++)raw.set(image.rgba.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);
  const chunk=(type:string,data:Buffer)=>{
    const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4);bytes.set(data,8);
    let crc=0xffffffff;for(const value of bytes.subarray(4,-4)){crc^=value;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
    bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes;
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(image.width);header.writeUInt32BE(image.height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}

