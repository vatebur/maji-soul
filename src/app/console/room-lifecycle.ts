import { setTimeout as delay } from 'node:timers/promises';
import { bridgeCall, type EgoPagePort } from '../../adapters/majsoul/ego-transport.ts';
import { installLiveBridge } from '../../adapters/majsoul/install.ts';
import { clickLobbyScreen, readLobbyScreen } from '../../adapters/majsoul/lobby-screen.ts';
import { createAudienceRoom } from '../../adapters/majsoul/room-clock-screen.ts';
import { dismissEndedGameNotice, hasEndedGameNoticeScope } from '../../adapters/majsoul/ended-game-notice.ts';
import { requireThat } from '../../domain/game/value.ts';
import type { FriendRoom } from '../../domain/game/types.ts';
import { identifyRoomTimeSetting, roomClockSeconds } from '../../domain/game/room-clock.ts';
import type { AutomationView } from './automation.ts';
export const recruitmentMs=180_000;
interface Driver {
  call: typeof bridgeCall; install: typeof installLiveBridge; screen: typeof readLobbyScreen; click: typeof clickLobbyScreen;
  create: typeof createAudienceRoom;
  now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void>; dismissNotice?: typeof dismissEndedGameNotice;
}
export const roomDriver:Driver={call:bridgeCall,install:installLiveBridge,screen:readLobbyScreen,click:clickLobbyScreen,
  create:createAudienceRoom,
  now:()=>Date.now(),sleep:(ms:number,signal:AbortSignal)=>delay(ms,undefined,{signal}),dismissNotice:dismissEndedGameNotice};
export async function prepareAudienceRoom(page:EgoPagePort,configured:FriendRoom,signal:AbortSignal,
  publish:(patch:Partial<AutomationView>)=>Promise<void>,driver:Driver=roomDriver):Promise<FriendRoom|null> {
  let recoveries=0,until=driver.now()+90_000,clicked: string|null=null,noticeDismissed=false;
  const [targetFixed,targetAdd]=roomClockSeconds(configured.rules.displayTimeSetting);
  const requireTargetRules=(mode:any) => {
    const detail=mode?.detail_rule;
    requireThat([1,2].includes(mode?.mode) && detail?.time_fixed===targetFixed && detail.time_add===targetAdd &&
      detail.dora_count===3 && detail.init_point===25000,'DEFAULT_ROOM_RULES_MISMATCH');
  };
  let roomId:string|null=null,closesAt=0;
  while(!signal.aborted){
    const game=await driver.call(page,'read').catch(()=>null);
    if(game?.authSummary && !game.matchEnded && game.connected && (!game.reason || ['MATCH_CHANGED','CONNECTION_CHANGED'].includes(game.reason))){
      const proof=game.authSummary,mode=proof.gameConfig?.mode;
      if(proof.roomId && [1,2].includes(mode?.mode) && Number.isInteger(proof.robotSeatCount)) {
        const clock=identifyRoomTimeSetting(mode.detail_rule?.time_fixed,mode.detail_rule?.time_add);
        requireThat(clock,'FRIEND_ROOM_CLOCK_UNSUPPORTED');
        await publish({status:'waiting',roomId:proof.roomId,recruitUntil:null});
        return {...configured,roomId:proof.roomId,rules:{...configured.rules,length:mode.mode===2?'south':'east',
          displayTimeSetting:clock!,computerSeats:proof.robotSeatCount}};
      }
      return null;
    }
    let room:any,roomError='';
    try{room=await driver.call(page,'inspectRoom');}
    catch(error){
      if(signal.aborted)return null;
      roomError=error instanceof Error?error.message:'';
      if(!['ROOM_NOT_READY','LOBBY_NOT_READY','BRIDGE_MISSING','CONNECTION_REATTACH_REQUIRED','EGO_PAGE_FAILED','RPC_CONNECTION_CLOSED','RPC_RECEIPT_TIMEOUT'].includes(roomError))throw error;
    }
    if(room){
      requireThat(room.owned && room.maxPlayers===4,'ROOM_OWNER_REQUIRED');
      if(room.playing){requireThat(driver.now()<until,'GAME_START_TIMEOUT');await driver.sleep(500,signal);continue;}
      requireTargetRules(room.mode);
      if(roomId!==room.roomId || driver.now()<closesAt){
        const currentRoomId=room.roomId;
        // Previous matches keep their computers seated. Free those seats before
        // publishing a new invitation, and keep them free throughout recruitment.
        while(!signal.aborted && room.robots>0){
          const before=room.robots;
          room=await driver.call(page,'clearRoomRobots',{roomId:currentRoomId});
          requireThat(room.roomId===currentRoomId && room.owned && !room.playing,'ROOM_SCOPE_CHANGED');
          requireTargetRules(room.mode);
          requireThat(room.robots<before,'ROOM_ROBOT_REMOVE_REJECTED');
        }
        if(signal.aborted)return null;
      }
      if(roomId!==room.roomId){
        roomId=room.roomId;closesAt=driver.now()+recruitmentMs;
        await publish({status:'recruiting',roomId:room.roomId,recruitUntil:new Date(closesAt).toISOString(),sessionId:null});
      }
      if(driver.now()<closesAt){await driver.sleep(Math.min(1000,closesAt-driver.now()),signal);continue;}
      await publish({status:'waiting',recruitUntil:null});
      while(!signal.aborted && room.humans+room.robots<4){
        const before=room.humans+room.robots;
        room=await driver.call(page,'fillRoom',{roomId});
        requireThat(room.roomId===roomId && room.owned,'ROOM_SCOPE_CHANGED');
        requireTargetRules(room.mode);
        requireThat(room.humans+room.robots>before,'ROOM_FILL_REJECTED');
      }
      if(signal.aborted)return null;
      if(!room.ready){
        // Keep real viewers seated while they press Ready; never replace them with robots.
        requireThat(driver.now()<closesAt+120_000,'ROOM_PLAYERS_NOT_READY');
        await driver.sleep(1000,signal);continue;
      }
      return {...configured,roomId:room.roomId,rules:{...configured.rules,length:room.mode.mode===2?'south':'east',
        displayTimeSetting:configured.rules.displayTimeSetting,computerSeats:room.robots as 0|1|2|3}};
    }
    if(roomId){roomId=null;await publish({status:'recovering',roomId:null,recruitUntil:null});until=driver.now()+90_000;}
    const screen=await driver.screen(page);
    if(signal.aborted)return null;
    if(screen.screen==='unknown' && ['ROOM_NOT_READY','LOBBY_NOT_READY'].includes(roomError) && !noticeDismissed &&
        driver.dismissNotice && hasEndedGameNoticeScope(game) && await driver.dismissNotice(page,signal)){
      if(signal.aborted)return null;
      noticeDismissed=true;clicked=null;until=driver.now()+90_000;
      await publish({lastProgressAt:new Date(driver.now()).toISOString()});
      continue;
    }
    if(['home','friend','create'].includes(screen.screen)){
      if(clicked!==screen.screen){
        await publish({status:'creating',roomId:null,recruitUntil:null});
        if(screen.screen==='create')await driver.create(page,configured.rules.displayTimeSetting,signal);
        else await driver.click(page,screen.screen as 'home'|'friend');
        clicked=screen.screen;
      }
    }else clicked=null;
    if(driver.now()>=until){
      // No successful lobby authentication and no recognizable signed-in UI:
      // leave this page untouched so login/verification can finish manually.
      // Retrying reloads here would repeatedly erase the login interaction.
      requireThat(game?.lobbyAuthenticated === true || ['home','friend','create','room'].includes(screen.screen), 'LOGIN_REQUIRED');
      requireThat(recoveries++<2,'LOGIN_REQUIRED');
      await publish({status:'recovering',roomId:null,recruitUntil:null});
      await driver.install(page,true,{akagiEnabled:true});
      // A successfully replaced document is a bounded recovery phase. Tell the
      // supervisor it advanced so its phase watchdog does not preempt the next
      // 90-second lobby deadline or loop forever before LOGIN_REQUIRED.
      await publish({lastProgressAt:new Date(driver.now()).toISOString()});
      until=driver.now()+90_000;clicked=null;
    }
    await driver.sleep(500,signal);
  }
  return null;
}
