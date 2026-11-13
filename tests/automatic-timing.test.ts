import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAutomaticTiming } from '../src/adapters/majsoul/automatic-timing.ts';
import { deriveSyncOperationTiming } from '../src/adapters/majsoul/operation-timing.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { fixtures, imageFor, png } from './countdown-helpers.ts';

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

test('an invalid fresh pixel reading rejects and clears the retained calibration', async () => {
  const page = new ScopedTimingPage(); boundedAcquisition(page);
  await collectAutomaticTiming(page); page.nextWindow();
  const original = page.images[0]!; page.images[0] = page.images[1]!;
  await assert.rejects(collectAutomaticTiming(page), /COUNTDOWN_PROTOCOL_MISMATCH/);
  page.images[0] = original; page.nextWindow();
  const retry = await collectAutomaticTiming(page);
  assert.equal(retry.evidence!.calibration, undefined); assert.equal(retry.evidence!.samples.length, 2);
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
