import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { saveEvidence } from '../src/observability/evidence.ts';

const engine = spawn('native/engine-runner/target/release/maji-engine-runner', [], { stdio: ['pipe','pipe','inherit'] });
const lines = createInterface({ input: engine.stdout });
const iterator = lines[Symbol.asyncIterator]();
const epoch = 'synthetic-spike';
const modelHash = 'sha256:33c20aaba3f349ef689df73b726224804dc4aaff99922093d8f30cc38d709a1d';
let id = 0;
async function call(method: string, params: unknown, scope: unknown = { handId: 'synthetic-hand', decisionId: 'synthetic-decision' }) {
  const requestId = `probe-${++id}`;
  engine.stdin.write(JSON.stringify({ v:1, id: requestId, runnerEpoch:epoch, method, scope, params }) + '\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const line = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { engine.kill(); reject(new Error('RUNNER_TIMEOUT')); }, 15000);
    })]);
    if (line.done) throw new Error('RUNNER_EOF');
    const response = JSON.parse(line.value);
    if (response.id !== requestId || response.v !== 1 || response.runnerEpoch !== epoch || !isDeepStrictEqual(response.scope, scope))
      throw new Error('RUNNER_CORRELATION_FAILED');
    return response;
  } finally { clearTimeout(timer); }
}
function requireOk(response: { ok: boolean; error?: { code: string }; result?: unknown }) {
  if (!response.ok) throw new Error(response.error?.code ?? 'RUNNER_ERROR');
  return response.result;
}
try {
  const start = performance.now();
  const initialized = requireOk(await call('init', { protocolVersion:1,
    sourceCommit:'63cea4b5d23d83bbee8d56bc3b9d547cca2046c3', modelHash }));
  const loadMs = Math.round(performance.now()-start);
  requireOk(await call('reset', { handId:'synthetic-hand', ownSeat:0, rules:'tenhou-default-probe-only' }));
  // Physically possible synthetic hands. This is not captured-client evidence or a game replay.
  const hands = [
    ['1m','2m','4m','5mr','7m','8m','1p','3p','5p','7p','1s','4s','9s'],
    ['1s','2s','3s','4s','5s','6s','7s','8s','9s','E','E','S','S'],
    ['1m','1m','2m','2m','3m','3m','4m','4m','5m','5m','6m','6m','7m'],
    ['1p','1p','2p','2p','3p','3p','4p','4p','6p','6p','7p','7p','8p']
  ];
  const events = [ { type:'start_game', names:['a','b','c','d'] },
    { type:'start_kyoku', bakaze:'E', dora_marker:'9p', kyoku:1, honba:0, kyotaku:0, oya:0, scores:[25000,25000,25000,25000], tehais:hands },
    { type:'tsumo', actor:0, pai:'E' } ].map((mjai,i) => ({ index:i+1, sourceEventId:`synthetic-${i+1}`, mjai }));
  requireOk(await call('advance', { expectedCursor:0, events }));
  const duplicate = requireOk(await call('replay', { expectedCursor:0, events }));
  const mismatch = await call('advance', { expectedCursor:0, events:[{...events[0],sourceEventId:'conflicting'}] });
  if (mismatch.ok || mismatch.error.code !== 'ENGINE_CURSOR_MISMATCH') throw new Error('CURSOR_CONFLICT_ACCEPTED');
  const snapshotHash = `sha256:${createHash('sha256').update(JSON.stringify(events)).digest('hex')}`;
  const durations: number[] = [];
  let decision: unknown;
  for (let i=0;i<21;i++) {
    const start = performance.now();
    decision = requireOk(await call('decide', { expectedCursor:3, stateVersion:3, snapshotHash }));
    durations.push(Number((performance.now()-start).toFixed(2)));
  }
  const sorted = durations.slice(1).sort((a,b)=>a-b);
  requireOk(await call('shutdown', { reason:'spike-complete' }));
  const evidence = { schemaVersion:1 as const, probe:'engine', status:'partial' as const,
    observedAt:new Date().toISOString(), evidenceType:'local-integration' as const, details: {
      initialized, loadMs, firstDecisionMs:durations[0], warmSamples:sorted.length, warmP50Ms:sorted[9], warmP95Ms:sorted[18],
      duplicateReplay:duplicate, cursorConflictRejected:true, decision,
      limitations:['synthetic opening only','Tenhou default rules, not verified friend-room rules','riichi missing tsumogiri is rejected','not connected to client','no submission-budget claim'] } };
  console.log(JSON.stringify({...evidence,evidencePath:await saveEvidence(evidence)},null,2));
} finally { lines.close(); engine.stdin.end(); engine.kill(); }
