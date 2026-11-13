import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectAutomaticTiming } from '../src/adapters/majsoul/automatic-timing.ts';
import { deriveSyncOperationTiming } from '../src/adapters/majsoul/operation-timing.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { fixtures, imageFor, png } from './countdown-helpers.ts';
import { TOOLBAR_PALETTES } from '../src/adapters/majsoul/table-pixels.ts';

class TimingPage implements EgoPagePort {
  calls: string[] = []; generation = 2; pageEpoch = 1; index = 0; stale = false;
  // Historical 282 and 274 glyphs exercise the real screenshot reader; the wire
  // pair is scripted contract evidence, not a claimed historical server sample.
  images = [282,274].map(value => png(imageFor(fixtures.samples.find((s: any) => s.expectedSeconds === value))));
  async evaluate(source: unknown, input?: any): Promise<any> {
    if (input?.method === 'sync') {
      this.calls.push('sync');
      const index = this.index++, receivedMonoMs = 5000 + index * 8000;
      return { pageEpoch:1, generation:2, step:10, requestedMonoMs:receivedMonoMs-100, receivedMonoMs,
        receivedAt:new Date(Date.UTC(2026,10,5,0,0,index*8)).toISOString(), is_end:false,
        game_restore:{game_state:1,last_pause_time_ms:0,passed_waiting_time:18+index*8,actions:[
          {name:'ActionNewRound',step:0,payload:{sha256:'a'.repeat(64)}},
          {name:'ActionDealTile',step:9,payload:{operation:{time_fixed:300000,time_add:0,operation_list:[{type:1}]}}},
        ]} };
    }
    if (input?.method === 'read') return { pageEpoch:this.pageEpoch,generation:this.generation,lastStep:null,freshConnection:true,overflow:false };
    const mono = 5000 + (this.index-1)*8000 + 100;
    if (String(source).includes('scripts:')) return {width:2036,height:918,devicePixelRatio:1,scrollX:0,scrollY:0,
      sampledMonoMs:mono,observedAt:'2026-11-05T00:00:00Z',scripts:['https://example.invalid/WebGL-release-4.0.51(test).js']};
    if (this.stale) this.generation++;
    // Move past the pair interval without a wall-clock sleep in this test port.
    return mono + 2200;
  }
  async cdp(method: string): Promise<any> { assert.equal(method,'Page.captureScreenshot'); return {data:this.images[this.index-1]}; }
}

/** Keep fake wire time advancing, while bounding each screenshot acquisition. */
function boundedAcquisition(page: TimingPage) {
  const evaluate = page.evaluate.bind(page);
  let layout = false;
  page.evaluate = async (source, input) => {
    if (!input && String(source).includes('scripts:')) layout = true;
    if (!input && String(source).includes('performance.now()') && !String(source).includes('scripts:') && layout) {
      layout = false;
      const current = await evaluate(() => ({ scripts: true }), undefined);
      return current.sampledMonoMs + 100;
    }
    return evaluate(source, input);
  };
}

class ScopedTimingPage extends TimingPage {
  step = 10; windowStart = 0; nativeRestoreRevision = 3; sourceStream = 0;
  gameUuid = 'game-a'; roomId = '12345'; handKey = 'a'.repeat(64); wallShift = 0; monoShift = 0;
  rules = { category: 1, mode: { mode: 2, detail_rule: { time_fixed: 300, time_add: 0 } } };
  override async evaluate(source: unknown, input?: any): Promise<any> {
    const result = await super.evaluate(source, input);
    if (input?.method === 'sync') {
      result.pageEpoch = this.pageEpoch; result.generation = this.generation; result.step = this.step;
      result.game_restore.actions.at(-1).step = this.step - 1;
      result.game_restore.actions[0].payload.sha256 = this.handKey;
      result.game_restore.passed_waiting_time = 18 + (this.index - 1 - this.windowStart) * 8;
      result.requestedMonoMs += this.monoShift; result.receivedMonoMs += this.monoShift;
      result.receivedAt = new Date(Date.parse(result.receivedAt) + this.monoShift + this.wallShift).toISOString();
      result.gameUuid = this.gameUuid; result.authSummary = { roomId: this.roomId, gameConfig: this.rules };
    } else if (input?.method === 'read') {
      Object.assign(result, { lastStep: this.step - 1, nativeRestoreRevision: this.nativeRestoreRevision,
        sourceStream: this.sourceStream, gameUuid: this.gameUuid, connected: true,
        authSummary: { roomId: this.roomId, gameConfig: this.rules } });
    } else if (typeof result === 'number') return result + this.monoShift;
    else if (result?.sampledMonoMs !== undefined) result.sampledMonoMs += this.monoShift;
    return result;
  }
  override async cdp(method: string) {
    assert.equal(method, 'Page.captureScreenshot');
    return { data: this.images[this.index - 1 - this.windowStart] };
  }
  nextWindow() { this.step += 2; this.generation++; this.windowStart = this.index; }
}

test('automatic acquisition combines real digit readback with two scoped wire samples', async () => {
  const page = new TimingPage();
  // Countdown acquisition's own latency budget remains under two seconds.
  const evaluate = page.evaluate.bind(page);
  let layout = false;
  page.evaluate = async (source, input) => {
    if (!input && String(source).includes('scripts:')) layout = true;
    if (!input && String(source).includes('performance.now()') && !String(source).includes('scripts:') && layout) {
      layout = false; return 5000 + (page.index-1)*8000 + 200;
    }
    return evaluate(source,input);
  };
  const result = await collectAutomaticTiming(page);
  const timing = deriveSyncOperationTiming(result.raw,2,result.evidence!);
  assert.equal(timing.remainingMs,274000); assert.equal(timing.uncertaintyMs,2100);
  assert.deepEqual(page.calls,['sync','sync']);
  assert.equal(result.evidence!.samples[0]!.displayedRemainingMs,282000);
});

test('an epoch or generation changed between sync and screenshot cannot supply evidence', async () => {
  const page = new TimingPage(); page.generation = 3;
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (source,input) => !input && !String(source).includes('scripts:')
    ? 5200 : evaluate(source,input);
  await assert.rejects(collectAutomaticTiming(page),/COUNTDOWN_SAMPLE_STALE/);
  assert.equal(page.calls.length,1);
});

test('a long-clock animation waits for digits but rejects a replacement window', async () => {
  const page = new TimingPage();
  const image = imageFor(fixtures.samples.find((s: any) => s.expectedSeconds === 282));
  for (let y = 630; y < 760; y++) for (let x = 1380; x < 1630; x++) {
    image.rgba.fill(0, (y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
  }
  page.images[0] = png(image);
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (source, input) => {
    if (!input && !String(source).includes('scripts:')) return 5200;
    const result = await evaluate(source, input);
    if (input?.method === 'sync' && page.index === 2) result.generation++;
    return result;
  };
  await assert.rejects(collectAutomaticTiming(page), /COUNTDOWN_SAMPLE_STALE/);
  assert.deepEqual(page.calls, ['sync', 'sync']);
});

test('same-hand later windows take fresh pixels and one sync, keeping the current deadline', async () => {
  const page = new ScopedTimingPage(); boundedAcquisition(page);
  const original = await collectAutomaticTiming(page);
  assert.equal(original.evidence!.samples.length, 2); assert.equal(original.evidence!.calibration, undefined);
  const calibration = structuredClone(original.evidence!.samples);
  // Returned reports cannot mutate the cache retained by the real page port.
  original.evidence!.samples[0]!.passedWaitingTime = 500;
  page.nextWindow();
  const current = await collectAutomaticTiming(page);
  assert.deepEqual(page.calls, ['sync', 'sync', 'sync']);
  assert.equal(current.evidence!.samples.length, 1);
  assert.deepEqual(current.evidence!.calibration!.samples, calibration);
  assert.equal(current.evidence!.samples[0]!.displayedRemainingMs, 282000);
  const timing = deriveSyncOperationTiming(current.raw, 3, current.evidence!);
  assert.equal(timing.remainingMs, 282000); assert.equal(timing.step, 11);
  assert.equal(timing.sampledMonoMs, current.raw.receivedMonoMs);
});

test('changed calibration scopes, expiry and clock offset collect a new pair', async t => {
  const changes: Record<string, (page: ScopedTimingPage) => void> = {
    page: page => { page.pageEpoch++; }, restore: page => { page.nativeRestoreRevision++; },
    game: page => { page.gameUuid = 'game-b'; }, room: page => { page.roomId = '54321'; },
    rules: page => { page.rules.mode.mode = 1; }, hand: page => { page.handKey = 'b'.repeat(64); },
    stream: page => { page.sourceStream++; },
    lifetime: page => { page.monoShift = 300_001; }, clock: page => { page.wallShift = 251; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const page = new ScopedTimingPage(); boundedAcquisition(page);
    await collectAutomaticTiming(page); page.nextWindow(); change(page);
    const result = await collectAutomaticTiming(page);
    assert.equal(result.evidence!.calibration, undefined); assert.equal(result.evidence!.samples.length, 2);
    assert.equal(page.calls.length, 4);
    deriveSyncOperationTiming(result.raw, 4, result.evidence!);
  });
});

test('persistent invalid pixels reject after bounded recollection without erasing independently verified unit evidence', async t => {
  const page = new ScopedTimingPage(); boundedAcquisition(page);
  const original=await collectAutomaticTiming(page);page.nextWindow();
  const capture = page.cdp.bind(page);
  const wrong = png(imageFor(fixtures.samples.find((s:any) => s.expectedSeconds === 95)));
  page.cdp = async () => ({data:wrong});
  const diagnostics:any[]=[];
  t.mock.method(console,'warn',(line:string)=>diagnostics.push(JSON.parse(line)));
  await assert.rejects(collectAutomaticTiming(page), /COUNTDOWN_PROTOCOL_MISMATCH/);
  assert.equal(page.calls.length,5);
  assert.equal(diagnostics.length,3);
  assert.equal(diagnostics[0].displayedRemainingMs,95000);
  assert.equal(diagnostics[0].passedWaitingTime,18);
  page.cdp = capture; page.nextWindow();
  const retry = await collectAutomaticTiming(page);
  assert.equal(retry.evidence!.samples.length,1);
  assert.deepEqual(retry.evidence!.calibration!.samples,original.evidence!.samples);
  assert.equal(page.calls.length,6);
});

test('a transient screenshot or sampling failure retains only the original unit pair for the next legal window',async t=>{
  for(const failure of ['COUNTDOWN_READBACK_STALE','COUNTDOWN_SAMPLE_STALE','COUNTDOWN_SCREENSHOT_INVALID'])await t.test(failure,async()=>{
    const page=new ScopedTimingPage();boundedAcquisition(page);
    const original=await collectAutomaticTiming(page),pair=structuredClone(original.evidence!.samples);
    page.nextWindow();
    const capture=page.cdp.bind(page);
    page.cdp=async()=>{throw Error(failure);};
    await assert.rejects(collectAutomaticTiming(page),new RegExp(failure));
    page.cdp=capture;page.nextWindow();
    const result=await collectAutomaticTiming(page);
    assert.equal(result.evidence!.samples.length,1);
    assert.deepEqual(result.evidence!.calibration!.samples,pair);
    assert.equal(page.calls.length,4);
    assert.equal(deriveSyncOperationTiming(result.raw,3,result.evidence!).sampledMonoMs,result.raw.receivedMonoMs);
  });
});

test('a same-hand empty offer retains calibration while terminal restores retire it',async t=>{
  for(const state of ['empty','match-end','hand-end'] as const)await t.test(state,async()=>{
    const page=new ScopedTimingPage();boundedAcquisition(page);
    const original=await collectAutomaticTiming(page);page.nextWindow();
    const evaluate=page.evaluate.bind(page);
    page.evaluate=async(source,input)=>{
      const raw=await evaluate(source,input);
      if(input?.method==='sync'){
        if(state==='match-end')raw.is_end=true;
        else if(state==='hand-end')raw.game_restore.actions.at(-1).name='ActionNoTile';
        else delete raw.game_restore.actions.at(-1).payload.operation;
      }
      return raw;
    };
    assert.equal((await collectAutomaticTiming(page)).evidence,null);
    page.evaluate=evaluate;page.nextWindow();
    const result=await collectAutomaticTiming(page);
    assert.equal(result.evidence!.samples.length,state==='empty'?1:2);
    if(state==='empty')assert.deepEqual(result.evidence!.calibration!.samples,original.evidence!.samples);
    else assert.equal(result.evidence!.calibration,undefined);
  });
});

test('retained evidence after a failed capture still rejects scope changes, clock drift and expiry',async t=>{
  for(const change of ['restore','scope','clock','expired'] as const)await t.test(change,async()=>{
    const page=new ScopedTimingPage();boundedAcquisition(page);
    const original=await collectAutomaticTiming(page);page.nextWindow();
    const capture=page.cdp.bind(page);
    page.cdp=async()=>{throw Error('COUNTDOWN_SAMPLE_STALE');};
    await assert.rejects(collectAutomaticTiming(page),/COUNTDOWN_SAMPLE_STALE/);
    page.cdp=capture;page.nextWindow();
    if(change==='restore')page.nativeRestoreRevision++;
    if(change==='scope')page.handKey='b'.repeat(64);
    if(change==='clock')page.wallShift=251;
    if(change==='expired')page.monoShift=300001;
    const result=await collectAutomaticTiming(page);
    assert.equal(result.evidence!.calibration,undefined);assert.equal(result.evidence!.samples.length,2);
    assert.notDeepEqual(result.evidence!.samples,original.evidence!.samples);
    deriveSyncOperationTiming(result.raw,3,result.evidence!);
  });
});

test('transient mismatched pixels are discarded before a fresh same-window unit pair', async t => {
  const page = new ScopedTimingPage(); boundedAcquisition(page);
  page.images = [274,274,265].map(value=>png(imageFor(fixtures.samples.find((s:any)=>s.expectedSeconds===value))));
  const diagnostics:any[]=[];
  t.mock.method(console,'warn',(line:string)=>diagnostics.push(JSON.parse(line)));
  const result=await collectAutomaticTiming(page);
  assert.equal(page.calls.length,3);
  assert.equal(diagnostics.length,1);
  assert.deepEqual(result.evidence!.samples.map(sample=>sample.displayedRemainingMs),[274000,265000]);
  assert.deepEqual(result.evidence!.samples.map(sample=>sample.passedWaitingTime),[26,34]);
  assert.equal(deriveSyncOperationTiming(result.raw,2,result.evidence!).remainingMs,266000);
});

test('transient mismatch recovery revalidates the existing pair without another calibration wait',async t=>{
  const page=new ScopedTimingPage();boundedAcquisition(page);
  const original=await collectAutomaticTiming(page);page.nextWindow();
  page.images=[274,274].map(value=>png(imageFor(fixtures.samples.find((s:any)=>s.expectedSeconds===value))));
  t.mock.method(console,'warn',()=>{});
  const result=await collectAutomaticTiming(page);
  assert.equal(page.calls.length,4);
  assert.equal(result.evidence!.samples.length,1);
  assert.equal(result.evidence!.samples[0]!.passedWaitingTime,26);
  assert.deepEqual(result.evidence!.calibration!.samples,original.evidence!.samples);
  assert.equal(deriveSyncOperationTiming(result.raw,3,result.evidence!).remainingMs,274000);
});

test('bank mismatch recollection retains the rejected numbers and validates the new bank pixels', async t => {
  const linux=JSON.parse(readFileSync(new URL('./fixtures/countdown/linux-masks.json',import.meta.url),'utf8'));
  const bankPng=(seconds:number)=>{
    const sample=linux.samples.find((s:any)=>s.kind==='bank-only' && s.expectedSeconds===seconds);
    const image={width:2036,height:918,rgba:new Uint8Array(2036*918*4)};
    for(let i=3;i<image.rgba.length;i+=4)image.rgba[i]=255;
    for(const a of TOOLBAR_PALETTES.linux)image.rgba.set([...a.rgb,255],(a.y*2036+a.x)*4);
    const mask=Buffer.from(sample.bitmapBase64,'base64');
    for(let i=0;i<250*130;i++)if(mask[i>>3]!>>(i%8)&1)
      image.rgba.set([240,190,90,255],((630+Math.floor(i/250))*2036+1380+i%250)*4);
    return png(image);
  };
  const page=new TimingPage();boundedAcquisition(page);
  page.images=[10,11,3].map(bankPng);
  const evaluate=page.evaluate.bind(page),diagnostics:any[]=[];
  page.evaluate=async(source,input)=>{
    const value=await evaluate(source,input);
    if(input?.method==='sync'){
      Object.assign(value.game_restore.actions.at(-1).payload.operation,{time_fixed:5000,time_add:20000});
      value.authSummary={gameConfig:{mode:{detail_rule:{time_fixed:5,time_add:20}}}};
      value.game_restore.passed_waiting_time=6+(page.index-1)*8;
    }
    return value;
  };
  t.mock.method(console,'warn',(line:string)=>diagnostics.push(JSON.parse(line)));
  const result=await collectAutomaticTiming(page);
  assert.equal(page.calls.length,3);
  assert.equal(diagnostics.length,1);
  assert.equal(diagnostics[0].code,'COUNTDOWN_BANK_MISMATCH');
  assert.equal(diagnostics[0].displayedBankMs,10000);
  assert.equal(diagnostics[0].passedWaitingTime,6);
  assert.deepEqual(result.evidence!.samples.map(sample=>sample.displayedBankMs),[11000,3000]);
  assert.equal(deriveSyncOperationTiming(result.raw,2,result.evidence!).remainingMs,3000);
});

test('mismatch recollection rejects replaced window, native restore and owner scopes', async t => {
  for(const changed of ['step','nativeRestoreRevision','gameUuid','controlEpoch']) await t.test(changed,async t=>{
    const page=new ScopedTimingPage();boundedAcquisition(page);
    page.images[0]=page.images[1]!;
    const evaluate=page.evaluate.bind(page);
    page.evaluate=async(source,input)=>{
      const result=await evaluate(source,input);
      if(page.index===2 && input?.method==='sync' && changed==='step')result.step++;
      if(page.index===2 && input?.method==='read')result[changed]=changed==='gameUuid'?'replacement':123;
      return result;
    };
    t.mock.method(console,'warn',()=>{});
    await assert.rejects(collectAutomaticTiming(page),/COUNTDOWN_SAMPLE_STALE/);
    assert.equal(page.calls.length,2);
  });
});

test('partial scope metadata cannot fall back to an unscoped calibration', async () => {
  const page = new ScopedTimingPage(); boundedAcquisition(page);
  await collectAutomaticTiming(page); page.nextWindow();
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (source, input) => {
    const result = await evaluate(source, input);
    if (input?.method === 'read') delete result.nativeRestoreRevision;
    return result;
  };
  await assert.rejects(collectAutomaticTiming(page), /COUNTDOWN_SAMPLE_STALE/);
});
