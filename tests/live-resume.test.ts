import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptLivePage } from '../src/app/live.ts';
import { createLiveScenario } from './live-helpers.ts';
import { runAutomation } from './automation-harness.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecisionSnapshot } from '../src/domain/game/types.ts';
import { bridgeCall } from '../src/adapters/majsoul/ego-transport.ts';

// Only the strategy is stubbed: synchronization, execution, confirmation,
// settlement and the shared SQLite ledger all use the production assembly.
const createRunner = () => ({
  init: async () => {}, close: () => {},
  decide: async (snapshot: DecisionSnapshot) => snapshot.legalActions.find(candidate =>
    candidate.action.kind === 'discard' && candidate.action.tsumogiri)!,
});

async function resumedScenario(mode: 'play' | 'expired' | 'expired-discard' | 'no-turn' | 'terminal' | 'client-discard' | 'missing-result') {
  const h = await createLiveScenario();
  h.options.room.rules.verifiedOptions.redFives = 3;
  const evaluate = h.page.evaluate.bind(h.page);
  let drains = 0, ended = false;
  const result = { result: { players: [0, 1, 2, 3].map(seat => ({ seat, part_point_1: 25000 })) } };
  const terminalStep = ['play', 'client-discard', 'expired-discard'].includes(mode) ? 12 : 11;
  h.page.evaluate = async (source, argument) => {
    const method = (argument as { method: string }).method;
    if (method === 'releaseAkagi') return { released: true, paused: true };
    const value = await evaluate(source, argument);
    if (method === 'sync') {
      const draw = structuredClone(value.game_restore.actions.at(-1));
      value.game_restore.actions.at(-1).payload.tile = '9s';
      value.game_restore.actions.push(
        { name: 'ActionDiscardTile', step: 3, payload: { seat: 1, tile: '9s', moqie: true, is_liqi: false, is_wliqi: false } },
      );
      let tilesRemaining = 67;
      for (const seat of [2, 3, 0]) {
        value.game_restore.actions.push({ name: 'ActionDealTile', step: value.game_restore.actions.length,
          payload: { seat, tile: '', left_tile_count: tilesRemaining-- } });
        value.game_restore.actions.push({ name: 'ActionDiscardTile', step: value.game_restore.actions.length,
          payload: { seat, tile: '9m', moqie: true, is_liqi: false, is_wliqi: false } });
      }
      value.game_restore.actions.push({ ...structuredClone(draw), step: 10,
        payload: { ...structuredClone(draw.payload), left_tile_count: tilesRemaining } });
      if (!['play', 'expired', 'expired-discard'].includes(mode)) delete value.game_restore.actions.at(-1).payload.operation;
      value.step = 11;
      if (mode === 'terminal') {
        ended = true; value.is_end = true; value.matchResult = result; value.step++;
        value.game_restore.actions.push({ name: 'ActionNoTile', step: 11,
          payload: { liujumanguan: false, gameend: true, scores: [] } });
      }
    }
    if (method === 'read') {
      value.akagiEnabled = true; value.phase2ActionsEnabled = true;
      value.connected = true; value.freshConnection = true;
      value.paused = h.page.controls.at(-1)?.paused ?? true;
      value.controlEpoch = h.page.controls.at(-1)?.controlEpoch;
      value.sourceStream = 0; value.nativeRestoreRevision = 0; value.handSha256 = 'a'.repeat(64);
      value.queued = 0;
      value.matchEnded = ended;
      value.authSummary.otherSeatsAreRobots = true;
      Object.assign(value.authSummary.gameConfig.mode.detail_rule, { dora_count: 3, shiduan: 1, init_point: 25000 });
    }
    if (method === 'drain') {
      drains++;
      // Wait until the opening sync and switch recovery have both closed.
      if (!ended && (h.page.sends || drains >= (mode.startsWith('expired') ? 5 : 3) && mode !== 'play')) {
        ended = true;
        for (const record of value.records) record.step = 11;
        if (mode === 'client-discard' || mode === 'expired-discard') value.records.push({ kind: 'action', name: 'ActionDiscardTile', step: 11,
          receivedAt: h.page.at, payload: { seat: 1, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false } });
        value.records.push({ kind: 'action', name: 'ActionNoTile', step: terminalStep,
          receivedAt: h.page.at, payload: { liujumanguan: false, gameend: true, scores: [] } });
        if (mode !== 'missing-result') value.records.push({ kind: 'match-end', payload: result, receivedAt: h.page.at });
      }
    }
    if (['read', 'drain', 'ackSync'].includes(method)) value.lastStep = ended ? terminalStep : 10;
    if (['ensureAutoWin', 'verifyAutoWin'].includes(method)) value.step = 10;
    if (['read', 'drain'].includes(method)) value.generation = ended ? 1 : 0;
    return value;
  };
  return h;
}

test('resumed Akagi match excludes initial sync discards and confirms only new program actions', async () => {
  const h = await resumedScenario('play');
  try {
    const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 5_000 }, undefined, createRunner);
    assert.ok('lifecycle' in report, JSON.stringify(report));
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.lifecycle.matchStatus, 'finished');
    assert.equal(report.initialOwnDiscards, 1);
    assert.equal(report.counts.outbox, 2);
    assert.equal(report.automated?.confirmedDiscards, 1);
    assert.equal(report.unmatchedOwnDiscards, 0);
    assert.equal(h.page.sends, 1);
  } finally { await h.cleanup(); }
});

test('continuous play skips an expired offer and keeps ingesting until the match finishes', async () => {
  const h = await resumedScenario('expired');
  h.options.room.rules.displayTimeSetting = '5+20';
  const evaluate = h.page.evaluate.bind(h.page);
  let acquisitions = 0, decisions = 0;
  h.page.evaluate = async (source, argument) => {
    const value = await evaluate(source, argument);
    const method = (argument as { method: string }).method;
    if (method === 'sync') value.game_restore.actions.at(-1).payload.operation.time_fixed = 5000;
    if (method === 'read') Object.assign(value.authSummary.gameConfig.mode.detail_rule, { time_fixed: 5, time_add: 20 });
    if (method === 'automaticTiming') {
      acquisitions++;
      // Room 19679: the time bank was empty; the pair arrived at elapsed
      // 2s and 4s of a 5s offer, with only 1s left for a safe action.
      value.raw.game_restore.passed_waiting_time = 4;
      for (const [index, sample] of value.evidence.samples.entries()) {
        sample.fixedMs = 5000;
        sample.passedWaitingTime = 2 + index * 2;
        sample.displayedRemainingMs = 5000 - index * 2000;
      }
    }
    return value;
  };
  try {
    const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 2_000 },
      undefined, () => ({ ...createRunner(), decide: async () => { decisions++; throw Error('EXPIRED_OFFER_MUST_NOT_DECIDE'); } }));
    assert.ok('lifecycle' in report, JSON.stringify(report));
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.lifecycle.matchStatus, 'finished');
    assert.equal(report.automated?.skippedExpiredWindows, 1);
    assert.equal(report.automated?.attempted, 0);
    assert.equal(acquisitions, 1);
    assert.equal(decisions, 0);
    assert.equal(h.page.sends, 0);
    assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(h.page.calls.includes('ackTiming'), false);
  } finally { await h.cleanup(); }
});

test('a countdown mismatch cannot be skipped when its zero-send page fence changes', async () => {
  const h = await resumedScenario('expired');
  const evaluate = h.page.evaluate.bind(h.page);
  let rejected=false;
  h.page.evaluate = async (source, argument) => {
    const value = await evaluate(source, argument);
    if ((argument as { method: string }).method === 'automaticTiming') {
      value.evidence.samples[1].displayedRemainingMs -= 10_000;rejected=true;
    }
    if ((argument as { method: string }).method === 'read' && rejected)value.stats.bridgeActionSends++;
    return value;
  };
  try {
    const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 2_000 }, undefined, createRunner);
    assert.equal(report.status, 'blocked');
    assert.ok('code' in report);
    assert.equal(report.code, 'UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED');
    assert.equal(report.automated?.skippedUnverifiedTimingWindows,0);
    assert.equal(report.automated?.skippedExpiredWindows,0);
    assert.equal(h.page.sends, 0);
  } finally { await h.cleanup(); }
});

test('continuous play survives expiration at each pre-send gate without retrying or confirming the skipped action', async t => {
  for (const stage of ['ackTiming', 'freeze', 'strategy', 'prepare', 'permit', 'auto-win-expired'] as const) await t.test(stage, async () => {
    const h = await resumedScenario('expired-discard');
    if (stage === 'freeze' || stage === 'strategy') h.options.room.rules.displayTimeSetting = '5+20';
    const evaluate = h.page.evaluate.bind(h.page);
    let acquisitions = 0;
    h.page.evaluate = async (source, argument) => {
      const method = (argument as { method: string }).method;
      if(method==='dispatchPrepared' && stage==='auto-win-expired')return {
        callId:'bridge:1:not-sent:AUTO_WIN_READBACK_EXPIRED:00000000-0000-4000-8000-000000000000',
        delivery:'not-sent',observedAt:new Date().toISOString()};
      const value = await evaluate(source, argument);
      if (method === 'sync' && (stage === 'freeze' || stage === 'strategy'))
        value.game_restore.actions.at(-1).payload.operation.time_fixed = 5000;
      if (method === 'automaticTiming') {
        acquisitions++;
        if (stage === 'freeze' || stage === 'strategy') {
          // The same 5s/no-bank offer as rooms 78397 and 46482. At 2s
          // elapsed it has only 650ms after uncertainty and safety margin.
          value.raw.game_restore.actions.at(-1).payload.operation.time_fixed = 5000;
          value.raw.game_restore.passed_waiting_time = 2;
          value.raw.receivedAt = new Date(Date.now() - (stage === 'freeze' ? 1500 : 0)).toISOString();
          for (const [index, sample] of value.evidence.samples.entries()) {
            sample.fixedMs = 5000; sample.passedWaitingTime = index * 2;
            sample.displayedRemainingMs = 5000 - index * 2000;
            sample.sampledAt = new Date(Date.parse(value.raw.receivedAt) - (index ? 0 : 2500)).toISOString();
          }
        }
      }
      if (method === 'read' && h.options.room.rules.displayTimeSetting === '5+20')
        Object.assign(value.authSummary.gameConfig.mode.detail_rule, { time_fixed: 5, time_add: 20 });
      if (method === 'ackTiming' && stage === 'ackTiming' || method === 'prepare' && stage === 'prepare') throw Error('DEADLINE_EXCEEDED');
      if (method === 'prepare' && stage === 'permit') await new Promise(resolve => setTimeout(resolve, 1100));
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 4_000 }, undefined,
        () => ({ ...createRunner(), decide: async snapshot => {
          if (stage === 'strategy') await new Promise(resolve => setTimeout(resolve, 1000));
          return createRunner().decide(snapshot);
        } }));
      assert.ok('lifecycle' in report, JSON.stringify(report));
      assert.equal(report.status, 'passed', JSON.stringify(report));
      assert.equal(report.lifecycle.matchStatus, 'finished');
      assert.equal(report.automated?.skippedExpiredWindows, 1);
      assert.equal(report.automated?.confirmed, 0);
      assert.equal(report.counts.confirmations, 0);
      assert.equal(report.expiredWindowDiscards?.length, 1);
      assert.equal(report.unmatchedOwnDiscards, 0);
      assert.equal(acquisitions, 1);
      assert.equal(h.page.sends, 0);
      assert.equal(h.page.calls.includes('dispatch'), false);
      assert.equal(h.page.controls.at(-1)?.paused, true);
      if (stage === 'prepare' || stage === 'permit' || stage==='auto-win-expired') {
        assert.equal(report.executionDiagnostic?.invocationStarted, true);
        assert.equal(report.executionDiagnostic?.code,'TRANSPORT_NOT_SENT');
        assert.equal(report.executionDiagnostic?.notSentReason, stage === 'permit' ? 'PERMIT_EXPIRED' :
          stage==='auto-win-expired'?'AUTO_WIN_READBACK_EXPIRED':'DEADLINE_EXCEEDED');
      }
    } finally { await h.cleanup(); }
  });
});

test('a revoked local permit waits for the server turn beyond ten seconds without resending', async t => {
  for(const outcome of ['advance','stalled'] as const) await t.test(outcome,async t=>{
    const h=await resumedScenario('play');
    h.options.room.rules.displayTimeSetting='5+20';
    const evaluate=h.page.evaluate.bind(h.page),now=performance.now.bind(performance);
    let elapsed=0,expired=false,polls=0,ended=false,acquisitions=0;
    t.mock.method(performance,'now',()=>now()+elapsed);
    h.page.evaluate=async(source,argument)=>{
      const method=(argument as {method:string}).method;
      if(method==='prepare'){expired=true;throw Error('DEADLINE_EXCEEDED');}
      const value=await evaluate(source,argument);
      if(method==='sync'){
        Object.assign(value.game_restore.actions.at(-1).payload.operation,{time_fixed:5000,time_add:20000});
        value.authSummary={gameConfig:{mode:{detail_rule:{time_fixed:5,time_add:20}}}};
      }
      if(method==='read')Object.assign(value.authSummary.gameConfig.mode.detail_rule,{time_fixed:5,time_add:20});
      if(method==='automaticTiming'){
        acquisitions++;
        for(const sample of value.evidence.samples){
          sample.fixedMs=5000;sample.addMs=20000;sample.displayedRemainingMs=0;
          sample.displayedBankMs=25000-sample.passedWaitingTime*1000;
        }
      }
      if(method==='drain' && expired && !ended){
        polls++;
        elapsed=polls===1?12000:outcome==='stalled'?39000:13000;
        if(polls>1 && outcome==='advance'){
          ended=true;
          value.records=[
            {kind:'action',name:'ActionDiscardTile',step:11,receivedAt:h.page.at,
              payload:{seat:1,tile:'0m',moqie:true,is_liqi:false,is_wliqi:false}},
            {kind:'action',name:'ActionNoTile',step:12,receivedAt:h.page.at,
              payload:{liujumanguan:false,gameend:true,scores:[]}},
            {kind:'match-end',receivedAt:h.page.at,payload:{result:{players:[0,1,2,3].map(seat=>({seat,part_point_1:25000}))}}},
          ];
        }
      }
      if(ended && ['read','drain'].includes(method))Object.assign(value,{lastStep:12,generation:1,matchEnded:true});
      return value;
    };
    try{
      const report=await acceptLivePage(h.page,{...h.options,akagi:true,resumeMatch:true,observeMs:60000},undefined,createRunner);
      assert.equal(report.status,outcome==='advance'?'passed':'blocked',JSON.stringify(report));
      if(outcome==='stalled'){assert.ok('code' in report);assert.equal(report.code,'AKAGI_WINDOW_DID_NOT_ADVANCE');}
      else{assert.ok('expiredWindowDiscards' in report);assert.equal(report.expiredWindowDiscards?.length,1);}
      assert.equal(report.automated?.skippedExpiredWindows,1);
      assert.equal(report.automated?.confirmed,0);
      assert.equal(acquisitions,1);
      assert.equal(h.page.sends,0);
      assert.equal(h.page.calls.includes('dispatch'),false);
    }finally{await h.cleanup();}
  });
});

test('a skipped offer only explains the next authoritative drawn-tile discard', async t => {
  for (const variant of ['wrong-tile', 'not-tsumogiri', 'riichi', 'later-cursor'] as const) await t.test(variant, async () => {
    const h = await resumedScenario('expired-discard');
    const evaluate = h.page.evaluate.bind(h.page);
    h.page.evaluate = async (source, argument) => {
      const method = (argument as { method: string }).method;
      const value = await evaluate(source, argument);
      if (method === 'ackTiming') throw Error('DEADLINE_EXCEEDED');
      if (method === 'drain') {
        const discard = value.records.find((r: any) => r.name === 'ActionDiscardTile');
        if (discard) {
          if (variant === 'wrong-tile') discard.payload.tile = '1m';
          if (variant === 'not-tsumogiri') discard.payload.moqie = false;
          if (variant === 'riichi') discard.payload.is_liqi = true;
          if (variant === 'later-cursor') {
            value.records.unshift({ kind: 'action', name: 'ActionDealTile', step: 11, receivedAt: h.page.at,
              payload: { seat: 2, tile: '', left_tile_count: 63 } });
            discard.step = 12; value.records.find((r: any) => r.name === 'ActionNoTile').step = 13;
            value.lastStep = 13;
          }
        }
      }
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1000 }, undefined, createRunner);
      assert.equal(report.status, 'blocked', JSON.stringify(report));
      if ('expiredWindowDiscards' in report) assert.equal(report.expiredWindowDiscards?.length, 0);
      assert.equal(h.page.sends, 0);
    } finally { await h.cleanup(); }
  });
});

test('after timing or visual expiration the next own turn is freshly synchronized and sent exactly once', async t => {
 for (const gate of ['ackTiming', 'verifyAutoWin'] as const) await t.test(gate, async () => {
  const h = await resumedScenario('play');
  const evaluate = h.page.evaluate.bind(h.page);
  let skipped = false, skipDrains = 0, advanced = false, finished = false, acquisitions = 0, pendingProgress = false;
  const progress: { name: string; step: number; payload: Record<string, unknown> }[] = [{ name: 'ActionDiscardTile', step: 11,
    payload: { seat: 1, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false } }];
  for (const seat of [2, 3, 0]) {
    progress.push({ name: 'ActionDealTile', step: 11 + progress.length,
      payload: { seat, tile: '', left_tile_count: 63 - Math.floor(progress.length / 2) } });
    progress.push({ name: 'ActionDiscardTile', step: 11 + progress.length,
      payload: { seat, tile: `${seat + 1}z`, moqie: true, is_liqi: false, is_wliqi: false } });
  }
  progress.push({ name: 'ActionDealTile', step: 18, payload: { seat: 1, tile: '1p', left_tile_count: 60,
    operation: { seat: 1, operation_list: [{ type: 1 }], time_fixed: 300000, time_add: 0 } } });
  h.page.evaluate = async (source, argument) => {
    const method = (argument as { method: string }).method;
    if (method === 'verifyAutoWin' && gate === 'verifyAutoWin' && !skipped) {
      // Native timeout and the other seats' actions arrive while the image is
      // in flight. The old committed actor must still ingest this exact tail.
      skipped = true; advanced = true; pendingProgress = true;
      throw Error('AUTO_WIN_READBACK_STALE');
    }
    const value = await evaluate(source, argument);
    if (method === 'ackTiming' && gate === 'ackTiming' && !skipped) { skipped = true; throw Error('DEADLINE_EXCEEDED'); }
    if (method === 'automaticTiming') {
      acquisitions++;
      if (gate === 'verifyAutoWin' && !skipped) {
        // The validated numeric pair remains internally consistent, but its
        // safe budget expires while the read-only visual proof is collected.
        value.raw.receivedAt = new Date(Date.now() - 278_000).toISOString();
        for (const [index, sample] of value.evidence.samples.entries())
          sample.sampledAt = new Date(Date.parse(value.raw.receivedAt) - (index ? 0 : 2500)).toISOString();
      }
    }
    if (method === 'read') Object.assign(value, { sourceStream: 0, nativeRestoreRevision: 0, handSha256: 'a'.repeat(64),
      controlEpoch: h.page.controls.at(-1)!.controlEpoch });
    if (method === 'sync' && advanced) {
      value.game_restore.actions.push(...structuredClone(progress)); value.step = 19; value.generation = 1;
    }
    if (method === 'drain' && pendingProgress) {
      pendingProgress = false;
      value.records = progress.map(record => ({ ...structuredClone(record), kind: 'action', receivedAt: h.page.at }));
    } else if (method === 'drain' && skipped && !advanced && ++skipDrains === 2) {
      advanced = true;
      value.records = progress.map(record => ({ ...structuredClone(record), kind: 'action', receivedAt: h.page.at }));
    } else if (method === 'drain' && advanced && h.page.sends) {
      for (const record of value.records) {
        if (record.name === 'ActionDiscardTile') { record.step = 19; record.payload.tile = '1p'; }
        if (record.name === 'ActionNoTile') { record.step = 20; finished = true; }
      }
    }
    if (advanced && ['read', 'drain', 'ackSync'].includes(method)) value.lastStep = finished ? 20 : 18;
    if (advanced && ['ensureAutoWin', 'verifyAutoWin'].includes(method)) value.step = 18;
    if (advanced && ['read', 'drain'].includes(method)) value.generation = finished ? 2 : 1;
    return value;
  };
  try {
    const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 3000 }, undefined, createRunner);
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.ok('expiredWindowDiscards' in report);
    assert.equal(report.expiredWindowDiscards?.length, 1);
    assert.equal(report.automated?.skippedExpiredWindows, 1);
    assert.equal(report.automated?.confirmedDiscards, 1);
    assert.equal(report.unmatchedOwnDiscards, 0);
    assert.equal(acquisitions, 2);
    assert.equal(h.page.sends, 1);
    assert.equal(h.page.prepared.expected.step, 18);
  } finally { await h.cleanup(); }
 });
});

test('continuous play retains blocking for other preparation failures and uncertain or refused sends', async t => {
  for (const mode of ['other-error', 'not-sent', 'unknown', 'unknown-auto-win-expired', 'auto-win-unverified'] as const) await t.test(mode, async () => {
    const h = await resumedScenario('play');
    const evaluate = h.page.evaluate.bind(h.page);
    h.page.evaluate = async (source, argument) => {
      if ((argument as { method: string }).method === 'prepare' && mode === 'other-error') throw Error('FENCE_STALE');
      if((argument as {method:string}).method==='dispatchPrepared' && ['unknown-auto-win-expired','auto-win-unverified'].includes(mode))return {
        callId:`bridge:1:not-sent:${mode==='auto-win-unverified'?'AUTO_WIN_UNVERIFIED':'AUTO_WIN_READBACK_EXPIRED'}:00000000-0000-4000-8000-000000000000`,
        delivery:mode==='auto-win-unverified'?'not-sent':'unknown',observedAt:new Date().toISOString()};
      return evaluate(source, argument);
    };
    if (mode==='not-sent' || mode==='unknown') h.page.delivery = mode;
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1000 }, undefined, createRunner);
      assert.equal(report.status, 'blocked', JSON.stringify(report));
      assert.equal(report.automated?.skippedExpiredWindows, 0);
      assert.equal(report.automated?.confirmed, 0);
      assert.equal(h.page.calls.filter(method => method === 'dispatch').length, mode === 'not-sent' || mode==='unknown' ? 1 : 0);
      if (mode === 'unknown' || mode==='unknown-auto-win-expired') {
        assert.ok('recovery' in report);
        assert.equal(report.recovery.canResume, false);
        assert.equal(report.recovery.unresolvedAttempts, 1);
      }
    } finally { await h.cleanup(); }
  });
});

test('verified same-hand switches use fresh readback while disabled switches still require the recovery workflow', async t => {
  for (const disabled of [false, true]) await t.test(String(disabled), async () => {
    const h = await resumedScenario('play');
    const evaluate = h.page.evaluate.bind(h.page);
    let verified = 0;
    h.page.evaluate = async (source, argument) => {
      if ((argument as { method: string }).method === 'verifyAutoWin' && ++verified === 1 && disabled) throw Error('AUTO_WIN_UNVERIFIED');
      return evaluate(source, argument);
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1000 }, undefined, createRunner);
      assert.equal(report.status, 'passed', JSON.stringify(report));
      assert.equal(h.page.calls.filter(method => method === 'ensureAutoWin').length, disabled ? 2 : 1);
      assert.equal(verified, 2); // Current-window check and final prepare check.
      assert.equal(h.page.sends, 1);
    } finally { await h.cleanup(); }
  });
});

test('same-window visual staleness recollects fresh proofs with no pending sync and bounds repeated failures', async t => {
  for (const persistent of [false, true]) await t.test(String(persistent), async () => {
    const h = await resumedScenario('play'), evaluate = h.page.evaluate.bind(h.page);
    let samples = 0, acquisitions = 0;
    h.page.evaluate = async (source, argument) => {
      const method = (argument as { method: string }).method;
      if (method === 'verifyAutoWin' && (++samples === 1 || persistent)) throw Error('AUTO_WIN_READBACK_STALE');
      const value = await evaluate(source, argument);
      if (method === 'automaticTiming') acquisitions++;
      if (method === 'read') Object.assign(value, { sourceStream: 0, nativeRestoreRevision: 0, handSha256: 'a'.repeat(64),
        controlEpoch: h.page.controls.at(-1)!.controlEpoch });
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 2500 }, undefined, createRunner);
      assert.equal(report.status, persistent ? 'blocked' : 'passed', JSON.stringify(report));
      assert.equal(acquisitions, persistent ? 4 : 2);
      assert.equal(h.page.sends, persistent ? 0 : 1);
      assert.equal(report.automated?.skippedExpiredWindows, 0);
      if (persistent) {
        assert.ok('code' in report); assert.equal(report.code, 'AUTO_WIN_SAMPLE_STALE');
        assert.equal(h.page.calls.includes('prepare'), false);
      } else {
        assert.equal(report.automated?.confirmedDiscards, 1);
        assert.equal(h.page.calls.filter(method => method === 'ackTiming').length, 1);
      }
    } finally { await h.cleanup(); }
  });
});

test('stale visual recovery rejects changed page, hand, restore, control or send scope and does not retry a toggle', async t => {
  for (const fault of ['page', 'source', 'restore', 'game', 'control', 'send', 'unknown', 'toggle'] as const) await t.test(fault, async () => {
    const h = await resumedScenario('play'), evaluate = h.page.evaluate.bind(h.page);
    let failed = false, checks = 0, acquisitions = 0, ensures = 0;
    h.page.evaluate = async (source, argument) => {
      const method = (argument as { method: string }).method;
      if (method === 'verifyAutoWin') {
        failed = true; checks++;
        throw Error(fault === 'toggle' ? 'AUTO_WIN_UNVERIFIED' : fault === 'unknown' ? 'AUTO_WIN_READBACK_FAILED' : 'AUTO_WIN_READBACK_STALE');
      }
      if (method === 'ensureAutoWin' && ++ensures > 1 && fault === 'toggle') throw Error('AUTO_WIN_READBACK_STALE');
      const value = await evaluate(source, argument);
      if (method === 'automaticTiming') acquisitions++;
      if (method === 'read') {
        Object.assign(value, { sourceStream: 0, nativeRestoreRevision: 0, handSha256: 'a'.repeat(64),
          controlEpoch: h.page.controls.at(-1)!.controlEpoch });
        if (failed) {
          if (fault === 'page') value.pageEpoch++;
          if (fault === 'source') value.sourceStream++;
          if (fault === 'restore') value.nativeRestoreRevision++;
          if (fault === 'game') value.gameUuid = 'replacement-game';
          if (fault === 'control') value.controlEpoch++;
          if (fault === 'send') value.stats.bridgeActionSends++;
        }
      }
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1500 }, undefined, createRunner);
      assert.equal(report.status, 'blocked', JSON.stringify(report));
      assert.ok('code' in report);
      assert.equal(report.code, fault === 'unknown' ? 'AUTO_WIN_READBACK_FAILED' : 'AUTO_WIN_READBACK_STALE');
      assert.equal(checks, 1); assert.equal(acquisitions, 1);
      assert.equal(h.page.sends, 0); assert.equal(h.page.calls.includes('prepare'), false);
      assert.equal(report.automated?.skippedExpiredWindows, 0);
      if (fault === 'toggle') assert.equal(ensures, 2);
    } finally { await h.cleanup(); }
  });
});

test('single-step acceptance still rejects timing acknowledgement expiry', async () => {
  const h = await createLiveScenario();
  const evaluate = h.page.evaluate.bind(h.page);
  h.page.evaluate = async (source, argument) => {
    if ((argument as { method: string }).method === 'ackTiming') throw Error('DEADLINE_EXCEEDED');
    return evaluate(source, argument);
  };
  try {
    const report = await acceptLivePage(h.page, { ...h.options, discardOnce: true });
    assert.equal(report.status, 'blocked');
    assert.ok('code' in report); assert.equal(report.code, 'DEADLINE_EXCEEDED');
    assert.equal(h.page.sends, 0);
  } finally { await h.cleanup(); }
});

test('continuous startup recollects a snapshot that advances during its final drain, with bounded retries', async t => {
  for (const races of [1, 6, Infinity]) await t.test(String(races), async t => {
    const h = await resumedScenario('play');
    const evaluate = h.page.evaluate.bind(h.page);
    const now = performance.now.bind(performance);
    let captures = 0, elapsed = 0;
    t.mock.method(performance, 'now', () => now() + elapsed);
    h.page.evaluate = async (source, argument) => {
      const value = await evaluate(source, argument);
      if ((argument as { method: string }).method === 'drain' && captures++ < races) {
        value.generation++; value.lastStep++;
        if (races === Infinity && captures === 6) elapsed = 31_000;
      }
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 2_000 }, undefined, createRunner);
      assert.equal(report.status, races === Infinity ? 'blocked' : 'passed', JSON.stringify(report));
      if (races === Infinity) {
        assert.ok('code' in report);
        assert.equal(report.code, 'SYNC_CAPTURE_RACE');
        assert.equal(h.page.calls.filter(call => call === 'sync').length, 6);
        assert.equal(h.page.sends, 0);
      } else assert.equal(h.page.sends, 1);
      assert.equal(h.page.controls.at(-1)?.paused, true);
    } finally { await h.cleanup(); }
  });
});

test('startup retry waiting stops immediately and never recollects an unknown error or replacement scope', async t => {
  for (const fault of ['abort', 'unknown', 'page', 'game'] as const) await t.test(fault, async t => {
    const h = await resumedScenario('play'), evaluate = h.page.evaluate.bind(h.page), controller = new AbortController();
    let failed = false, syncs = 0;
    const cancellation: string[] = [];
    let fallback: NodeJS.Timeout | undefined;
    if (fault === 'abort') {
      const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
      const listeners = new Map<EventListenerOrEventListenerObject, EventListener>();
      // Observe the actual abortable wait, not storage startup or shutdown time.
      // Cancel in a microtask after its listener is registered, before the
      // retry timer can fire. The fallback only bounds a broken implementation.
      fallback = setTimeout(() => controller.abort(), 1000);
      t.mock.method(signal, 'addEventListener', (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type !== 'abort' || !listener) return add(type, listener, options);
        const wrapped: EventListener = event => {
          cancellation.push('cancelled');
          if (typeof listener === 'function') listener.call(signal, event);
          else listener.handleEvent(event);
        };
        listeners.set(listener, wrapped); cancellation.push('registered');
        add(type, wrapped, options);
        clearTimeout(fallback);
        queueMicrotask(() => controller.abort());
      });
      t.mock.method(signal, 'removeEventListener', (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        const wrapped = listener && listeners.get(listener);
        if (type === 'abort' && wrapped) {
          cancellation.push('removed'); listeners.delete(listener!);
          return remove(type, wrapped, options);
        }
        return remove(type, listener, options);
      });
    }
    h.page.evaluate = async (source, argument) => {
      const method = (argument as { method: string }).method;
      if (method === 'sync') {
        failed = true; syncs++;
        throw Error(fault === 'unknown' ? 'PROTOCOL_HASH_MISMATCH' : 'SYNC_INGRESS_RACE');
      }
      const value = await evaluate(source, argument);
      if (method === 'read' && failed) {
        if (fault === 'page') value.pageEpoch++;
        if (fault === 'game') value.gameUuid = 'replacement-game';
      }
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1000 }, controller.signal, createRunner);
      assert.equal(report.status, 'blocked', JSON.stringify(report));
      assert.ok('code' in report);
      assert.equal(report.code, fault === 'abort' ? 'LIVE_CANCELLED' : fault === 'unknown' ? 'PROTOCOL_HASH_MISMATCH' : 'SYNC_IDENTITY_CHANGED');
      assert.equal(syncs, 1); assert.equal(h.page.sends, 0);
      assert.equal(h.page.calls.includes('prepare'), false);
      if (fault === 'abort') assert.deepEqual(cancellation, ['registered', 'cancelled', 'removed']);
    } finally { clearTimeout(fallback); await h.cleanup(); }
  });
});

test('mid-game attachment waits for complete hand history and bounds an empty restore', async t => {
  for (const persistent of [false, true]) await t.test(String(persistent), async () => {
    const h = await resumedScenario('play');
    const evaluate = h.page.evaluate.bind(h.page);
    let restores = 0;
    h.page.evaluate = async (source, argument) => {
      const value = await evaluate(source, argument);
      if ((argument as { method: string }).method === 'sync' && (++restores === 1 || persistent)) value.game_restore.actions = [];
      return value;
    };
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 3000 }, undefined, createRunner);
      assert.equal(report.status, persistent ? 'blocked' : 'passed', JSON.stringify(report));
      assert.equal(h.page.sends, persistent ? 0 : 1);
      if (persistent) {
        assert.ok('code' in report); assert.equal(report.code, 'SYNC_HAND_START_REQUIRED');
        assert.equal(restores, 5);
        assert.equal(report.recovery.canResume, true);
        assert.equal(h.page.calls.includes('prepare'), false);
      }
    } finally { await h.cleanup(); }
  });
});

test('a failed worker releases the page and resumes the same running game through the shared ledger', async () => {
  const h = await resumedScenario('play');
  const evaluate = h.page.evaluate.bind(h.page);
  let acquisitions = 0;
  h.page.evaluate = async (source, argument) => {
    if ((argument as { method: string }).method === 'automaticTiming' && ++acquisitions <= 4) throw Error('COUNTDOWN_GLYPH_UNVERIFIED');
    return evaluate(source, argument);
  };
  const reports: Awaited<ReturnType<typeof acceptLivePage>>[] = [];
  const sessions: string[] = [];
  const nativeLifecycleTrace = ['authGame', 'syncGame', 'finishSyncGame'].flatMap((method, group) =>
    ['request', 'response', 'response-forwarded'].map((phase, index) => ({ owner: 'client', pageEpoch: 1,
      method, phase, observedMonoMs: group * 3 + index, ...(index ? { accepted: true, ...(method === 'syncGame' ? { hasRestore: true } : {}) } : {}) })));
  try {
    await writeFile(join(h.directory, 'control.json'), '{"enabled":true}');
    await runAutomation(h.page, process.execPath, { ...h.options, observeMs: 5000 }, h.directory,
      { maxMatches: 1, maxDurationMs: 60_000 }, {
        install: async () => { throw Error('MUST_NOT_RELOAD_OR_START_GAME'); },
        call: async (page, method, argument) => {
          assert.notEqual(method, 'startNextMatch');
          const value = await bridgeCall(page, method, argument);
          return method === 'read' ? { ...value, controlEpoch: 0, executorActive: false, nativeRestoreRevision: 0, nativeLifecycleTrace }
            : method === 'sync' ? { ...value, gameUuid: 'contract-only-game-uuid' } : value;
        },
        accept: async (page, options) => {
          assert.equal(options.databasePath, h.options.databasePath);
          assert.equal(options.room.roomId, h.options.room.roomId);
          assert.equal(options.resumeMatch, true);
          sessions.push(options.sessionId!);
          const report = await acceptLivePage(page, options, undefined, createRunner);
          reports.push(report);
          return report;
        },
      });
    assert.equal(reports.length, 2);
    assert.notEqual(sessions[0], sessions[1]);
    assert.equal(reports[0]!.status, 'blocked');
    assert.ok('recovery' in reports[0]!); assert.equal(reports[0]!.recovery.canResume, true);
    assert.equal(reports[1]!.status, 'passed', JSON.stringify(reports[1]));
    assert.equal(h.page.sends, 1);
    const status = JSON.parse(await readFile(join(h.directory, 'status.json'), 'utf8'));
    assert.equal(status.completedMatches, 1);
    assert.equal(status.status, 'stopped');
  } finally { await h.cleanup(); }
});

test('an observation deadline produces a safe continuation and a new worker finishes the same match', async () => {
  const h = await resumedScenario('no-turn');
  const evaluate = h.page.evaluate.bind(h.page);
  let finish = false;
  h.page.evaluate = async (source, argument) => {
    if ((argument as { method: string }).method === 'drain' && !finish)
      return { ...await evaluate(source, { method: 'read' }), records: [] };
    return evaluate(source, argument);
  };
  const nativeLifecycleTrace = ['authGame', 'syncGame', 'finishSyncGame'].flatMap((method, group) =>
    ['request', 'response', 'response-forwarded'].map((phase, index) => ({ owner: 'client', pageEpoch: 1,
      method, phase, observedMonoMs: group * 3 + index, ...(index ? { accepted: true, ...(method === 'syncGame' ? { hasRestore: true } : {}) } : {}) })));
  const reports: Awaited<ReturnType<typeof acceptLivePage>>[] = [];
  try {
    await writeFile(join(h.directory, 'control.json'), '{"enabled":true}');
    await runAutomation(h.page, process.execPath, { ...h.options, observeMs: 200 }, h.directory,
      { maxMatches: 1, maxDurationMs: 60_000 }, {
        install: async () => { throw Error('MUST_NOT_RELOAD'); },
        call: async (page, method, argument) => {
          assert.notEqual(method, 'startNextMatch');
          const value = await bridgeCall(page, method, argument);
          return method === 'read' ? { ...value, controlEpoch: 0, executorActive: false, nativeRestoreRevision: 0, nativeLifecycleTrace }
            : method === 'sync' ? { ...value, gameUuid: 'contract-only-game-uuid' } : value;
        },
        accept: async (page, options) => {
          if (reports.length) {
            const status = JSON.parse(await readFile(join(h.directory, 'status.json'), 'utf8'));
            assert.equal(status.completedMatches, 0);
            assert.equal(h.page.controls.at(-1)?.paused, true);
            finish = true;
          }
          const report = await acceptLivePage(page, options, undefined, createRunner);
          reports.push(report);
          return report;
        },
      });
    assert.equal(reports.length, 2);
    assert.equal(reports[0]!.status, 'blocked');
    assert.ok('code' in reports[0]!);
    assert.equal(reports[0]!.code, 'MATCH_OBSERVATION_LIMIT');
    assert.equal(reports[0]!.recovery?.canResume, true);
    assert.equal(reports[0]!.recovery?.unresolvedAttempts, 0);
    assert.equal(reports[1]!.status, 'passed', JSON.stringify(reports[1]));
    assert.notEqual(reports[0]!.sessionId, reports[1]!.sessionId);
    assert.equal(h.page.sends, 0);
    const status = JSON.parse(await readFile(join(h.directory, 'status.json'), 'utf8'));
    assert.equal(status.completedMatches, 1);
    assert.equal(status.status, 'stopped');
  } finally { await h.cleanup(); }
});

test('a deadline during strategy pauses before sending and only continuous mode offers resumption', async t => {
  for (const resumeMatch of [false, true]) await t.test(String(resumeMatch), async () => {
    const h = await resumedScenario('play');
    try {
      const runner = createRunner();
      let decisions = 0;
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch, observeMs: 500 },
        undefined, () => ({ ...runner, decide: async snapshot => {
          decisions++;
          await new Promise(resolve => setTimeout(resolve, 550));
          return runner.decide(snapshot);
        } }));
      assert.equal(decisions, 1);
      assert.equal(report.status, 'blocked');
      assert.ok('code' in report);
      assert.equal(report.code, 'MATCH_OBSERVATION_LIMIT');
      assert.equal(report.recovery.canResume, resumeMatch);
      assert.equal(report.programPaused, true);
      assert.equal(h.page.sends, 0);
      assert.equal(h.page.calls.includes('prepare'), false);
    } finally { await h.cleanup(); }
  });
});

test('an action sent before the observation deadline keeps its full confirmation window', async () => {
  const h = await resumedScenario('play');
  const evaluate = h.page.evaluate.bind(h.page);
  let delayed = false;
  h.page.evaluate = async (source, argument) => {
    if ((argument as { method: string }).method === 'drain' && h.page.sends && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 600));
      return { ...await evaluate(source, { method: 'read' }), records: [] };
    }
    return evaluate(source, argument);
  };
  try {
    const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 500 },
      undefined, createRunner);
    assert.equal(delayed, true);
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.automated?.confirmedDiscards, 1);
    assert.equal(h.page.sends, 1);
  } finally { await h.cleanup(); }
});

test('continuous play recollects a transient screenshot failure without requiring server advancement and bounds retries', async t => {
  for (const code of ['COUNTDOWN_SAMPLE_STALE', 'COUNTDOWN_GLYPH_UNVERIFIED', 'COUNTDOWN_BANK_UNREADABLE']) {
    for (const persistent of [false, true]) await t.test(`${code}/${persistent}`, async () => {
      const h = await resumedScenario('play');
      const evaluate = h.page.evaluate.bind(h.page);
      let acquisitions = 0;
      h.page.evaluate = async (source, argument) => {
        if ((argument as { method: string }).method === 'automaticTiming' && (++acquisitions === 1 || persistent)) throw Error(code);
        return evaluate(source, argument);
      };
      try {
        const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 2_000 }, undefined, createRunner);
        assert.equal(report.status, persistent ? 'blocked' : 'passed', JSON.stringify(report));
        assert.equal(acquisitions, persistent ? 4 : 2);
        assert.equal(h.page.sends, persistent ? 0 : 1);
        if (persistent) {
          assert.ok('code' in report);
          assert.equal(report.code, code);
          assert.equal(h.page.calls.includes('prepare'), false);
        }
        assert.equal(h.page.controls.at(-1)?.paused, true);
      } finally { await h.cleanup(); }
    });
  }
});

test('historical discards already archived by another session are not subtracted twice', async () => {
  const h = await resumedScenario('play');
  try {
    const earlier = await acceptLivePage(h.page, h.options);
    assert.ok('counts' in earlier, JSON.stringify(earlier));
    assert.equal(earlier.status, 'passed');
    assert.equal(earlier.counts.outbox, 1);
    const report = await acceptLivePage(h.page, { ...h.options, outputDirectory: join(h.directory, 'resumed'),
      akagi: true, resumeMatch: true, observeMs: 5_000 }, undefined, createRunner);
    assert.ok('lifecycle' in report, JSON.stringify(report));
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.initialOwnDiscards, 0);
    assert.equal(report.counts.outbox, 1);
    assert.equal(report.automated?.confirmedDiscards, 1);
    assert.equal(report.unmatchedOwnDiscards, 0);
  } finally { await h.cleanup(); }
});

test('a resumed match can finish without another own turn, including an already terminal restore', async t => {
  for (const mode of ['no-turn', 'terminal'] as const) await t.test(mode, async () => {
    const h = await resumedScenario(mode);
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1_000 }, undefined, createRunner);
      assert.ok('lifecycle' in report, JSON.stringify(report));
      assert.equal(report.status, 'passed', JSON.stringify(report));
      assert.equal(report.initialOwnDiscards, 1);
      assert.equal(report.unmatchedOwnDiscards, 0);
      assert.equal(report.automated?.attempted, 0);
      assert.equal(h.page.sends, 0);
    } finally { await h.cleanup(); }
  });
});

test('resumption still blocks new unexplained discards, missing standings and incomplete full-match acceptance', async t => {
  for (const mode of ['client-discard', 'missing-result', 'no-turn'] as const) await t.test(mode, async () => {
    const h = await resumedScenario(mode);
    try {
      const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: mode !== 'no-turn', observeMs: 200 }, undefined, createRunner);
      if (mode === 'missing-result') {
        assert.ok('code' in report);
        assert.equal(report.code, 'MATCH_OBSERVATION_LIMIT');
        assert.equal(report.recovery.canResume, false);
      }
      assert.ok('lifecycle' in report, JSON.stringify(report));
      assert.equal(report.status, 'blocked');
      assert.equal(report.unmatchedOwnDiscards, mode === 'client-discard' ? 1 : 0);
      assert.equal(report.lifecycle.matchStatus, mode === 'missing-result' ? 'playing' : 'finished');
      assert.equal(report.matchCompletion?.canStartNextMatch, mode === 'client-discard');
      assert.equal(report.matchCompletion?.executionCoverageComplete, mode !== 'client-discard');
      assert.equal(h.page.sends, 0);
    } finally { await h.cleanup(); }
  });
});

test('a settled match proceeds through confirmation and the next start even when native discards leave acceptance blocked', async t => {
  for (const mode of ['play', 'client-discard'] as const) await t.test(mode, async () => {
  const h = await resumedScenario(mode);
  let completed = 0, waitingInRoom = false, playing = true;
  const steps: string[] = [];
  try {
    await writeFile(join(h.directory, 'control.json'), '{"enabled":true}');
    await runAutomation(h.page, process.execPath, h.options, h.directory, { maxMatches: 2, maxDurationMs: 60_000 }, {
      install: async () => { throw Error('MUST_NOT_RELOAD'); },
      call: async (_page, method) => {
        if (method === 'startNextMatch') {
          assert.equal(waitingInRoom, true); steps.push('start'); playing = true;
          return { started: true };
        }
        return { akagiEnabled: true, audienceRoomsVersion: 6, authSummary: {}, matchEnded: !playing,
          ...(playing ? {} : { gameUuid: 'finished' }) };
      },
      confirmResult: async () => { steps.push('confirm'); waitingInRoom = true; },
      prepareRoom: async () => {
        steps.push('prepare');
        if (completed) assert.equal(waitingInRoom, true);
        return h.options.room;
      },
      accept: async () => {
        steps.push('play'); completed++;
        const report = completed === 1
          ? await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 5_000 }, undefined, createRunner)
          : { status: 'passed', lifecycle: { matchStatus: 'finished' } };
        if (completed === 1) {
          assert.equal(report.status, mode === 'play' ? 'passed' : 'blocked');
          assert.ok('matchCompletion' in report);
          assert.equal(report.matchCompletion?.canStartNextMatch, true);
          assert.equal(report.matchCompletion?.unresolvedAttempts, 0);
        }
        playing = false;
        return report;
      },
    });
    const status = JSON.parse(await readFile(join(h.directory, 'status.json'), 'utf8'));
    assert.equal(status.status, 'stopped', JSON.stringify(status));
    assert.equal(status.completedMatches, 2);
    assert.deepEqual(steps, ['prepare', 'play', 'confirm', 'prepare', 'start', 'play']);
  } finally { await h.cleanup(); }
  });
});

test('a finished match with native discards still cannot advance across an unclosed observation tail', async () => {
  const h = await resumedScenario('client-discard');
  const evaluate = h.page.evaluate.bind(h.page);
  h.page.evaluate = async (source, argument) => {
    const value = await evaluate(source, argument);
    if ((argument as { method: string }).method === 'read' && value.matchEnded) value.queued = 1;
    return value;
  };
  try {
    const report = await acceptLivePage(h.page, { ...h.options, akagi: true, resumeMatch: true, observeMs: 1000 }, undefined, createRunner);
    assert.ok('matchCompletion' in report);
    assert.equal(report.lifecycle.matchStatus, 'finished');
    assert.equal(report.status, 'blocked');
    assert.equal(report.observationClosure.settled, false);
    assert.equal(report.matchCompletion?.canStartNextMatch, false);
  } finally { await h.cleanup(); }
});
