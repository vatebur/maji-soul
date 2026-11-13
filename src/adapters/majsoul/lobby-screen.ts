import { readFileSync } from 'node:fs';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { requireThat } from '../../domain/game/value.ts';
const profiles = JSON.parse(readFileSync(new URL('./lobby-screen-profiles.json', import.meta.url), 'utf8')) as Record<string, {
  regions: {x:number;y:number;width:number;height:number;cols:number;rows:number;white:boolean;mask:string}[];
  click:{x:number;y:number};
}>;
export type LobbyScreen = 'home' | 'friend' | 'create' | 'room' | 'unknown';
export function identifyLobbyScreen(image:PixelImage):LobbyScreen {
  // Unity fits a 16:9 canvas inside the viewport, with horizontal or vertical bars.
  const scale=Math.min(image.width/16,image.height/9),w=scale*16,h=scale*9,left=(image.width-w)/2,top=(image.height-h)/2;
  for(const [name,panel] of Object.entries(profiles)) {
    if(panel.regions.every(region=>{
      const mask=Buffer.from(region.mask,'base64');let hit=0,total=0,actual=0;
      for(let y=0;y<region.rows;y++)for(let x=0;x<region.cols;x++){
        const xx=Math.min(image.width-1,Math.round(left+(region.x+x/region.cols*region.width)*w));
        const yy=Math.min(image.height-1,Math.round(top+(region.y+y/region.rows*region.height)*h));
        const i=(yy*image.width+xx)*4,r=image.rgba[i]!,g=image.rgba[i+1]!,b=image.rgba[i+2]!;
        const bit=region.white?r+g+b>540&&r>180:r<150&&g<115&&b<115;
        total+=mask[y*region.cols+x]!;actual+=Number(bit);hit+=Number(bit)*mask[y*region.cols+x]!;
      }
      return total>20 && 2*hit/(total+actual)>.82;
    }))return name as LobbyScreen;
  }
  return 'unknown';
}
export async function readLobbyScreen(page:EgoPagePort) {
  requireThat(page.cdp,'ROOM_SCREEN_CDP_REQUIRED');
  // evaluate uses the browser's actual viewport. Keep input and screenshots in that same coordinate system.
  await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  await page.cdp('Emulation.clearDeviceMetricsOverride',{});
  const shot=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  const image=decodeScreenshotPng(Buffer.from(shot.data,'base64'));
  return {screen:identifyLobbyScreen(image),width:image.width,height:image.height};
}
export async function clickLobbyScreen(page:EgoPagePort, expected:Exclude<LobbyScreen,'unknown'>, beforePress?:()=>Promise<void>) {
  const current=await readLobbyScreen(page);
  requireThat(current.screen===expected,'LOBBY_SCREEN_CHANGED');
  const p=profiles[expected]!.click,scale=Math.min(current.width/16,current.height/9),w=scale*16,h=scale*9;
  const point={x:(current.width-w)/2+p.x*w,y:(current.height-h)/2+p.y*h};
  await page.cdp!('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await beforePress?.();
  for(const type of ['mousePressed','mouseReleased'])await page.cdp!('Input.dispatchMouseEvent',{
    type,...point,button:'left',clickCount:1});
}

/** Map a screen to the existing 2036×918 calibration without including side bars. */
export function calibratedGameImage(image:PixelImage):PixelImage {
  if(image.width===2036 && image.height===918)return image;
  const width=2036,height=918,rgba=new Uint8Array(width*height*4);
  const scale=Math.min(image.width/16,image.height/9),w=scale*16,h=scale*9,left=(image.width-w)/2,top=(image.height-h)/2;
  for(let y=0;y<height;y++)for(let x=202;x<1834;x++){
    const xx=Math.min(image.width-1,Math.round(left+(x-202)/1632*w)),yy=Math.min(image.height-1,Math.round(top+y/918*h));
    rgba.set(image.rgba.subarray((yy*image.width+xx)*4,(yy*image.width+xx)*4+4),(y*width+x)*4);
  }
  return {width,height,rgba};
}
export function calibratedPoint(image:PixelImage,point:{x:number;y:number}) {
  const scale=Math.min(image.width/16,image.height/9),w=scale*16,h=scale*9;
  return{x:(image.width-w)/2+(point.x-202)/1632*w,y:(image.height-h)/2+point.y/918*h};
}


export async function startAudienceRoom(page:EgoPagePort,expected:{pageEpoch:number;generation:number;gameUuid:string|null}) {
  const until=performance.now()+3_000;
  for(;;){
    try{
      await clickLobbyScreen(page,'room',async()=>{
        const current=await bridgeCall(page,'read');
        requireThat(current.paused && current.pageEpoch===expected.pageEpoch && current.generation===expected.generation && current.gameUuid===expected.gameUuid,'ROOM_SCOPE_CHANGED');
      });
      return true;
    }catch(error){
      // Clearing the table viewport can leave one stale render at the old
      // size. This error is raised before any press, so only re-read pixels.
      if(!(error instanceof Error && error.message==='LOBBY_SCREEN_CHANGED' && performance.now()<until))throw error;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
}
