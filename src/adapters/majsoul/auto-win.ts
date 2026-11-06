import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { bridgeCall, type EgoPagePort, type AutoWinHandScope } from './ego-transport.ts';
import { requireThat } from '../../domain/game/value.ts';

export interface PixelImage { width: number; height: number; rgba: Uint8Array }
export interface AutoWinProfile {
  schemaVersion: 1; clientVersion: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  button: { x: number; y: number; width: number; height: number };
  /** Glyph pixels and stable toolbar anchors, measured from current-client screenshots. */
  glyph: { x: number; y: number; width: number; height: number };
  anchors: { x: number; y: number; rgb: [number, number, number]; tolerance: number }[];
  enabledHashes?: string[]; disabledHashes?: string[];
  glyphMaskBase64?: string;
}
export interface AutoWinReadback {
  source: 'unity-button-pixels-v1'; state: 'enabled' | 'disabled' | 'unknown';
  observedAt: string; pageEpoch: number; generation: number; step: number | null;
  nativeRestoreRevision:number;rgbaSha256: string; profileVersion: string;
}

export interface NativeRestoreProof {
  pageEpoch:number; restoreMethod:'syncGame'|'enterGame'; hasRestore:boolean;authRequestedMonoMs:number;
  authForwardedMonoMs:number;restoreRequestedMonoMs:number; restoreForwardedMonoMs:number;
  finishRequestedMonoMs:number|null;finishForwardedMonoMs:number|null;
}

/** This is a version-scoped transport prerequisite, not proof that a Unity
 * control is enabled. Only the client's completed restore cycle can satisfy it. */
export function nativeRestoreProof(pageState:any):NativeRestoreProof|null {
  if (!Number.isSafeInteger(pageState?.pageEpoch) || !Array.isArray(pageState?.nativeLifecycleTrace)) return null;
  const events=pageState.nativeLifecycleTrace.filter((event:any)=>event?.owner==='client' && event.pageEpoch===pageState.pageEpoch);
  const auth=events.findLastIndex((event:any)=>event.method==='authGame' && event.phase==='request');
  if (auth<0) return null;
  const cycle=events.slice(auth);
  // A new or overlapping request, incomplete forwarding, failure, or an
  // evicted prefix is deliberately not inferred to be a completed cycle.
  const restoreMethod=cycle.find((event:any)=>['syncGame','enterGame'].includes(event.method))?.method;
  if (!restoreMethod) return null;
  const phases=['request','response','response-forwarded'];
  const groups=['authGame',restoreMethod].map(method=>cycle.filter((event:any)=>event.method===method));
  if (groups.some(group=>group.length!==3 || group.some((event:any,index:number)=>
    event.phase!==phases[index] || index>0 && event.accepted!==true))) return null;
  if (cycle.some((event:any,index:number)=>!Number.isFinite(event.observedMonoMs) || event.observedMonoMs<0 ||
    index>0 && event.observedMonoMs<cycle[index-1].observedMonoMs)) return null;
  const [authentication,restore]=groups;
  const hasRestore=restore[1].hasRestore;
  if (typeof hasRestore!=='boolean' || restore[2].hasRestore!==hasRestore || !hasRestore && restoreMethod!=='enterGame') return null;
  const finish=cycle.filter((event:any)=>event.method==='finishSyncGame');
  if (hasRestore ? cycle.length!==9 || finish.length!==3 || finish.some((event:any,index:number)=>
    event.phase!==phases[index] || index>0 && event.accepted!==true) : cycle.length!==6) return null;
  // A synchronous client response callback may issue its next request before
  // dispatchEvent returns and the preceding response-forwarded is recorded.
  // Require causal response order and every successful forwarding completion.
  if (cycle.indexOf(restore[0])<cycle.indexOf(authentication[1]) || (hasRestore
    ? cycle.indexOf(finish[0])<cycle.indexOf(restore[1]) || cycle.at(-1)!==finish[2]
    : cycle.at(-1)!==restore[2])) return null;
  return {pageEpoch:pageState.pageEpoch,restoreMethod,hasRestore,authRequestedMonoMs:authentication[0].observedMonoMs,
    authForwardedMonoMs:authentication[2].observedMonoMs,restoreRequestedMonoMs:restore[0].observedMonoMs,
    restoreForwardedMonoMs:restore[2].observedMonoMs,finishRequestedMonoMs:hasRestore?finish[0].observedMonoMs:null,
    finishForwardedMonoMs:hasRestore?finish[2].observedMonoMs:null};
}

function assertRecoveryScope(current:any,original:any) {
  requireThat(current.pageEpoch===original.pageEpoch && current.sourceStream===original.sourceStream &&
    current.lastStep===original.lastStep && current.controlEpoch===original.controlEpoch && current.paused &&
    current.connected && current.freshConnection && !current.handEnded && !current.matchEnded && !current.reason && !current.overflow,
  'AUTO_WIN_RECOVERY_NOT_READY');
}

async function waitForNativeRestore(page:EgoPagePort,scope:any):Promise<NativeRestoreProof> {
  const deadline=performance.now()+3000;
  let current=scope;
  for (;;) {
    assertRecoveryScope(current,scope);
    requireThat(current.generation===scope.generation && Array.isArray(current.nativeLifecycleTrace),'AUTO_WIN_RECOVERY_NOT_READY');
    const proof=nativeRestoreProof(current);
    if (proof) return proof;
    requireThat(performance.now()<deadline,'AUTO_WIN_RECOVERY_NOT_READY');
    await new Promise(resolve=>setTimeout(resolve,50));
    current=await bridgeCall(page,'read');
  }
}

/** Current Unity 4.0.51 toolbar, measured from the archived 2036×918 client images.
 * Unsupported layouts block. Only the 和 glyph and toolbar colors are examined. */
export const DEFAULT_AUTO_WIN_PROFILE: AutoWinProfile = {
  schemaVersion:1,clientVersion:'4.0.51',viewport:{width:2036,height:918,devicePixelRatio:1},
  button:{x:215,y:497,width:44,height:45},glyph:{x:218,y:500,width:37,height:40},
  anchors:[
    {x:268,y:650,rgb:[139,88,37],tolerance:4},
    {x:237,y:729,rgb:[137,85,32],tolerance:4},
    {x:211,y:600,rgb:[21,37,67],tolerance:4},
    {x:263,y:600,rgb:[21,37,67],tolerance:4},
    {x:236,y:464,rgb:[56,215,85],tolerance:20},
  ],
  enabledHashes:['fe99ac24496bbf7a364752e74a0722972ce3aee67541d8ecb07f9bae12ad1018','27616b969b9b48c834857a31f3bcf18676f53df3a822fb2a7195a1cd9c93dc54'],
  disabledHashes:['0c9a29c4dfd303e700513efcc64bebc6582d67957ff1dff29e5312871f3316b5'],
  glyphMaskBase64:'AAAAAAAAAAAAAAAAAAAAMAAAAAAfAAAA+AMAAOB/AAAA+AMAAAAAAAAAAAAAAAAYAAAAAAcAAADgDwAOAPwB8AfAP8D/AP5j/D/4H5z/x/+B4//4P/DYD/4HHviB/8ADHwD/eOAD4D8PPgD858EHwA84/AD4Af8/gD/g/wP4B/h/gOcA/wEwHMAHgIMDAAAAcAAAAAAOAAAAwAEAAAA4AAAAAAcAAADgAAAAABwAAACAAQAAAAAAAAA=',
};

/** Public centre-frame geometry in the pinned layout. This positively verifies
 * the visible frame instead of accepting an unrecognised popup. The frame can
 * also exist during an early empty-table restore, so this is NEVER sufficient
 * without the current client's completed native restore cycle. */
export function hasRecoveryTableAnchors(image:PixelImage):boolean {
  if (image.width!==2036 || image.height!==918 || image.rgba.length!==image.width*image.height*4) return false;
  return [[900,390],[1135,335],[945,440],[1080,280]].every(([x,y])=>{
    const offset=(y!*image.width+x!)*4;
    return image.rgba[offset+3]===255 && [69,67,78].every((value,index)=>Math.abs(image.rgba[offset+index]!-value)<=4);
  });
}

/** Deliberately bounded CDP PNG reader: only noninterlaced 8-bit RGB/RGBA screenshots. */
export function decodeScreenshotPng(input: Uint8Array): PixelImage {
  const data = Buffer.from(input);
  requireThat(data.length >= 33 && data.length <= 8 * 1024 * 1024 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'AUTO_WIN_SCREENSHOT_INVALID');
  let width = 0, height = 0, channels = 0, ended = false;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < data.length;) {
    requireThat(offset + 12 <= data.length, 'AUTO_WIN_SCREENSHOT_INVALID');
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    requireThat(offset + length + 12 <= data.length, 'AUTO_WIN_SCREENSHOT_INVALID');
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      requireThat(offset === 8 && length === 13 && body[8] === 8 && [2,6].includes(body[9]!) && body[10] === 0 && body[11] === 0 && body[12] === 0, 'AUTO_WIN_SCREENSHOT_FORMAT');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : 3;
      requireThat(width > 0 && height > 0 && width * height <= 4_000_000, 'AUTO_WIN_SCREENSHOT_LIMIT');
    } else if (type === 'IDAT') chunks.push(body);
    else if (type === 'IEND') { ended = true; break; }
    offset += length + 12;
  }
  requireThat(width && height && ended && chunks.length > 0, 'AUTO_WIN_SCREENSHOT_INVALID');
  const stride = width * channels, expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  requireThat(raw.length === expected, 'AUTO_WIN_SCREENSHOT_INVALID');
  const pixels = new Uint8Array(width * height * channels);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!; requireThat(filter <= 4, 'AUTO_WIN_SCREENSHOT_FORMAT');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= channels ? pixels[at-channels]! : 0;
      const up = y ? pixels[at-stride]! : 0, before = y && x >= channels ? pixels[at-stride-channels]! : 0;
      const predictor = [0,left,up,Math.floor((left+up)/2),paeth(left,up,before)][filter]!;
      pixels[at] = (raw[y*(stride+1)+1+x]! + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width*height; i++) {
    rgba[i*4] = pixels[i*channels]!; rgba[i*4+1] = pixels[i*channels+1]!;
    rgba[i*4+2] = pixels[i*channels+2]!; rgba[i*4+3] = channels === 4 ? pixels[i*channels+3]! : 255;
  }
  return { width, height, rgba };
}

function validProfile(p: AutoWinProfile) {
  requireThat(p?.schemaVersion === 1 && p.clientVersion === '4.0.51', 'AUTO_WIN_PROFILE_UNVERIFIED');
  const { viewport: v, button: b, glyph: g } = p;
  requireThat(v && Number.isInteger(v.width) && Number.isInteger(v.height) && v.width > 0 && v.height > 0 && v.devicePixelRatio === 1, 'AUTO_WIN_PROFILE_UNVERIFIED');
  for (const box of [b,g]) requireThat(box && [box.x,box.y,box.width,box.height].every(Number.isInteger) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= v.width && box.y + box.height <= v.height, 'AUTO_WIN_PROFILE_UNVERIFIED');
  requireThat(g.x >= b.x && g.y >= b.y && g.x+g.width <= b.x+b.width && g.y+g.height <= b.y+b.height && p.anchors?.length >= 4, 'AUTO_WIN_PROFILE_UNVERIFIED');
  for (const a of p.anchors) requireThat(Number.isInteger(a.x) && Number.isInteger(a.y) && a.x>=0 && a.y>=0 && a.x<v.width && a.y<v.height && a.rgb.length===3 && a.rgb.every(c=>Number.isInteger(c)&&c>=0&&c<=255) && a.tolerance>=0 && a.tolerance<=24, 'AUTO_WIN_PROFILE_UNVERIFIED');
  const hashes = [...p.enabledHashes ?? [], ...p.disabledHashes ?? []];
  requireThat(hashes.every(h=>/^[a-f0-9]{64}$/.test(h)) && !(p.enabledHashes ?? []).some(h=>p.disabledHashes?.includes(h)), 'AUTO_WIN_PROFILE_UNVERIFIED');
  if(p.glyphMaskBase64)requireThat(Buffer.from(p.glyphMaskBase64,'base64').length===Math.ceil(g.width*g.height/8),'AUTO_WIN_PROFILE_UNVERIFIED');
}

export function classifyAutoWinPixels(image: PixelImage, profile: AutoWinProfile) {
  validProfile(profile);
  requireThat(image.width === profile.viewport.width && image.height === profile.viewport.height && image.rgba.length === image.width*image.height*4, 'AUTO_WIN_VIEWPORT_MISMATCH');
  const pixel = (x: number,y: number) => image.rgba.subarray((y*image.width+x)*4,(y*image.width+x)*4+4);
  const g = profile.glyph, rows: Uint8Array[] = [];
  let green = 0, grey = 0, opaque = 0, greenHits=0,greenExtra=0,greyHits=0,greyExtra=0;
  const mask=profile.glyphMaskBase64?Buffer.from(profile.glyphMaskBase64,'base64'):null;
  for (let y=g.y;y<g.y+g.height;y++) for (let x=g.x;x<g.x+g.width;x++) {
    const p = pixel(x,y); rows.push(p); const [r,bg,b,a] = [...p] as [number,number,number,number];
    if (a === 255) opaque++;
    const i=(y-g.y)*g.width+x-g.x,expectedGlyph=mask?!!(mask[Math.floor(i/8)]!&(1<<(i%8))):true;
    if (a === 255 && bg >= 130 && bg-r >= 45 && bg-b >= 25) {green++;if(expectedGlyph)greenHits++;else greenExtra++;}
    if (a === 255 && r >= 90 && r <= 210 && bg >= r && bg-r <= 45 && b-bg >= 5 && b-bg <= 55) {grey++;if(expectedGlyph)greyHits++;else greyExtra++;}
  }
  const rgbaSha256 = createHash('sha256').update(Buffer.concat(rows)).digest('hex');
  const anchorsMatch = profile.anchors.every(a => {
    const p = pixel(a.x,a.y); return p[3]===255 && a.rgb.every((c,i)=>Math.abs(c-p[i]!)<=a.tolerance);
  });
  let state: AutoWinReadback['state'] = 'unknown';
  const area = g.width*g.height;
  if (anchorsMatch && opaque===area) {
    if (profile.enabledHashes?.includes(rgbaSha256) || greenHits >= area*0.12 && greenExtra<=area*0.08 && grey <= area*0.04) state='enabled';
    else if (profile.disabledHashes?.includes(rgbaSha256) || greyHits >= area*0.12 && greyExtra<=area*0.08 && green===0) state='disabled';
  }
  return { state, rgbaSha256, features: { green, grey, greenHits,greenExtra,greyHits,greyExtra,anchorsMatch } };
}

/** Screenshot acquisition is automatic; no user-supplied enabled flag is accepted. */
export async function inspectAutoWin(page: EgoPagePort, profile: AutoWinProfile = DEFAULT_AUTO_WIN_PROFILE, requireRecoveryTable=false): Promise<AutoWinReadback> {
  validProfile(profile); requireThat(page.cdp, 'AUTO_WIN_CDP_UNAVAILABLE');
  const before = await bridgeCall(page,'read');
  requireThat(Number.isSafeInteger(before.nativeRestoreRevision) && before.nativeRestoreRevision>=0,'AUTO_WIN_READBACK_STALE');
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio,
    scrollX, scrollY, scripts: [...document.scripts].map(s=>s.src).filter(s=>s.includes('WebGL-release-')) }));
  requireThat(layout.width===profile.viewport.width && layout.height===profile.viewport.height && layout.devicePixelRatio===profile.viewport.devicePixelRatio && layout.scrollX===0 && layout.scrollY===0, 'AUTO_WIN_VIEWPORT_MISMATCH');
  requireThat(layout.scripts.some((s:string)=>s.includes(`release-${profile.clientVersion}(`)), 'CLIENT_VERSION_MISMATCH');
  const observedAt=new Date().toISOString();
  const screenshot = await page.cdp('Page.captureScreenshot',{ format:'png', fromSurface:true, captureBeyondViewport:false });
  requireThat(typeof screenshot?.data==='string' && screenshot.data.length<=12*1024*1024, 'AUTO_WIN_SCREENSHOT_INVALID');
  const pixels=decodeScreenshotPng(Buffer.from(screenshot.data,'base64')),result=classifyAutoWinPixels(pixels,profile);
  const after = await bridgeCall(page,'read');
  requireThat(after.pageEpoch===before.pageEpoch && after.generation===before.generation && after.lastStep===before.lastStep &&
    after.nativeRestoreRevision===before.nativeRestoreRevision &&
    after.connected && after.freshConnection && !after.handEnded && !after.matchEnded && !after.reason && !after.overflow, 'AUTO_WIN_READBACK_STALE');
  requireThat(!requireRecoveryTable || hasRecoveryTableAnchors(pixels),'AUTO_WIN_RECOVERY_NOT_READY');
  return { source:'unity-button-pixels-v1',state:result.state,observedAt,pageEpoch:after.pageEpoch,
    generation:after.generation,step:after.lastStep,nativeRestoreRevision:after.nativeRestoreRevision,
    rgbaSha256:result.rgbaSha256,profileVersion:`unity-${profile.clientVersion}/${profile.viewport.width}x${profile.viewport.height}` };
}

async function waitForRecoveryTable(page:EgoPagePort,profile:AutoWinProfile,scope:any,proof:NativeRestoreProof):Promise<AutoWinReadback> {
  const deadline=performance.now()+3000;
  let previousState:AutoWinReadback['state']='unknown';
  for (;;) {
    let readback:AutoWinReadback|null=null;
    try {readback=await inspectAutoWin(page,profile,true);}
    catch(error) {if (!(error instanceof Error && error.message==='AUTO_WIN_RECOVERY_NOT_READY')) throw error;}
    const current=await bridgeCall(page,'read');
    assertRecoveryScope(current,scope);
    requireThat(current.generation===scope.generation && JSON.stringify(nativeRestoreProof(current))===JSON.stringify(proof),'AUTO_WIN_RECOVERY_NOT_READY');
    requireThat(!readback || current.nativeRestoreRevision===readback.nativeRestoreRevision,'AUTO_WIN_READBACK_STALE');
    // Two actual positive samples with the same known switch state. Neither
    // elapsed time nor the absence of a recognised modal counts as readiness.
    if (readback && readback.state!=='unknown' && readback.state===previousState) return readback;
    previousState=readback?.state ?? 'unknown';
    requireThat(performance.now()<deadline,'AUTO_WIN_RECOVERY_NOT_READY');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}

/** One verified click at most; unknown UI, stale epochs and failed readback close the gate. */
export async function ensureAutoWin(page: EgoPagePort, profile: AutoWinProfile = DEFAULT_AUTO_WIN_PROFILE, enabled = true,
  purpose: 'initialize'|'resume'|'pause-cleanup'|'reconnect'|'new-hand' = 'resume', handScope?:AutoWinHandScope) {
  requireThat(purpose!=='pause-cleanup' || !enabled, 'AUTO_WIN_PURPOSE_INVALID');
  requireThat(purpose==='new-hand' ? !!handScope : handScope===undefined,'AUTO_WIN_PURPOSE_INVALID');
  let recoveryScope:any=null,nativeRestore:NativeRestoreProof|null=null;
  if (purpose!=='pause-cleanup') {
    recoveryScope=await bridgeCall(page,'read');
    if (handScope) requireThat(recoveryScope.pageEpoch===handScope.pageEpoch && recoveryScope.sourceStream===handScope.sourceStream &&
      recoveryScope.generation===handScope.generation && recoveryScope.lastStep===handScope.step,'AUTO_WIN_READBACK_STALE');
    nativeRestore=await waitForNativeRestore(page,recoveryScope);
  }
  let readback=nativeRestore?await waitForRecoveryTable(page,profile,recoveryScope,nativeRestore):await inspectAutoWin(page,profile);
  let clicked=false;
  const assertNativeRestore=(current:any) => {
    if (!nativeRestore) return;
    assertRecoveryScope(current,recoveryScope);
    requireThat((clicked || current.generation===recoveryScope.generation) &&
      JSON.stringify(nativeRestoreProof(current))===JSON.stringify(nativeRestore),'AUTO_WIN_RECOVERY_NOT_READY');
    requireThat(current.nativeRestoreRevision===readback.nativeRestoreRevision,'AUTO_WIN_READBACK_STALE');
  };
  if (nativeRestore) assertNativeRestore(await bridgeCall(page,'read'));
  const desired=enabled?'enabled':'disabled';
  if(readback.state==='unknown') {
    await bridgeCall(page,'ackAutoWin',readback);
    throw Error('AUTO_WIN_READBACK_UNKNOWN');
  }
  if (readback.state!==desired) {
    const scope=await bridgeCall(page,'read');
    const assertScope=(current:any,proof:AutoWinReadback) => {
      assertNativeRestore(current);
      requireThat(current.pageEpoch===scope.pageEpoch && current.sourceStream===scope.sourceStream && current.lastStep===scope.lastStep &&
        current.controlEpoch===scope.controlEpoch && current.paused && current.connected && current.freshConnection &&
        !current.handEnded && !current.matchEnded && !current.reason && !current.overflow &&
        current.pageEpoch===proof.pageEpoch && current.generation===proof.generation && current.lastStep===proof.step &&
        current.nativeRestoreRevision===proof.nativeRestoreRevision,
      'AUTO_WIN_TOGGLE_REQUIRES_PAUSE');
    };
    assertScope(scope,readback);
    const x=profile.button.x+profile.button.width/2,y=profile.button.y+profile.button.height/2;
    await page.cdp!('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    // Moving the pointer crosses an asynchronous CDP boundary. Recheck before
    // pressing so an old disabled readback cannot toggle a replacement page.
    // CDP input is not atomic with this check; post-click scope/readback still applies.
    assertScope(await bridgeCall(page,'read'),readback);
    await page.cdp!('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await page.cdp!('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    clicked=true;
    for (let count=0;count<5;count++) {
      await new Promise(resolve=>setTimeout(resolve,100));
      readback=await inspectAutoWin(page,profile,!!nativeRestore);
      assertScope(await bridgeCall(page,'read'),readback);
      if (readback.state===desired) break;
    }
  }
  requireThat(readback.state===desired,'AUTO_WIN_READBACK_FAILED');
  if (nativeRestore) assertNativeRestore(await bridgeCall(page,'read'));
  const verified=await bridgeCall(page,'ackAutoWin',readback);
  return { ...readback, clicked, verified,...(nativeRestore?{nativeRestore}:{}) };
}

/** Read only: final prepare checks cannot click or accidentally reopen paused control. */
export async function verifyAutoWin(page: EgoPagePort, profile: AutoWinProfile = DEFAULT_AUTO_WIN_PROFILE) {
  const readback=await inspectAutoWin(page,profile);
  const verified=await bridgeCall(page,'ackAutoWin',readback);
  requireThat(readback.state==='enabled','AUTO_WIN_UNVERIFIED');
  return { ...readback,clicked:false,verified };
}
