import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptLivePage } from '../src/app/live.ts';
import { createLiveScenario } from './live-helpers.ts';

test('a configured 60-second room requires the matching server rules before any live action', async t => {
  for (const rules of [[60,0],[300,0],[60,20]]) await t.test(rules.join('+'), async () => {
    const h=await createLiveScenario();
    h.options.room.rules.displayTimeSetting='60+0';
    const evaluate=h.page.evaluate.bind(h.page);
    h.page.evaluate=async(source,argument)=>{
      const method=(argument as {method:string}).method;
      const value=await evaluate(source,argument);
      if(method==='read'){
        Object.assign(value.authSummary.gameConfig.mode.detail_rule,{time_fixed:rules[0],time_add:rules[1]});
        value.operation.value.time_fixed=60_000;
      }
      if(method==='sync')value.game_restore.actions.at(-1).payload.operation.time_fixed=60_000;
      if(method==='automaticTiming')for(const sample of value.evidence.samples)
        sample.displayedRemainingMs=60_000-sample.passedWaitingTime*1000;
      return value;
    };
    try {
      const report=await acceptLivePage(h.page,{...h.options,discardOnce:true});
      if(rules[0]===60&&rules[1]===0){
        assert.equal(report.status,'passed',JSON.stringify(report));
        assert.ok('attempt' in report);
        assert.equal(report.attempt?.status,'confirmed');
        assert.equal(h.page.prepared.timing.fixedMs,60_000);
        assert.equal(h.page.prepared.timing.addMs,0);
        assert.equal(h.page.sends,1);
      }else{
        assert.equal(report.status,'blocked');
        assert.ok('code' in report);
        assert.equal(report.code,'FRIEND_ROOM_READBACK_MISMATCH');
        assert.equal(h.page.sends,0);
      }
    } finally {await h.cleanup();}
  });
});
