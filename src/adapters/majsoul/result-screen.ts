import { readFileSync } from 'node:fs';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { requireThat } from '../../domain/game/value.ts';

const profile = JSON.parse(readFileSync(new URL('./result-screen-profile.json', import.meta.url), 'utf8')) as {
  width:number;height:number;regions:{region:{x:number;y:number;width:number;height:number};white:boolean;mask:string}[];
  points:{x:number;y:number;rgba:number[]}[];click:{x:number;y:number};
};
export function isMatchResultScreen(image: PixelImage, panel = profile) {
  if (image.width!==panel.width || image.height!==panel.height) return false;
  if (!panel.points.every(({x,y,rgba})=>rgba.every((v,i)=>Math.abs(image.rgba[(y*image.width+x)*4+i]!-v)<=10))) return false;
  return panel.regions.every(({region,white,mask})=>{
    const expected=Buffer.from(mask,'base64');let actualArea=0,expectedArea=0,intersection=0;
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++){
      const at=((region.y+y)*image.width+region.x+x)*4;
      const r=image.rgba[at]!,g=image.rgba[at+1]!,b=image.rgba[at+2]!;
      const hit=white?Math.min(r,g,b)>200&&Math.max(r,g,b)-Math.min(r,g,b)<30:r<150&&g<115&&b<115;
      const bit=((expected[(y*region.width+x)>>3]??0)>>((y*region.width+x)%8))&1;
      actualArea+=Number(hit);expectedArea+=bit;intersection+=Number(hit)*bit;
    }
    return expectedArea>100 && 2*intersection/(actualArea+expectedArea)>=.97;
  });
}

/** Only the authoritative terminal result can authorize this one UI confirmation. */
export async function confirmMatchResult(page: EgoPagePort, gameUuid: string) {
  requireThat(page.cdp, 'RESULT_SCREEN_CDP_REQUIRED');
  const assertTerminal = (value:any) => requireThat(value.gameUuid===gameUuid && value.matchEnded && value.paused &&
    value.matchResult?.result?.players?.length===4, 'MATCH_RESULT_SCOPE_CHANGED');
  const until=performance.now()+30_000;
  for(;;){
    const before=await bridgeCall(page,'read');assertTerminal(before);
    const screenshot=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    const pixels=decodeScreenshotPng(Buffer.from(screenshot.data,'base64'));
    if(isMatchResultScreen(pixels,roomProfile))return;
    if(isMatchResultScreen(pixels)){
      await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...profile.click});
      const current=await bridgeCall(page,'read');assertTerminal(current);
      if(current.pageEpoch!==before.pageEpoch || current.generation!==before.generation){
        requireThat(performance.now()<until,'RESULT_SCREEN_NOT_READY');
        continue;
      }
      await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',...profile.click,button:'left',clickCount:1});
      await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...profile.click,button:'left',clickCount:1});
      return;
    }
    requireThat(performance.now()<until,'RESULT_SCREEN_NOT_READY');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
}


const roomProfile = JSON.parse(readFileSync(new URL('./room-screen-profile.json', import.meta.url), 'utf8')) as typeof profile;
export async function startFriendRoom(page:EgoPagePort, expected:{pageEpoch:number;generation:number;gameUuid:string|null}) {
  requireThat(page.cdp,'RESULT_SCREEN_CDP_REQUIRED');
  const until=performance.now()+30_000;
  for(;;){
    const before=await bridgeCall(page,'read');
    const same=(current:any)=>current.paused && current.pageEpoch===expected.pageEpoch && current.generation===expected.generation && current.gameUuid===expected.gameUuid;
    if(!same(before))return false;
    const screenshot=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    if(isMatchResultScreen(decodeScreenshotPng(Buffer.from(screenshot.data,'base64')),roomProfile)){
      await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...roomProfile.click});
      if(!same(await bridgeCall(page,'read')))return false;
      await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',...roomProfile.click,button:'left',clickCount:1});
      await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...roomProfile.click,button:'left',clickCount:1});
      return true;
    }
    requireThat(performance.now()<until,'ROOM_SCREEN_NOT_READY');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
}
