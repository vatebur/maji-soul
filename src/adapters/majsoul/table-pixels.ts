import { screenshotPixelRow, type ScreenshotPixels } from '../browser/png.ts';

export interface TablePixelAnchor { x:number; y:number; rgb:[number,number,number]; tolerance:number }
export type ToolbarPalette = 'legacy' | 'linux';

/** Separately measured Unity 4.0.51 render profiles. A whole palette must
 * match; mixing individual colours or widening tolerances is not accepted. */
export const TOOLBAR_PALETTES: Record<ToolbarPalette, TablePixelAnchor[]> = {
  legacy: [
    {x:268,y:650,rgb:[139,88,37],tolerance:4},
    {x:237,y:729,rgb:[137,85,32],tolerance:4},
    {x:211,y:600,rgb:[21,37,67],tolerance:4},
    {x:263,y:600,rgb:[21,37,67],tolerance:4},
  ],
  linux: [
    {x:268,y:650,rgb:[150,99,40],tolerance:4},
    {x:237,y:729,rgb:[148,96,32],tolerance:4},
    {x:211,y:600,rgb:[20,42,77],tolerance:4},
    {x:263,y:600,rgb:[20,42,77],tolerance:4},
  ],
};

export function matchesPixelAnchors(image:ScreenshotPixels,anchors:TablePixelAnchor[]):boolean {
  return anchors.every(anchor=>{
    const pixel=screenshotPixelRow(image,anchor.x,anchor.y,1);
    return pixel[3]===255 && anchor.rgb.every((channel,index)=>
      Math.abs(pixel[index]!-channel)<=anchor.tolerance);
  });
}

export function toolbarPalette(image:ScreenshotPixels):ToolbarPalette|null {
  if(image.width!==2036 || image.height!==918 || ('rgba' in image ? image.rgba.length!==2036*918*4 : image.kind!=='regions'))return null;
  for(const name of ['legacy','linux'] as const)if(matchesPixelAnchors(image,TOOLBAR_PALETTES[name]))return name;
  return null;
}

/** Four flat centre-frame edges visible across the captured Linux opening
 * animation and active-seat glow. Unsupported overlays still fail closed. */
export const LINUX_TABLE_FRAME:TablePixelAnchor[] = [[896,343],[999,449],[1135,335],[1080,280]]
  .map(([x,y])=>({x:x!,y:y!,rgb:[78,76,88],tolerance:4}));
