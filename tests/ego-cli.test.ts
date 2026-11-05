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
