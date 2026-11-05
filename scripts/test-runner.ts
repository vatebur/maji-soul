import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const executable = 'native/engine-runner/target/release/maji-engine-runner';
const init = { v:1,id:'init',runnerEpoch:'epoch-1',method:'init',scope:{},params:{protocolVersion:1,
  sourceCommit:'63cea4b5d23d83bbee8d56bc3b9d547cca2046c3',
  modelHash:'sha256:33c20aaba3f349ef689df73b726224804dc4aaff99922093d8f30cc38d709a1d'} };
function run(input: string) { const result = spawnSync(executable,[],{input,encoding:'utf8',timeout:15000,maxBuffer:2**21});if(result.error)throw result.error;return result; }
test('runner closes its connection on malformed JSON, unknown protocol and oversized frames', () => {
  for (const input of ['{\n',JSON.stringify({...init,v:2})+'\n',' '.repeat(2**20+1)+'\n']) {
    const result = run(input); assert.equal(result.status,2);assert.equal(result.stdout,'');
  }
});
test('runner rejects stale process epochs and unsupported rules without changing state', () => {
  const reset={...init,id:'reset',method:'reset',scope:{handId:'h1'},params:{handId:'h1',ownSeat:0,rules:'unknown'}};
  const result=run([init,{...init,id:'stale',runnerEpoch:'epoch-2'},reset,{...reset,id:'reset-valid',params:{...reset.params,rules:'tenhou-default-probe-only'}}].map(x=>JSON.stringify(x)+'\n').join(''));
  assert.equal(result.status,0);
  const responses=result.stdout.trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(responses[0].ok,true);
  assert.equal(responses[1].error.code,'RUNNER_EPOCH_MISMATCH');
  assert.equal(responses[2].error.code,'UNSUPPORTED_RULES');
  assert.equal(responses[3].result.cursor,0);
});
