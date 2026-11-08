import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {actorHarness} from './helpers.ts';
import {GameActor} from '../src/application/game/actor.ts';
import {ConsoleRuntime,commandName} from '../src/app/console/runtime.ts';
import type {AutomationPort} from '../src/app/console/automation.ts';
const gameView=(runtime:ConsoleRuntime)=>runtime.projections.console.game;
const intent=()=>({commandId:randomUUID(),issuedAt:new Date().toISOString(),sessionId:null});

test('reset clears old live displays across ticks and process recovery, preserves history, and accepts a fresh game',async()=>{
 const h=await actorHarness(14);
 const old=h.actor.projection.sessionId;
 const automation:AutomationPort={view:{available:true,enabled:false,status:'stopped',completedMatches:0,sessionId:old},
  async start(){},async stop(){},async refresh(){},async close(){}};
 const options={store:h.store,source:{kind:'follow' as const,sessionId:old},voices:[],voiceId:'test',automation};
 let runtime=await ConsoleRuntime.open(options);
 try{
  assert.equal(commandName('/api/display/reset','POST'),'display.reset');
  assert.ok(runtime.projections.console.game);
  const history=await h.store.readDiscards(old);
  assert.ok(history.length>0);
  const command=intent();
  await runtime.command('display.reset',command);
  await runtime.tick();
  assert.equal(runtime.gameSessionId,null);
  assert.equal(runtime.projections.console.game,null);
  assert.equal(runtime.projections.console.room,null);
  assert.equal(runtime.projections.obs.game,null);
  assert.equal(runtime.projections.obs.subtitle,null);
  assert.deepEqual(await h.store.readDiscards(old),history);
  await runtime.command('config.patch',{...intent(),expectedRevision:runtime.configRevision,changes:{output:{theme:'light'}}});
  assert.equal(runtime.gameSessionId,null);
  await runtime.close();
  runtime=await ConsoleRuntime.open(options);
  assert.equal(runtime.projections.console.game,null);
  // The idle worker may have forgotten its last session after a restart.
  automation.view.sessionId=null;
  await runtime.tick();
  assert.equal(runtime.gameSessionId,null);
  const nextActor=await GameActor.open(h.store,'live-reset-next',randomUUID(),{clock:h.clock});
  for(const event of structuredClone(h.fixture.events.slice(0,3))){
   if(event.type==='MatchStarted')event.payload.gameMatchKey='reset-next-game';
   await nextActor.ingest(event);
  }
  await nextActor.idle();
  automation.view.sessionId='live-reset-next';
  await runtime.tick();
  assert.equal(runtime.gameSessionId,'live-reset-next');
  assert.ok(runtime.projections.console.game);
  const freshGame=gameView(runtime);assert.ok(freshGame);
  assert.notEqual(freshGame.matchId,h.actor.projection.state?.matchId);
  // Replaying an old reset request cannot hide a later game.
  await runtime.command('display.reset',command);
  assert.equal(runtime.gameSessionId,'live-reset-next');
 }finally{await runtime.close();await h.cleanup();}
});

test('reset refuses to detach an active or stopping automation worker',async()=>{
 const h=await actorHarness(4);const old=h.actor.projection.sessionId;
 const automation:AutomationPort={view:{available:true,enabled:true,status:'playing',completedMatches:0,sessionId:old},
  async start(){},async stop(){},async refresh(){},async close(){}};
 const runtime=await ConsoleRuntime.open({store:h.store,source:{kind:'follow',sessionId:old},voices:[],voiceId:'test',automation});
 try{
  await assert.rejects(runtime.command('display.reset',intent()),/AUTOMATION_ACTIVE/);
  automation.view.enabled=false;automation.view.status='stopping';
  await assert.rejects(runtime.command('display.reset',intent()),/AUTOMATION_ACTIVE/);
  assert.equal(runtime.gameSessionId,old);
 }finally{await runtime.close();await h.cleanup();}
});
