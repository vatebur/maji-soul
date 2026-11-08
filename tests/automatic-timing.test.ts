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
