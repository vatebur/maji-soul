import childProcess, { type ExecFileSyncOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEgoCommand } from '../src/app/ego-cli.ts';

test('the observer CLI preserves explicit durations and allows the full bound plus cleanup time', async t => {
  const exec = t.mock.method(childProcess, 'execFileSync', () => 'contract-output');
  syncBuiltinESMExports();
  t.after(() => { exec.mock.restore(); syncBuiltinESMExports(); });
  for (const command of ['live-observe', 'live-sync', 'live-once', 'live-install', 'live-reconnect'] as const) {
    assert.equal(runEgoCommand(command, '1', 'p1', '/contract-options.json'), 'contract-output');
    const call = exec.mock.calls.at(-1)!;
    assert.equal(call.arguments[0], 'ego-browser');
    assert.deepEqual(call.arguments[1], ['nodejs']);
    const options = call.arguments[2] as ExecFileSyncOptions;
    assert.equal(options.timeout, command === 'live-observe' ? 1_860_000 : 60_000);
    if (command === 'live-observe') {
      // Execute the generated helper with only its module and browser ports replaced.
      // Explicit null must reach the broker's validator instead of becoming a default.
      const execute = new Function('taskSpace', 'loadModule', 'console',
        `return (async () => { ${String(options.input).replaceAll('import(', 'loadModule(')} })();`);
      for (const [configured, expected] of [[undefined, 30_000], [null, null], [0, 0], [1_800_000, 1_800_000]]) {
        let observed: unknown;
        await execute(async () => ({ page: () => ({}) }), async (specifier: string) =>
          specifier === 'node:fs/promises'
            ? { readFile: async () => JSON.stringify({ observeMs: configured }) }
            : { acceptLiveViaNode: async (_page: unknown, configuration: { observeMs: unknown }) => {
              observed = configuration.observeMs; return {};
            } }, { log() {} });
        assert.equal(observed, expected);
      }
    }
  }
});

test('the CLI only forwards Stage 2 enabling and selection on explicit commands', async t => {
  const exec=t.mock.method(childProcess,'execFileSync',()=> 'contract-output');
  syncBuiltinESMExports();
  t.after(()=>{exec.mock.restore();syncBuiltinESMExports();});
  const run=async(command:Parameters<typeof runEgoCommand>[0],argument?:string)=>{
    runEgoCommand(command,'1','p1',argument);
    const input=(exec.mock.calls.at(-1)!.arguments[2] as ExecFileSyncOptions).input;
    const execute=new Function('taskSpace','loadModule','console',
      `return (async () => { ${String(input).replaceAll('import(', 'loadModule(')} })();`);
    let observed:unknown;
    await execute(async()=>({page:()=>({})}),async(specifier:string)=>{
      if(specifier==='node:fs/promises')return {readFile:async()=>JSON.stringify({phase2ActionOnce:{kind:'pon'}})};
      return {installLiveBridge:async(_page:unknown,_reconnect:boolean,options:unknown)=>{observed=options;},
        acceptLiveViaNode:async(_page:unknown,options:unknown)=>{observed=options;}};
    },{log(){}});
    return observed;
  };
  assert.deepEqual(await run('live-install'),{phase2ActionsEnabled:false});
  assert.deepEqual(await run('live-reconnect','--phase2'),{phase2ActionsEnabled:true});
  assert.deepEqual(await run('live-sync','/options.json'),{discardOnce:false,observeMs:0});
  assert.deepEqual(await run('live-action-once','/options.json'),{discardOnce:false,observeMs:0,phase2ActionOnce:{kind:'pon'}});
});
