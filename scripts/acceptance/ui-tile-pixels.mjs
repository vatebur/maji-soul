import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {decodeScreenshotPng,hasRecoveryTableAnchors,classifyAutoWinPixels,DEFAULT_AUTO_WIN_PROFILE} from '../../src/adapters/majsoul/auto-win.ts';

const MAX_DISTANCE=0.19,MIN_RUNNER_MARGIN=0.03;
const TILE=/^(?:[1-9][mps]|[1-7]z|5[mps]r)$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const xFor=i=>i===13?1504:430.5+80.7*i;
const rgba=(im,x,y)=>im.rgba.subarray((Math.round(y)*im.width+Math.round(x))*4,(Math.round(y)*im.width+Math.round(x))*4+4);
function color(p){const [r,g,b,a]=p;if(a!==255)return 4;if(r>110&&r-g>35&&r-b>25)return 2;if(g>65&&g-r>18&&g-b>10)return 3;if(Math.max(r,g,b)<145)return 1;return 0;}
function mask(im,x,y){const out=[];for(let dy=0;dy<98;dy+=2)for(let dx=-34;dx<=34;dx+=2)out.push(color(rgba(im,x+dx,y+dy)));return out;}
function distance(a,b){let error=0,ink=0;for(let i=0;i<a.length;i++){if(a[i]||b[i])ink++;if(a[i]!==b[i])error++;}return ink?error/ink:0;}
function pale(p){return p[3]===255&&Math.min(...p.slice(0,3))>=175&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<22;}
function body(im,x,y){return [[-32,-2],[32,-2],[-32,104],[32,104]].every(([dx,dy])=>pale(rgba(im,x+dx,y+dy)));}
function classifyImage(im,table){
 if(!hasRecoveryTableAnchors(im))throw Error('UI_TABLE_ANCHOR_MISMATCH');
 const found=[];
 for(let slot=0;slot<14;slot++)for(const lifted of [0,-40]){
   const x=xFor(slot),y=803+lifted;if(!body(im,x,y))continue;
   // Compare every distinct tile code, including competitors at another small
   // alignment. Same-code physical copies/templates are not separate runners.
   const scores=new Map();
   for(const dx of [-2,0,2])for(const dy of [-2,0,2]){
     const m=mask(im,x+dx,y+dy);
     for(const t of table){const score=distance(m,t.mask);if(score<(scores.get(t.code)??Infinity))scores.set(t.code,score);}
   }
   const ranked=[...scores].sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0]));
   const [best,runner]=ranked;
   if(!best||!runner||best[1]>MAX_DISTANCE||runner[1]-best[1]<MIN_RUNNER_MARGIN)continue;
   found.push({slot,x,y:lifted?825:850,code:best[0],score:best[1],runnerUpCode:runner[0],runnerUpScore:runner[1],runnerMargin:runner[1]-best[1]});
 }
 return found;
}
export function inspectReadyImage(png){const im=decodeScreenshotPng(png);return {table:hasRecoveryTableAnchors(im),autoWin:classifyAutoWinPixels(im,DEFAULT_AUTO_WIN_PROFILE).state};}

// The operator supplies visually reviewed labels for the visible lower hand
// and the SHA-256 of every private source screenshot in the pinned layout.
export function createTilePixelReader({sourceDirectory,sources,skipSourceName}={}) {
 if(typeof sourceDirectory!=='string'||!sourceDirectory||!Array.isArray(sources)||!sources.length)
   throw Error('UI_TILE_SOURCE_MANIFEST_INVALID');
 const root=resolve(sourceDirectory),pinned=new Map();
 for(const row of sources){
   if(typeof row?.name!=='string'||!/^[a-z0-9-]{1,80}$/.test(row.name)||pinned.has(row.name)||
     typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||
     !Array.isArray(row.labels)||![13,14].includes(row.labels.length)||
     !Array.from(row.labels).every(code=>code===null||typeof code==='string'&&TILE.test(code)))
     throw Error('UI_TILE_SOURCE_MANIFEST_INVALID');
   pinned.set(row.name,{name:row.name,sha256:row.sha256,labels:[...row.labels]});
 }
 if(!pinned.has(skipSourceName))throw Error('UI_TILE_SOURCE_MANIFEST_INVALID');

 async function readPinnedSource({name,sha256:expected}) {
   let bytes;
   try{bytes=await fs.readFile(join(root,`maji-${name}.png`));}catch{throw Error('UI_TILE_SOURCE_UNAVAILABLE');}
   if(sha256(bytes)!==expected)throw Error('UI_TILE_SOURCE_HASH_MISMATCH');
   const image=decodeScreenshotPng(bytes);
   if(image.width!==2036||image.height!==918)throw Error('UI_TILE_SOURCE_LAYOUT_MISMATCH');
   return image;
 }
 async function loadTemplates() {
   const table=[];
   for(const source of pinned.values()){
     const image=await readPinnedSource(source);
     // Turn indicators may obscure centre anchors in a source. The gate on a
     // current input frame still requires every centre anchor.
     for(const [slot,code] of source.labels.entries())if(code)table.push(Object.freeze({
       code,mask:Object.freeze(mask(image,xFor(slot),803)),sourceName:source.name,sha256:source.sha256,
     }));
   }
   return Object.freeze(table);
 }

 let loaded;
 const templates=()=>loaded??=loadTemplates();
 const frames=new Map();
 async function inspectTileBinding(png,code,{drawn=false}={}) {
   if(typeof drawn!=='boolean')throw Error('UI_TILE_BINDING_INVALID');
   if(typeof code!=='string'||!TILE.test(code))throw Error('UI_TILE_CODE_INVALID');
   const pngSha256=sha256(png),table=await templates();
   if(!table.some(t=>t.code===code))throw Error('UI_TILE_TEMPLATE_UNAVAILABLE_'+code);
   let candidates=frames.get(pngSha256);
   if(!candidates){
     candidates=classifyImage(decodeScreenshotPng(png),table);
     if(frames.size>=8)frames.delete(frames.keys().next().value);
     frames.set(pngSha256,candidates);
   }
   const found=candidates.filter(t=>t.code===code&&(t.slot===13)===drawn).sort((a,b)=>a.score-b.score||a.slot-b.slot);
   if(!found.length)throw Error('UI_TILE_PIXELS_UNVERIFIED_'+code);
   return {...found[0],drawn,pngSha256,viewport:{width:2036,height:918,devicePixelRatio:1},templateSource:'root-observed-public-hand-pixels'};
 }
 async function verifySkipPixels(png) {
   const current=decodeScreenshotPng(png);
   if(!hasRecoveryTableAnchors(current))throw Error('UI_TABLE_ANCHOR_MISMATCH');
   const reference=await readPinnedSource(pinned.get(skipSourceName));
   let bad=0,total=0;
   for(let y=660;y<730;y+=2)for(let x=1240;x<1365;x+=2){
     const a=rgba(current,x,y),b=rgba(reference,x,y);
     total++;
     if(a.slice(0,3).some((c,i)=>Math.abs(c-b[i])>30))bad++;
   }
   if(bad/total>0.06)throw Error('UI_SKIP_PIXELS_UNVERIFIED');
   return {x:1302,y:700,pngSha256:sha256(png),score:bad/total};
 }
 return Object.freeze({templates,inspectTileBinding,verifySkipPixels,inspectReadyImage});
}
