import { bridgeCall, type EgoPagePort } from '../../adapters/majsoul/ego-transport.ts';
import { nativeRestoreProof } from '../../adapters/majsoul/auto-win.ts';
import { requireThat } from '../../domain/game/value.ts';

/** Authentication can precede both native entry and ActionNewRound. Never
 * create an execution session until a complete current-hand restore exists. */
export async function waitForLiveOpening(page:EgoPagePort, gameUuid:string, signal:AbortSignal,
  call=bridgeCall, timeoutMs=60_000) {
  const until=performance.now()+timeoutMs;
  while(!signal.aborted){
    const read=await call(page,'read');
    requireThat(read.gameUuid===gameUuid,'OPENING_GAME_CHANGED');
    requireThat(!read.matchEnded,'MATCH_ENDED_BEFORE_OPENING');
    requireThat(!read.overflow && (!read.reason || ['MATCH_CHANGED','CONNECTION_CHANGED'].includes(read.reason)),'OPENING_PAGE_UNTRUSTED');
    if(read.authSummary && read.connected && nativeRestoreProof(read)){
      try{
        const raw=await call(page,'sync');
        requireThat(raw.gameUuid===undefined || raw.gameUuid===gameUuid,'OPENING_GAME_CHANGED');
        requireThat(!raw.is_end,'MATCH_ENDED_BEFORE_OPENING');
        if(raw.game_restore?.actions?.some((a:any)=>a.name==='ActionNewRound'))return true;
      }catch(error){
        if(!(error instanceof Error && ['SYNC_RESPONSE_INCOMPLETE','SYNC_HISTORY_INCOMPLETE'].includes(error.message)))throw error;
      }
    }
    requireThat(performance.now()<until,'GAME_OPENING_TIMEOUT');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  return false;
}
