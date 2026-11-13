import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareAudienceRoom,roomDriver} from '../src/app/console/room-lifecycle.ts';
import {invitation,invitationCount} from '../src/application/live/recruitment.ts';
import {buildPhase1Fixture} from '../scripts/build-phase1-fixtures.ts';
import type {AutomationView} from '../src/app/console/automation.ts';
const configured=buildPhase1Fixture().events.find(e=>e.type==='RoomVerified')!.payload.room;
configured.rules.displayTimeSetting='5+20';
const page={evaluate:async()=>null};
const mode={mode:2,detail_rule:{time_fixed:5,time_add:20,dora_count:3,init_point:25000}};
function harness(roomMode=mode){
  let now=0,exists=false,humans=1,robots=0,roomId='89160',reloaded=0;
  const patches:Partial<AutomationView>[]=[],fills:number[]=[],removals:number[]=[],clicks:string[]=[],clocks:string[]=[];
  const controller=new AbortController();
  const {dismissNotice:_dismissNotice,...baseDriver}=roomDriver;
  const driver:typeof roomDriver={...baseDriver,now:()=>now,sleep:async(ms)=>{now+=ms;},
    install:async()=>{reloaded++;exists=true;return{} as any;},
    screen:async()=>({screen:'create',width:2036,height:918}),
    click:async(_page,screen)=>{clicks.push(screen);exists=true;},
    create:async(_page,clock,signal)=>{assert.equal(signal,controller.signal);clocks.push(clock);clicks.push('create');exists=true;},
    call:async(_page,method)=>{
      if(method==='read')return{connected:false};
      if(method==='fillRoom'){fills.push(now);robots++;}
      if(method==='clearRoomRobots'){removals.push(now);robots--;}
      if(!exists)throw Error('ROOM_NOT_READY');
      return{roomId,owned:true,maxPlayers:4,humans,robots,playing:false,ready:true,mode:roomMode};
    }};
  return {driver,controller,patches,fills,removals,clicks,clocks,publish:async(p:Partial<AutomationView>)=>{patches.push(p);},
    get now(){return now;},get reloaded(){return reloaded;},set exists(v:boolean){exists=v;},set humans(v:number){humans=v;},set robots(v:number){robots=v;},set roomId(v:string){roomId=v;}};
}
test('every round frees computers left in the same room before starting a fresh countdown',async()=>{
  const h=harness();h.exists=true;h.robots=3;
  const call=h.driver.call;
  h.driver.call=async(p,method,arg)=>{
    const room=await call(p,method,arg);
    if(method==='clearRoomRobots')await h.driver.sleep(400,h.controller.signal);
    return room;
  };
  const publish=async(p:Partial<AutomationView>)=>{
    if(p.status==='recruiting'){
      assert.equal((await call(page,'inspectRoom')).robots,0);
      assert.equal(Date.parse(p.recruitUntil!),h.now+180_000);
    }
    await h.publish(p);
  };
  await prepareAudienceRoom(page,configured,h.controller.signal,publish,h.driver);
  assert.deepEqual(h.removals,[0,400,800]);assert.deepEqual(h.fills,[181_200,181_200,181_200]);
  // Returning from the next match preserves the room ID and its computer occupants.
  h.humans=2;h.robots=2;
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,publish,h.driver);
  assert.equal(room!.rules.computerSeats,2);
  assert.deepEqual(h.removals,[0,400,800,181_200,181_600]);
  assert.deepEqual(h.fills,[181_200,181_200,181_200,362_000,362_000]);
  assert.equal(h.patches.filter(p=>p.status==='recruiting').length,2);
});
test('computers added during recruitment are removed without filling before the deadline',async()=>{
  const h=harness();h.exists=true;const sleep=h.driver.sleep;let added=false;
  h.driver.sleep=async(ms,signal)=>{
    await sleep(ms,signal);
    if(!added && h.now>=60_000){added=true;h.robots=2;h.humans=2;}
  };
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.deepEqual(h.removals,[60_000,60_000]);assert.deepEqual(h.fills,[180_000,180_000]);
  assert.equal(room!.rules.computerSeats,2);
});
test('stopping during computer cleanup never publishes invitations or fills seats',async()=>{
  const h=harness();h.exists=true;h.robots=3;const call=h.driver.call;
  h.driver.call=async(p,method,arg)=>{
    const room=await call(p,method,arg);
    if(method==='clearRoomRobots')h.controller.abort();
    return room;
  };
  assert.equal(await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),null);
  assert.deepEqual(h.removals,[0]);assert.deepEqual(h.fills,[]);assert.deepEqual(h.patches,[]);
});
test('failed cleanup or a changed room stops recruitment without filling seats',async()=>{
  for(const changed of [false,true]){
    const h=harness();h.exists=true;h.robots=2;const call=h.driver.call;
    h.driver.call=async(p,method,arg)=>{
      const room=await call(p,method,arg);
      return method==='clearRoomRobots'?{...room,robots:2,...(changed?{roomId:'12345'}:{})}:room;
    };
    await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),
      changed?/ROOM_SCOPE_CHANGED/:/ROOM_ROBOT_REMOVE_REJECTED/);
    assert.deepEqual(h.fills,[]);assert.deepEqual(h.patches,[]);
  }
});
test('default creation reads a changing room ID, waits three minutes, then fills only remaining seats',async()=>{
  const h=harness();const sleep=h.driver.sleep;
  h.driver.sleep=async(ms,signal)=>{if(h.now>=60_000)h.humans=3;await sleep(ms,signal);};
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.deepEqual(h.clicks,['create']);assert.equal(room!.roomId,'89160');assert.equal(room!.rules.length,'south');
  assert.equal(room!.rules.displayTimeSetting,'5+20');assert.equal(room!.rules.computerSeats,1);
  assert.deepEqual(h.fills,[180_500]);assert.equal(h.patches.find(p=>p.status==='recruiting')!.roomId,'89160');
});
test('the sixty-second target is verified before recruiting or filling its room',async()=>{
  const target=structuredClone(configured);target.rules.displayTimeSetting='60+0';
  const sixty={...mode,detail_rule:{...mode.detail_rule,time_fixed:60,time_add:0}};
  const h=harness(sixty);
  const room=await prepareAudienceRoom(page,target,h.controller.signal,h.publish,h.driver);
  assert.equal(room!.rules.displayTimeSetting,'60+0');assert.equal(h.now,180_500);assert.deepEqual(h.clocks,['60+0']);
  const wrong=harness();wrong.exists=true;
  await assert.rejects(prepareAudienceRoom(page,target,wrong.controller.signal,wrong.publish,wrong.driver),/DEFAULT_ROOM_RULES_MISMATCH/);
  assert.deepEqual(wrong.patches,[]);assert.deepEqual(wrong.fills,[]);assert.deepEqual(wrong.removals,[]);
});
test('room clock changes in robot responses cannot escape final verification',async()=>{
  for(const stage of ['clearRoomRobots','fillRoom']){
    const h=harness();h.exists=true;if(stage==='clearRoomRobots')h.robots=1;
    const call=h.driver.call;
    h.driver.call=async(p,method,arg)=>{
      const value=await call(p,method,arg);
      return method===stage?{...value,mode:{...mode,detail_rule:{...mode.detail_rule,time_fixed:60,time_add:0}}}:value;
    };
    await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),/DEFAULT_ROOM_RULES_MISMATCH/);
    assert.ok(h.fills.length<=1);
  }
});
test('joining a running game identifies the complete supported clock rather than assuming a long clock',async()=>{
  for(const [fixed,add,clock] of [[5,20,'5+20'],[60,0,'60+0'],[300,0,'300+0'],[10,20,undefined],[60,20,undefined]] as const){
    const h=harness();
    h.driver.call=async(_p,method)=>{
      assert.equal(method,'read');
      return{connected:true,matchEnded:false,authSummary:{roomId:'89160',robotSeatCount:3,
        gameConfig:{mode:{...mode,detail_rule:{...mode.detail_rule,time_fixed:fixed,time_add:add}}}}};
    };
    const result=prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
    if(clock)assert.equal((await result)!.rules.displayTimeSetting,clock);
    else await assert.rejects(result,/FRIEND_ROOM_CLOCK_UNSUPPORTED/);
    assert.deepEqual(h.clicks,[]);assert.deepEqual(h.fills,[]);
  }
});
test('a new room restarts recruitment and cannot fill based on an older room countdown',async()=>{
  const h=harness();h.exists=true;const sleep=h.driver.sleep;
  h.driver.sleep=async(ms,signal)=>{if(h.now===60_000)h.roomId='12345';await sleep(ms,signal);};
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.equal(room!.roomId,'12345');assert.ok(h.fills.every(at=>at>=241_000));
  assert.deepEqual(h.patches.filter(p=>p.status==='recruiting').map(p=>p.roomId),['89160','12345']);
});
test('stop during recruitment never adds robots or starts a match',async()=>{
  const h=harness();h.exists=true;h.driver.sleep=async()=>{h.controller.abort();};
  assert.equal(await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),null);
  assert.deepEqual(h.fills,[]);
});
test('lost game state reloads with the saved login session, then recruits in a fresh room',async()=>{
  const h=harness();h.driver.screen=async()=>({screen:'unknown',width:2036,height:918});
  const call=h.driver.call;h.driver.call=async(p,method,arg)=>method==='read'?{connected:false,lobbyAuthenticated:true}:call(p,method,arg);
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.equal(h.reloaded,1);assert.equal(room!.roomId,'89160');assert.ok(h.fills[0]!>=270_000);
});
test('full human room waits three minutes without adding robots',async()=>{
  const h=harness();h.exists=true;h.humans=4;
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.equal(h.now,180_000);assert.equal(room!.rules.computerSeats,0);assert.deepEqual(h.fills,[]);
});
test('invitations never repeat during a campaign and always speak the actual room digits',()=>{
  const texts=Array.from({length:invitationCount},(_,i)=>invitation('89160',i));
  assert.equal(new Set(texts).size,invitationCount);assert.ok(texts.every(t=>t.includes('8，9，1，6，0')));
});

test('recruitment speech follows playback completion and cancels when leaving the room campaign',async()=>{
  const {ConsoleRuntime}=await import('../src/app/console/runtime.ts');
  const {StorageClient}=await import('../src/adapters/storage/client.ts');
  const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const directory=await mkdtemp(join(tmpdir(),'maji-recruit-'));const store=new StorageClient(join(directory,'state.sqlite'));
  const view:AutomationView={available:true,enabled:true,status:'recruiting',completedMatches:0,sessionId:null,roomId:'12345',recruitUntil:new Date(Date.now()+180_000).toISOString()};
  const spoken:string[]=[];let finish:()=>void=()=>{},playSignal:AbortSignal|undefined;
  const automation={view,start:async()=>{},stop:async()=>{},refresh:async()=>{},close:async()=>{}};
  const runtime=await ConsoleRuntime.open({store,source:{kind:'follow',sessionId:'idle'},voices:[],voiceId:'test',automation,
    speech:{synthesize:async(text)=>text,play:async(text,signal)=>{spoken.push(text);playSignal=signal;await new Promise<void>(r=>{finish=r;signal.addEventListener('abort',r as ()=>void,{once:true});});},release:async()=>{}}});
  try{
    await runtime.tick();await new Promise(r=>setImmediate(r));assert.equal(spoken.length,1);
    await runtime.tick();assert.equal(spoken.length,1);
    finish();await new Promise(r=>setImmediate(r));await runtime.tick();await new Promise(r=>setImmediate(r));
    assert.equal(spoken.length,2);assert.notEqual(spoken[0],spoken[1]);
    view.status='playing';await runtime.tick();assert.equal(playSignal!.aborted,true);
    assert.equal(runtime.projections.obs.subtitle,null);
  }finally{finish();await runtime.close();await store.close();await rm(directory,{recursive:true,force:true});}
});

test('unready viewers keep their seats and expired login recovery is bounded',async()=>{
  const h=harness();h.exists=true;h.humans=4;const call=h.driver.call;
  h.driver.call=async(p,method,arg)=>{const room=await call(p,method,arg);return method==='read'?room:{...room,ready:false};};
  await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),/ROOM_PLAYERS_NOT_READY/);
  assert.deepEqual(h.fills,[]);
  const lost=harness();lost.driver.screen=async()=>({screen:'unknown',width:2036,height:918});let reloads=0;
  lost.driver.install=async()=>{reloads++;return{} as any;};
  await assert.rejects(prepareAudienceRoom(page,configured,lost.controller.signal,lost.publish,lost.driver),/LOGIN_REQUIRED/);
  assert.equal(reloads,0);assert.equal(lost.now,90_000);assert.deepEqual(lost.fills,[]);
});

test('recruitment subtitles survive a previously followed game hand',async()=>{
  const {actorHarness}=await import('./helpers.ts');const {ConsoleRuntime}=await import('../src/app/console/runtime.ts');
  const h=await actorHarness(14);
  const view:AutomationView={available:true,enabled:true,status:'recruiting',completedMatches:0,sessionId:null,roomId:'56789',recruitUntil:new Date(Date.now()+180_000).toISOString()};
  const runtime=await ConsoleRuntime.open({store:h.store,source:{kind:'follow',sessionId:h.actor.projection.sessionId},voices:[],voiceId:'test',
    automation:{view,start:async()=>{},stop:async()=>{},refresh:async()=>{},close:async()=>{}},
    speech:{synthesize:async text=>text,play:async(_text,signal)=>new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true})),release:async()=>{}}});
  try{await runtime.tick();await new Promise(r=>setImmediate(r));await runtime.tick();assert.match(runtime.projections.obs.subtitle!.text!,/5[,，]6[,，]7[,，]8[,，]9/);}
  finally{await runtime.close();await h.cleanup();}
});

test('every lobby screen calibration contains a readable native label',async()=>{
  const {readFile}=await import('node:fs/promises');
  const profiles=JSON.parse(await readFile(new URL('../src/adapters/majsoul/lobby-screen-profiles.json',import.meta.url),'utf8'));
  for(const [name,profile] of Object.entries(profiles) as [string,any][]){
    for(const region of profile.regions)assert.ok(Buffer.from(region.mask,'base64').reduce((sum,bit)=>sum+bit,0)>20,`${name} needs visible foreground`);
  }
});

test('manual login can finish during lobby waiting without any page reload',async()=>{
  const h=harness();const sleep=h.driver.sleep;
  h.driver.screen=async()=>({screen:'unknown',width:2036,height:918});
  h.driver.sleep=async(ms,signal)=>{await sleep(ms,signal);if(h.now>=45_000)h.exists=true;};
  const room=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.equal(room!.roomId,'89160');assert.equal(h.reloaded,0);assert.deepEqual(h.clicks,[]);
});

test('authenticated recovery publishes phase progress and reaches its bounded failure without endless reloads',async()=>{
  const h=harness();const call=h.driver.call;
  h.driver.call=async(p,method,arg)=>method==='read'?{connected:false,lobbyAuthenticated:true}:call(p,method,arg);
  h.driver.screen=async()=>({screen:'unknown',width:2036,height:918});
  let reloads=0;h.driver.install=async()=>{reloads++;return{} as any;};
  await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),/LOGIN_REQUIRED/);
  assert.equal(reloads,2);assert.equal(h.now,270_000);
  assert.deepEqual(h.patches.filter(p=>p.lastProgressAt).map(p=>Date.parse(p.lastProgressAt!)),[90_000,180_000]);
});

const noticeScope={connected:false,lobbyAuthenticated:false,paused:true,executorActive:false,controlEpoch:0,pageEpoch:2,generation:3,gameUuid:null};
test('a positively confirmed ended-game notice allows preparation to continue without a reload',async()=>{
  const h=harness(),call=h.driver.call;let dismissals=0;
  h.driver.call=async(p,method,arg)=>method==='read'?{...noticeScope}:call(p,method,arg);
  h.driver.screen=async()=>({screen:'unknown',width:1919,height:992});
  h.driver.dismissNotice=async(_page,signal)=>{assert.equal(signal,h.controller.signal);dismissals++;h.exists=true;return true;};
  const prepared=await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver);
  assert.equal(prepared!.roomId,'89160');assert.equal(dismissals,1);assert.equal(h.reloaded,0);assert.deepEqual(h.clicks,[]);
  assert.deepEqual(h.fills,[180_000,180_000,180_000]);
});

test('deferring a notice sample does not renew the preparation deadline or claim progress',async()=>{
  const h=harness(),call=h.driver.call;let inspections=0;
  h.driver.call=async(p,method,arg)=>method==='read'?{...noticeScope,generation:inspections+3}:call(p,method,arg);
  h.driver.screen=async()=>({screen:'unknown',width:1919,height:992});
  h.driver.dismissNotice=async()=>{inspections++;return false;};
  await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),/LOGIN_REQUIRED/);
  assert.ok(inspections>1);assert.equal(h.now,90_000);assert.equal(h.reloaded,0);
  assert.deepEqual(h.clicks,[]);assert.deepEqual(h.fills,[]);
  assert.equal(h.patches.some(p=>p.lastProgressAt),false);
});

test('an unknown popup or an active executor cannot authorize a notice dismissal or a room click',async()=>{
  for(const executorActive of [false,true]){
    const h=harness(),call=h.driver.call;let inspections=0;
    h.driver.call=async(p,method,arg)=>method==='read'?{...noticeScope,executorActive}:call(p,method,arg);
    h.driver.screen=async()=>({screen:'unknown',width:1919,height:992});
    h.driver.dismissNotice=async()=>{inspections++;return false;};
    await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),/LOGIN_REQUIRED/);
    assert.equal(h.now,90_000);assert.deepEqual(h.clicks,[]);assert.equal(h.reloaded,0);
    assert.equal(inspections>0,!executorActive);
  }
});

test('cancellation after inspecting the unknown lobby prevents dismissal',async()=>{
  const h=harness(),call=h.driver.call;
  h.driver.call=async(p,method,arg)=>method==='read'?{...noticeScope}:call(p,method,arg);
  h.driver.screen=async()=>{h.controller.abort();return{screen:'unknown',width:1919,height:992};};
  h.driver.dismissNotice=async()=>assert.fail('cancelled preparation must not touch the modal');
  assert.equal(await prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),null);
  assert.deepEqual(h.clicks,[]);assert.deepEqual(h.fills,[]);
});

test('a reported dismissal followed by the same unknown screen cannot trigger unbounded repeated dismissals',async()=>{
  const h=harness(),call=h.driver.call;let dismissals=0;
  h.driver.call=async(p,method,arg)=>method==='read'?{...noticeScope}:call(p,method,arg);
  h.driver.screen=async()=>({screen:'unknown',width:1919,height:992});
  h.driver.dismissNotice=async()=>{dismissals++;return true;};
  await assert.rejects(prepareAudienceRoom(page,configured,h.controller.signal,h.publish,h.driver),/LOGIN_REQUIRED/);
  assert.equal(dismissals,1);assert.equal(h.now,90_000);assert.deepEqual(h.clicks,[]);
});
