import { createHash } from 'node:crypto';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { COUNTDOWN_GLYPHS } from './countdown-glyphs.ts';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { requireThat } from '../../domain/game/value.ts';

const PROFILE = {
  clientVersion: '4.0.51', width: 2036, height: 918,
  region: { x: 1380, y: 630, width: 250, height: 130 },
  anchors: [
    { x: 268, y: 650, rgb: [139,88,37] },
    { x: 237, y: 729, rgb: [137,85,32] },
    { x: 211, y: 600, rgb: [21,37,67] },
    { x: 263, y: 600, rgb: [21,37,67] },
  ],
} as const;
const TEMPLATE_X: Record<string, number> = { '0':36, '1':51, '2':32, '3':36, '4':35, '5':36, '6':36, '7':44, '8':34, '9':39 };
const TEMPLATE_Y: Record<string, number> = { '0':26, '1':25, '2':25, '3':26, '4':25, '5':24, '6':25, '7':25, '8':23, '9':26 };
const unpack = (base64: string) => {
  const bytes = Buffer.from(base64, 'base64');
  return Uint8Array.from({ length: 32*48 }, (_, i) => (bytes[i>>3]! >> (i%8)) & 1);
};
const templates = COUNTDOWN_GLYPHS.map(glyph => ({ ...glyph, mask: unpack(glyph.bitmapBase64) }));
interface Component { x: number; y: number; width: number; height: number; area: number }

function components(mask: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(mask.length), result: Component[] = [];
  for (let start=0;start<mask.length;start++) {
    if (!mask[start] || seen[start]) continue;
    const queue=[start]; seen[start]=1;
    let minX=width,minY=height,maxX=0,maxY=0;
    for (let index=0;index<queue.length;index++) {
      const at=queue[index]!,x=at%width,y=Math.floor(at/width);
      minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
        const nx=x+dx,ny=y+dy,next=ny*width+nx;
        if (nx>=0 && nx<width && ny>=0 && ny<height && mask[next] && !seen[next]) { seen[next]=1; queue.push(next); }
      }
    }
    // Anti-aliasing can leave isolated pixels. Larger unexpected pieces block.
    if (queue.length>=50) result.push({ x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1,area:queue.length });
  }
  return result.sort((a,b)=>a.x-b.x);
}

function normalized(mask: Uint8Array, glyph: Component): Uint8Array {
  const result=new Uint8Array(32*48);
  for (let y=0;y<48;y++) for (let x=0;x<32;x++) {
    const sx=Math.min(glyph.width-1,Math.floor((x+.5)*glyph.width/32));
    const sy=Math.min(glyph.height-1,Math.floor((y+.5)*glyph.height/48));
    result[y*32+x]=mask[(glyph.y+sy)*PROFILE.region.width+glyph.x+sx]!;
  }
  return result;
}
function dice(a: Uint8Array,b: Uint8Array): number {
  let areaA=0,areaB=0,intersection=0;
  for (let i=0;i<a.length;i++) { areaA+=a[i]!; areaB+=b[i]!; intersection+=a[i]!*b[i]!; }
  return 2*intersection/(areaA+areaB);
}

/** Fixed-layout digit OCR. It never fills missing digits or chooses a low-confidence match. */
export function readCountdownPixels(image: PixelImage) {
  requireThat(image.width===PROFILE.width && image.height===PROFILE.height && image.rgba.length===image.width*image.height*4, 'COUNTDOWN_VIEWPORT_MISMATCH');
  for (const anchor of PROFILE.anchors) {
    const at=(anchor.y*image.width+anchor.x)*4;
    requireThat(image.rgba[at+3]===255 && anchor.rgb.every((channel,i)=>Math.abs(channel-image.rgba[at+i]!)<=4), 'COUNTDOWN_LAYOUT_UNVERIFIED');
  }
  const region=PROFILE.region,mask=new Uint8Array(region.width*region.height);
  // Exclude the possible drawn-tile edge beneath the timer. The complete
  // countdown glyphs occupy y=23..110 in the verified client layout.
  for (let y=15;y<115;y++) for (let x=20;x<235;x++) {
    const at=((region.y+y)*image.width+region.x+x)*4;
    const r=image.rgba[at]!,g=image.rgba[at+1]!,b=image.rgba[at+2]!;
    mask[y*region.width+x]=image.rgba[at+3]===255 && Math.min(r,g,b)>=170 && Math.max(r,g,b)-Math.min(r,g,b)<=15 ? 1 : 0;
  }
  const found=components(mask,region.width,region.height);
  requireThat(found.length>=1 && found.length<=3, 'COUNTDOWN_DIGITS_UNREADABLE');
  // The real one-digit 8 is centered +64px. Captured two-digit 35/95 and
  // three-digit timers retain the original origin; do not infer a +32px shift.
  const lengthOffset=found.length===1 ? 64 : 0;
  const digits=found.map((component,index)=>{
    requireThat(component.area>=800 && component.area<=3000 && component.width>=24 && component.width<=60 && component.height>=80 && component.height<=88,
      'COUNTDOWN_GLYPH_UNVERIFIED');
    const glyph=normalized(mask,component);
    const ranked=templates.map(template=>({ template,score:dice(glyph,template.mask) })).sort((a,b)=>b.score-a.score);
    const best=ranked[0]!,gap=best.score-ranked[1]!.score;
    requireThat(best.score>=.96 && gap>=.18 && Math.abs(component.width-best.template.width)<=2 && Math.abs(component.height-best.template.height)<=2,
      'COUNTDOWN_GLYPH_UNVERIFIED');
    requireThat(Math.abs(component.x-TEMPLATE_X[best.template.digit]!-lengthOffset-index*64)<=2 && Math.abs(component.y-TEMPLATE_Y[best.template.digit]!)<=2,
      'COUNTDOWN_LAYOUT_UNVERIFIED');
    return { value:best.template.digit,score:best.score,runnerUpGap:gap };
  });
  const text=digits.map(digit=>digit.value).join('');
  requireThat(text.length===1 || text[0]!=='0','COUNTDOWN_DIGITS_UNREADABLE');
  const seconds=Number(text); requireThat(seconds>=0 && seconds<=600,'COUNTDOWN_VALUE_UNVERIFIED');
  return { source:'unity-countdown-glyphs-v1' as const,remainingMs:seconds*1000,seconds,digits,
    maskSha256:createHash('sha256').update(mask).digest('hex'),profileVersion:`unity-${PROFILE.clientVersion}/${PROFILE.width}x${PROFILE.height}` };
}

/** Read the actual client pixels, anchoring elapsed time before requesting the screenshot. */
export async function inspectClientCountdown(page: EgoPagePort) {
  requireThat(page.cdp,'COUNTDOWN_CDP_UNAVAILABLE');
  const before=await bridgeCall(page,'read');
  const layout=await page.evaluate(()=>({ width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,
    sampledMonoMs:performance.now(),observedAt:new Date().toISOString(),
    scripts:[...document.scripts].map(script=>script.src).filter(src=>src.includes('WebGL-release-')) }));
  requireThat(layout.width===PROFILE.width && layout.height===PROFILE.height && layout.devicePixelRatio===1 && layout.scrollX===0 && layout.scrollY===0,
    'COUNTDOWN_VIEWPORT_MISMATCH');
  requireThat(Array.isArray(layout.scripts) && layout.scripts.some((src:string)=>src.includes(`release-${PROFILE.clientVersion}(`)), 'CLIENT_VERSION_MISMATCH');
  const screenshot=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  requireThat(typeof screenshot?.data==='string' && screenshot.data.length<=12*1024*1024,'COUNTDOWN_SCREENSHOT_INVALID');
  const result=readCountdownPixels(decodeScreenshotPng(Buffer.from(screenshot.data,'base64')));
  const after=await bridgeCall(page,'read'),completedMonoMs=await page.evaluate(()=>performance.now());
  requireThat(after.pageEpoch===before.pageEpoch && after.generation===before.generation && after.lastStep===before.lastStep && after.freshConnection && !after.overflow,
    'COUNTDOWN_READBACK_STALE');
  requireThat(Number.isFinite(layout.sampledMonoMs) && completedMonoMs>=layout.sampledMonoMs && completedMonoMs-layout.sampledMonoMs<=2_000,
    'COUNTDOWN_SAMPLE_STALE');
  return { ...result,sampledMonoMs:layout.sampledMonoMs as number,observedAt:layout.observedAt as string,
    pageEpoch:after.pageEpoch as number,generation:after.generation as number,step:after.lastStep as number|null };
}
