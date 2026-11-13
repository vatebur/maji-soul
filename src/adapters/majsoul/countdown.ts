import { createHash } from 'node:crypto';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { COUNTDOWN_GLYPHS } from './countdown-glyphs.ts';
import { CURRENT_COUNTDOWN_GLYPHS } from './countdown-glyphs-current.ts';
import { LINUX_COUNTDOWN_GLYPHS, type LinuxCountdownGlyph } from './countdown-glyphs-linux.ts';
import { toolbarPalette, type ToolbarPalette } from './table-pixels.ts';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { requireThat } from '../../domain/game/value.ts';

const PROFILE = {
  clientVersion: '4.0.51', width: 2036, height: 918,
  region: { x: 1380, y: 630, width: 250, height: 130 },
} as const;
const TEMPLATE_X: Record<string, number> = { '0':36, '1':51, '2':32, '3':36, '4':35, '5':36, '6':36, '7':44, '8':34, '9':39 };
const TEMPLATE_Y: Record<string, number> = { '0':26, '1':25, '2':25, '3':26, '4':25, '5':24, '6':25, '7':25, '8':23, '9':26 };
const unpack = (base64: string) => {
  const bytes = Buffer.from(base64, 'base64');
  return Uint8Array.from({ length: 32*48 }, (_, i) => (bytes[i>>3]! >> (i%8)) & 1);
};
const templates = [...COUNTDOWN_GLYPHS, ...CURRENT_COUNTDOWN_GLYPHS].map(glyph => ({
  x: TEMPLATE_X[glyph.digit]!, y: TEMPLATE_Y[glyph.digit]!, ...glyph, mask: unpack(glyph.bitmapBase64),
}));
const linuxTemplates=LINUX_COUNTDOWN_GLYPHS.map(glyph=>({...glyph,mask:unpack(glyph.bitmapBase64)}));
function rankGlyph(glyph: Uint8Array) {
  const ranked = templates.map(template => ({ template, score: dice(glyph, template.mask) })).sort((a,b)=>b.score-a.score);
  // Competing examples of the same digit do not reduce its separation from
  // other digits. Geometry is still checked against the winning example.
  return ranked.filter((entry,index)=>ranked.findIndex(other=>other.template.digit===entry.template.digit)===index);
}
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

function normalized(mask: Uint8Array, glyph: Component, stride: number = PROFILE.region.width): Uint8Array {
  const result=new Uint8Array(32*48);
  for (let y=0;y<48;y++) for (let x=0;x<32;x++) {
    const sx=Math.min(glyph.width-1,Math.floor((x+.5)*glyph.width/32));
    const sy=Math.min(glyph.height-1,Math.floor((y+.5)*glyph.height/48));
    result[y*32+x]=mask[(glyph.y+sy)*stride+glyph.x+sx]!;
  }
  return result;
}
function dice(a: Uint8Array,b: Uint8Array): number {
  let areaA=0,areaB=0,intersection=0;
  for (let i=0;i<a.length;i++) { areaA+=a[i]!; areaB+=b[i]!; intersection+=a[i]!*b[i]!; }
  return 2*intersection/(areaA+areaB);
}

function readLinuxDigit(mask:Uint8Array,component:Component,stride:number,
  kind:LinuxCountdownGlyph['kind'],digitCount:number,index:number) {
  const glyph=normalized(mask,component,stride);
  // A shape is supported only in its captured colour, digit count and column.
  // Never infer a new single-digit origin from a two-digit screenshot.
  const ranked=linuxTemplates.filter(template=>template.kind===kind && template.digitCount===digitCount && template.index===index)
    .map(template=>({template,score:dice(glyph,template.mask)})).sort((a,b)=>b.score-a.score);
  const best=ranked[0];
  requireThat(best && best.score>=.96,'COUNTDOWN_GLYPH_UNVERIFIED');
  const runnerUp=Math.max(...[...templates,...linuxTemplates].filter(template=>template.digit!==best.template.digit)
    .map(template=>dice(glyph,template.mask)));
  const gap=best.score-runnerUp;
  requireThat(gap>=.18 && Math.abs(component.width-best.template.width)<=2 && Math.abs(component.height-best.template.height)<=2,
    'COUNTDOWN_GLYPH_UNVERIFIED');
  requireThat(Math.abs(component.x-best.template.x)<=2 && Math.abs(component.y-best.template.y)<=2,'COUNTDOWN_LAYOUT_UNVERIFIED');
  return {value:best.template.digit,score:best.score,runnerUpGap:gap};
}

const linuxBankExamples=LINUX_COUNTDOWN_GLYPHS.filter(example=>example.kind==='bank-only'||example.kind==='bank');
/** The small +bank display uses the existing cross-size OCR design. The
 * supplied examples also permit held-out calibration against real masks. */
export function classifyLinuxBankGlyph(glyph:Uint8Array,
  examples:readonly Pick<LinuxCountdownGlyph,'digit'|'bitmapBase64'>[]=linuxBankExamples) {
  requireThat(glyph.length===32*48,'COUNTDOWN_BANK_UNREADABLE');
  const scores=examples.map(template=>({template,score:dice(glyph,unpack(template.bitmapBase64))})).sort((a,b)=>b.score-a.score);
  const ranked=scores.filter((entry,index)=>scores.findIndex(other=>other.template.digit===entry.template.digit)===index);
  const best=ranked[0],runnerUp=ranked[1];
  requireThat(best && runnerUp,'COUNTDOWN_BANK_UNREADABLE');
  const gap=best.score-runnerUp.score;
  requireThat(best.score>=.96 && gap>=.18,'COUNTDOWN_BANK_UNREADABLE');
  return {value:best.template.digit,score:best.score,runnerUpGap:gap};
}

/** Fixed-layout digit OCR. It never fills missing digits or chooses a low-confidence match. */
const timeBankColor = (r: number, g: number, b: number) => r >= 190 && g >= 115 && g <= 236 && b <= 153 && r - b >= 65;
function readTimeBank(image: PixelImage, palette:ToolbarPalette): number {
  const width = 122, height = 62;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = ((680 + y) * image.width + 1544 + x) * 4;
    const r = image.rgba[at]!, g = image.rgba[at + 1]!, b = image.rgba[at + 2]!;
    mask[y * width + x] = timeBankColor(r,g,b) ? 1 : 0;
  }
  const [plus, ...digits] = components(mask, width, height).filter(component => component.area > 180);
  requireThat(plus && plus.width >= 28 && plus.width <= 36 && plus.height >= 36 && plus.height <= 45 &&
    digits.length >= 1 && digits.length <= 2, 'COUNTDOWN_BANK_UNREADABLE');
  const text = digits.map(component => {
    requireThat(component.height >= 42 && component.height <= 53 && component.width >= 13 && component.width <= 39,
      'COUNTDOWN_BANK_UNREADABLE');
    const glyph = normalized(mask, component, width);
    if(palette==='linux')return classifyLinuxBankGlyph(glyph).value;
    const ranked = rankGlyph(glyph);
    requireThat(ranked[0]!.score >= .90 && ranked[0]!.score - ranked[1]!.score >= .10, 'COUNTDOWN_BANK_UNREADABLE');
    return ranked[0]!.template.digit;
  }).join('');
  const seconds = Number(text);
  requireThat(seconds <= 20 && String(seconds) === text, 'COUNTDOWN_BANK_UNREADABLE');
  return seconds * 1000;
}

export function readCountdownPixels(image: PixelImage, readBank = false) {
  requireThat(image.width===PROFILE.width && image.height===PROFILE.height && image.rgba.length===image.width*image.height*4, 'COUNTDOWN_VIEWPORT_MISMATCH');
  const palette=toolbarPalette(image);
  requireThat(palette,'COUNTDOWN_LAYOUT_UNVERIFIED');
  const region=PROFILE.region,mask=new Uint8Array(region.width*region.height);
  // Exclude the possible drawn-tile edge beneath the timer. The complete
  // countdown glyphs occupy y=23..110 in the verified client layout.
  for (let y=15;y<115;y++) for (let x=20;x<235;x++) {
    const at=((region.y+y)*image.width+region.x+x)*4;
    const r=image.rgba[at]!,g=image.rgba[at+1]!,b=image.rgba[at+2]!;
    mask[y*region.width+x]=image.rgba[at+3]===255 && Math.min(r,g,b)>=170 && Math.max(r,g,b)-Math.min(r,g,b)<=15 ? 1 : 0;
  }
  let found=components(mask,region.width,region.height);
  const bankOnly = readBank && found.length === 0;
  if (bankOnly) {
    for (let y=15;y<115;y++) for (let x=20;x<175;x++) {
      const at=((region.y+y)*image.width+region.x+x)*4;
      mask[y*region.width+x]=image.rgba[at+3]===255 && timeBankColor(image.rgba[at]!,image.rgba[at+1]!,image.rgba[at+2]!) ? 1 : 0;
    }
    found=components(mask,region.width,region.height);
  }
  requireThat(found.length>=1 && found.length<=3, 'COUNTDOWN_DIGITS_UNREADABLE');
  // The real one-digit 8 is centered +64px. Captured two-digit 35/95 and
  // three-digit timers retain the original origin; do not infer a +32px shift.
  const lengthOffset=found.length===1 ? 64 : 0;
  const digits=found.map((component,index)=>{
    requireThat(component.area>=800 && component.area<=3000 && component.width>=24 && component.width<=60 && component.height>=(bankOnly?74:80) && component.height<=88,
      'COUNTDOWN_GLYPH_UNVERIFIED');
    if(palette==='linux')return readLinuxDigit(mask,component,region.width,bankOnly?'bank-only':'fixed',found.length,index);
    const glyph=normalized(mask,component);
    const ranked=rankGlyph(glyph);
    const best=ranked[0]!,gap=best.score-ranked[1]!.score;
    requireThat(best.score>=(bankOnly?.92:.96) && gap>=.18 && Math.abs(component.width-best.template.width)<=(bankOnly?4:2) && Math.abs(component.height-best.template.height)<=(bankOnly?10:2),
      'COUNTDOWN_GLYPH_UNVERIFIED');
    requireThat(Math.abs(component.x-best.template.x-lengthOffset-index*64)<=2 && Math.abs(component.y-best.template.y)<=(bankOnly?6:2),
      'COUNTDOWN_LAYOUT_UNVERIFIED');
    return { value:best.template.digit,score:best.score,runnerUpGap:gap };
  });
  const text=digits.map(digit=>digit.value).join('');
  requireThat(text.length===1 || text[0]!=='0','COUNTDOWN_DIGITS_UNREADABLE');
  const seconds=Number(text); requireThat(seconds>=0 && seconds<=(bankOnly?20:600),'COUNTDOWN_VALUE_UNVERIFIED');
  return { source:'unity-countdown-glyphs-v1' as const,remainingMs:bankOnly?0:seconds*1000,seconds,digits,
    maskSha256:createHash('sha256').update(mask).digest('hex'),...(readBank ? { bankRemainingMs: bankOnly ? seconds*1000 : readTimeBank(image,palette) } : {}),profileVersion:`unity-${PROFILE.clientVersion}/${PROFILE.width}x${PROFILE.height}${palette==='linux'?'/linux':''}` };
}

/** Read the actual client pixels, anchoring elapsed time before requesting the screenshot. */
export async function inspectClientCountdown(page: EgoPagePort, readBank = false) {
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
  const after=await bridgeCall(page,'read'),completedMonoMs=await page.evaluate(()=>performance.now());
  requireThat(after.pageEpoch===before.pageEpoch && after.generation===before.generation && after.lastStep===before.lastStep && after.freshConnection && !after.overflow,
    'COUNTDOWN_READBACK_STALE');
  requireThat(Number.isFinite(layout.sampledMonoMs) && completedMonoMs>=layout.sampledMonoMs && completedMonoMs-layout.sampledMonoMs<=2_000,
    'COUNTDOWN_SAMPLE_STALE');
  const result=readCountdownPixels(decodeScreenshotPng(Buffer.from(screenshot.data,'base64')), readBank);
  return { ...result,sampledMonoMs:layout.sampledMonoMs as number,observedAt:layout.observedAt as string,
    pageEpoch:after.pageEpoch as number,generation:after.generation as number,step:after.lastStep as number|null };
}
