import { bridgeCall, type EgoPagePort } from '../../adapters/majsoul/ego-transport.ts';
import { decodeScreenshotPng, hasRecoveryTableAnchors, nativeRestoreProof } from '../../adapters/majsoul/auto-win.ts';
import { toolbarPalette } from '../../adapters/majsoul/table-pixels.ts';
import { requireThat } from '../../domain/game/value.ts';
import { setTimeout as delay } from 'node:timers/promises';

export async function openingTableVisible(page:EgoPagePort):Promise<boolean> {
  requireThat(page.cdp,'OPENING_CDP_REQUIRED');
  const shot=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  requireThat(typeof shot?.data==='string' && shot.data.length<=12*1024*1024,'OPENING_SCREENSHOT_INVALID');
  const image=decodeScreenshotPng(Buffer.from(shot.data,'base64'));
  return toolbarPalette(image)!==null && hasRecoveryTableAnchors(image);
}

/** Native restore can finish seconds before Unity renders the table. Admit a
 * worker only after both current-hand data and a scoped table image exist. */
export async function waitForLiveOpening(page:EgoPagePort, gameUuid:string, signal:AbortSignal,
  call=bridgeCall, timeoutMs=60_000, visible=openingTableVisible,
  dismissNotice?: (page:EgoPagePort, signal:AbortSignal)=>Promise<boolean>) {
  const assertReleasedScope=(value:any)=>requireThat(value?.paused===true && value.controlEpoch===0 && value.executorActive===false &&
    Number.isSafeInteger(value.pageEpoch) && value.pageEpoch>0 && Number.isSafeInteger(value.generation) && value.generation>=0 &&
    Number.isSafeInteger(value.nativeRestoreRevision) && value.nativeRestoreRevision>=0,'OPENING_PAGE_UNTRUSTED');
  const until=performance.now()+timeoutMs;
  let openingPageEpoch:number|undefined;
  let nextNoticeCheck=0;
  while(!signal.aborted){
    const read=await call(page,'read');
    if(signal.aborted)return false;
    requireThat(read.gameUuid===gameUuid,'OPENING_GAME_CHANGED');
    requireThat(!read.matchEnded,'MATCH_ENDED_BEFORE_OPENING');
    requireThat(!read.overflow && (!read.reason || ['MATCH_CHANGED','CONNECTION_CHANGED'].includes(read.reason)),'OPENING_PAGE_UNTRUSTED');
    // Sync pauses the bridge and revokes permits. Never issue it while another
    // actor owns control, even if that actor currently happens to be paused.
    assertReleasedScope(read);
    openingPageEpoch??=read.pageEpoch;
    requireThat(read.pageEpoch===openingPageEpoch,'OPENING_PAGE_UNTRUSTED');
    // The notice may arrive after admission started, while no match monitor
    // exists yet. Check only the released owner scope and re-read everything
    // after a click: the native client can restore the hand in its callback.
    if(dismissNotice && read.connected && performance.now()>=nextNoticeCheck){
      nextNoticeCheck=performance.now()+1_000;
      const dismissed=await dismissNotice(page,signal);
      if(signal.aborted)return false;
      requireThat(performance.now()<until,'GAME_OPENING_TIMEOUT');
      if(dismissed)continue;
    }
    if(read.authSummary && read.connected && nativeRestoreProof(read)){
      try{
        const raw=await call(page,'sync');
        if(signal.aborted)return false;
        requireThat(raw.gameUuid===gameUuid,'OPENING_GAME_CHANGED');
        requireThat(!raw.is_end,'MATCH_ENDED_BEFORE_OPENING');
        if(raw.game_restore?.actions?.some((a:any)=>a.name==='ActionNewRound') && !signal.aborted && await visible(page)){
          if(signal.aborted)return false;
          const after=await call(page,'read');
          if(signal.aborted)return false;
          requireThat(after.gameUuid===gameUuid,'OPENING_GAME_CHANGED');
          requireThat(!after.matchEnded,'MATCH_ENDED_BEFORE_OPENING');
          assertReleasedScope(after);
          requireThat(after.pageEpoch===read.pageEpoch && after.connected && !after.overflow &&
            (!after.reason || ['MATCH_CHANGED','CONNECTION_CHANGED'].includes(after.reason)) &&
            after.generation>=read.generation && after.nativeRestoreRevision>=read.nativeRestoreRevision,'OPENING_PAGE_UNTRUSTED');
          // Robots can advance the hand while capture is in flight. A new
          // native restore also invalidates that image. Discard it and collect
          // a new complete sync + visual proof within the original deadline;
          // never treat normal ingress as permission to use the stale image.
          if(after.generation===read.generation && after.nativeRestoreRevision===read.nativeRestoreRevision){
            requireThat(!!nativeRestoreProof(after),'OPENING_PAGE_UNTRUSTED');
            requireThat(performance.now()<until,'GAME_OPENING_TIMEOUT');
            return true;
          }
        }
      }catch(error){
        if(!(error instanceof Error && ['SYNC_RESPONSE_INCOMPLETE','SYNC_HISTORY_INCOMPLETE'].includes(error.message)))throw error;
      }
    }
    requireThat(performance.now()<until,'GAME_OPENING_TIMEOUT');
    try{await delay(150,undefined,{signal});}
    catch(error){if(signal.aborted)return false;throw error;}
  }
  return false;
}
