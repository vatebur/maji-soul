import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveAutomation } from '../src/app/console/automation.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;

async function eventually(check: () => boolean) {
  const until = performance.now() + 5_000;
  while (!check()) { assert.ok(performance.now() < until, 'supervisor did not reach expected state'); await delay(10); }
}

test('supervisor leaves user-owned browser control untouched and waits for explicit re-enable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-supervisor-')), oldPath = process.env.PATH;
  const launcher = join(directory, 'ego-browser'), log = join(directory, 'launches');
  const automation = new LiveAutomation('1', 'p1', { room, outputDirectory: directory, sourceVersion: 'test' });
  try {
    await writeFile(launcher, `#!${process.execPath}\n
      import {appendFile} from 'node:fs/promises';
      await appendFile(${JSON.stringify(log)},'launch\\n');
      let source='';for await(const chunk of process.stdin)source+=chunk;
      globalThis.listTaskSpaces=async()=>[{id:1,ownership:'user'}];
      globalThis.claimTaskSpace=globalThis.takeOverTaskSpace=globalThis.taskSpace=()=>{throw Error('MUST_NOT_TAKE_CONTROL');};
      await (new Function('return (async()=>{'+source+'})()'))();
    `);
    await chmod(launcher, 0o700); process.env.PATH = `${directory}:${oldPath}`;
    await automation.start(); await eventually(() => automation.view.status === 'faulted');
    assert.equal(automation.view.errorCode, 'BROWSER_CONTROL_WITH_USER'); assert.equal(automation.view.enabled, false);
    await delay(1_100);
    assert.equal(await readFile(log, 'utf8'), 'launch\n');
  } finally { await automation.close(); process.env.PATH = oldPath; await rm(directory, { recursive: true, force: true }); }
});

test('operator stop during a worker failure backoff prevents automatic relaunch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-supervisor-')), oldPath = process.env.PATH;
  const launcher = join(directory, 'ego-browser'), log = join(directory, 'launches');
  const automation = new LiveAutomation('1', 'p1', { room, outputDirectory: directory, sourceVersion: 'test' });
  try {
    await writeFile(launcher, `#!${process.execPath}\nimport {appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(log)},'launch\\n');process.exit(1);`);
    await chmod(launcher, 0o700); process.env.PATH = `${directory}:${oldPath}`;
    await automation.start(); await eventually(() => automation.view.status === 'recovering');
    assert.equal(automation.view.recoveryCount, 1); assert.equal(automation.view.lastErrorCode, 'AUTOMATION_WORKER_FAILED');
    await automation.stop(); await automation.close();
    assert.equal(automation.view.status, 'stopped');
    assert.equal(await readFile(log, 'utf8'), 'launch\n');
  } finally { await automation.close(); process.env.PATH = oldPath; await rm(directory, { recursive: true, force: true }); }
});
