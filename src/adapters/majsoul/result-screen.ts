import { identifyLobbyScreen, calibratedGameImage, calibratedPoint } from './lobby-screen.ts';
import { readFileSync } from 'node:fs';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { requireThat } from '../../domain/game/value.ts';

interface ResultProfile {
  width:number;height:number;regions:{region:{x:number;y:number;width:number;height:number};white:boolean;gold?:boolean;mask:string}[];
  points:{x:number;y:number;rgba:number[]}[];click:{x:number;y:number};
}
const profile = JSON.parse(readFileSync(new URL('./result-screen-profile.json', import.meta.url), 'utf8')) as ResultProfile;
// Linux renders the confirmation glyphs with a different antialiasing mask.
// Keep whole, independently captured profiles instead of relaxing glyph scores
// or combining an arbitrary title, button and palette across renderers.
const linuxProfile = JSON.parse(readFileSync(new URL('./result-screen-profile-linux.json', import.meta.url), 'utf8')) as ResultProfile;
const rewardsMarker = JSON.parse(readFileSync(new URL('./result-rewards-marker.json', import.meta.url), 'utf8'));
const rewardsProfile = {...profile,regions:[...profile.regions,rewardsMarker]};
// The stable post-standings screen adds the fixed replay label. Task text,
// reward amounts and the animated completion stamp are deliberately excluded.
const linuxRewardsMarker = JSON.parse(readFileSync(new URL('./result-rewards-marker-linux.json', import.meta.url), 'utf8'));
const linuxRewardsProfile = {...linuxProfile,regions:[...linuxProfile.regions,...linuxRewardsMarker.regions]};
export const isMatchRewardsScreen = (image:PixelImage) => [rewardsProfile,linuxRewardsProfile].some(panel=>isMatchResultScreen(image,panel));
export function isMatchResultScreen(image: PixelImage, panel?: ResultProfile): boolean {
  return panel ? matchesResultProfile(image, panel) : [profile, linuxProfile].some(candidate => matchesResultProfile(image, candidate));
}
function matchesResultProfile(image: PixelImage, panel: ResultProfile) {
  if (image.width!==panel.width || image.height!==panel.height) return false;
  if (image.rgba.length!==image.width*image.height*4) return false;
  if (!panel.points.every(({x,y,rgba})=>rgba.every((v,i)=>Math.abs(image.rgba[(y*image.width+x)*4+i]!-v)<=10))) return false;
  return panel.regions.every(({region,white,gold,mask})=>{
    const expected=Buffer.from(mask,'base64');let actualArea=0,expectedArea=0,intersection=0;
    for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++){
      const at=((region.y+y)*image.width+region.x+x)*4;
      const r=image.rgba[at]!,g=image.rgba[at+1]!,b=image.rgba[at+2]!;
      const hit=gold?r>180&&g>140&&b<180:white?Math.min(r,g,b)>200&&Math.max(r,g,b)-Math.min(r,g,b)<30:r<150&&g<115&&b<115;
      const bit=((expected[(y*region.width+x)>>3]??0)>>((y*region.width+x)%8))&1;
      actualArea+=Number(hit);expectedArea+=bit;intersection+=Number(hit)*bit;
    }
    return expectedArea>100 && 2*intersection/(actualArea+expectedArea)>=.97;
  });
}

/** Authoritative terminal evidence authorizes at most one confirmation per result stage. */
export async function confirmMatchResult(page: EgoPagePort, gameUuid: string) {
  requireThat(page.cdp, 'RESULT_SCREEN_CDP_REQUIRED');
  const assertTerminal = (value:any) => requireThat(value.gameUuid===gameUuid && value.matchEnded && value.paused &&
    value.matchResult?.result?.players?.length===4, 'MATCH_RESULT_SCOPE_CHANGED');
  const until=performance.now()+30_000;
  const confirmed=new Set<string>();
  for(;;){
    const before=await bridgeCall(page,'read');assertTerminal(before);
    // Result glyphs use the exact table calibration. Resizing to the native
    // window and scaling back changes their antialiasing enough to reject them.
    await page.cdp('Emulation.setDeviceMetricsOverride',{width:profile.width,height:profile.height,deviceScaleFactor:1,mobile:false});
    const screenshot=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    const original=decodeScreenshotPng(Buffer.from(screenshot.data,'base64'));
    if(['home','room'].includes(identifyLobbyScreen(original)))return;
    const pixels=calibratedGameImage(original);
    const click=calibratedPoint(original,profile.click);
    if(isMatchResultScreen(pixels,roomProfile))return;
    const stage=isMatchRewardsScreen(pixels)?'rewards':'standings';
    if(isMatchResultScreen(pixels) && !confirmed.has(stage)){
      await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...click});
      const current=await bridgeCall(page,'read');assertTerminal(current);
      if(current.pageEpoch!==before.pageEpoch || current.generation!==before.generation){
        requireThat(performance.now()<until,'RESULT_SCREEN_NOT_READY');
        continue;
      }
      await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',...click,button:'left',clickCount:1});
      await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...click,button:'left',clickCount:1});
      // Friendly matches can show mission rewards after standings. Wait for
      // that distinct screen or the room; never press the same stage twice.
      confirmed.add(stage);
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
