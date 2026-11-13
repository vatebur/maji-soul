import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AutomationIncidentLog, automationIncident, parseAutomationIncident, type AutomationIncident } from '../src/app/console/automation-incidents.ts';
import { runAutomation } from '../src/app/console/automation-loop.ts';
import { LiveAutomation } from '../src/app/console/automation.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';

const room = buildPhase1Fixture().events.find(e => e.type === 'RoomVerified')!.payload.room;
const first = automationIncident('COUNTDOWN_LAYOUT_UNVERIFIED', 1, 'recovering', '2026-11-13T07:49:59.000Z');
const second = automationIncident('ROOM_NOT_READY', 2, 'recovering', '2026-11-13T07:50:00.000Z');

test('incident schema excludes raw errors, extra fields, unbounded codes and malformed metadata', () => {
  assert.deepEqual(parseAutomationIncident(first), first);
  for (const invalid of [null, [], { ...first, stack: 'PRIVATE' }, { ...first, cookie: 'PRIVATE' },
    { ...first, errorCode: 'Cookie=PRIVATE' }, { ...first, errorCode: 'A'.repeat(97) },
    { ...first, time: '2026-02-30T00:00:00.000Z' }, { ...first, status: 'playing' },
    { ...first, recoveryCount: -1 }, { ...first, recoveryCount: 1.5 }, { ...first, event: 'heartbeat' }])
    assert.equal(parseAutomationIncident(invalid), null);
  assert.equal(automationIncident('Cookie=PRIVATE\nstack', 1, 'faulted').errorCode, 'AUTOMATION_FAILED');
});

test('worker stderr parser forwards each complete incident once and discards raw or oversized content', () => {
  const lines: string[] = [], logger = new AutomationIncidentLog(line => { lines.push(line); });
  const encoded = JSON.stringify(first) + '\n';
  logger.consume('raw error Cookie=PRIVATE\n');
  logger.consume(encoded.slice(0, 19)); assert.equal(lines.length, 0);
  logger.consume(Buffer.from(encoded.slice(19)));
  logger.consume(encoded); logger.emit({ ...first, status: 'faulted' });
  logger.consume(JSON.stringify({ ...first, cookie: 'PRIVATE' }) + '\n');
  logger.consume('x'.repeat(10_000)); logger.consume(JSON.stringify(second) + '\n');
  logger.consume(JSON.stringify(second) + '\n');
  logger.consume(JSON.stringify(first).slice(0, 20)); logger.finish();
  logger.consume('worker stack\n');
  assert.deepEqual(lines.map(line => JSON.parse(line)), [first, second]);
  assert.equal(lines.some(line => line.includes('PRIVATE')), false);
});

test('fast consecutive recoveries retain the initial failure even when status snapshots are overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-incident-loop-'));
  const events: AutomationIncident[] = [];
  let waits = 0;
  try {
    await writeFile(join(directory, 'control.json'), '{"enabled":true}');
    await runAutomation({ evaluate: async () => null }, process.execPath, { room, outputDirectory: directory, sourceVersion: 'test' }, directory, {
      call: async () => ({ akagiEnabled: true, paused: true, authSummary: {}, matchEnded: false }),
      install: async () => { throw Error('UNEXPECTED_INSTALL'); },
      accept: async () => { throw Error('COUNTDOWN_LAYOUT_UNVERIFIED'); },
      recoverRoom: async () => { throw Error('ROOM_NOT_READY'); },
      sleep: async () => { if (++waits === 2) await writeFile(join(directory, 'control.json'), '{"enabled":false}'); },
      incident: event => { events.push(event); },
    });
    assert.deepEqual(events.map(event => [event.errorCode, event.recoveryCount, event.status]), [
      ['COUNTDOWN_LAYOUT_UNVERIFIED', 1, 'recovering'], ['ROOM_NOT_READY', 2, 'recovering'],
    ]);
    assert.equal(JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')).lastErrorCode, 'ROOM_NOT_READY');
    assert.ok(events.every(event => parseAutomationIncident(event)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('supervisor forwards only whitelisted worker incidents and logs its startup failure once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-incident-supervisor-')), oldPath = process.env.PATH;
  const launcher = join(directory, 'ego-browser'), lines: string[] = [];
  const automation = new LiveAutomation('1', 'p1', { room, outputDirectory: directory, sourceVersion: 'test' }, undefined, line => { lines.push(line); });
  try {
    await writeFile(launcher, `#!${process.execPath}\n
      let source='';for await(const chunk of process.stdin)source+=chunk;
      process.stderr.write('raw Cookie=PRIVATE\\n');
      process.stderr.write(${JSON.stringify(JSON.stringify({ ...first, cookie: 'PRIVATE' }) + '\n')});
      process.stderr.write(${JSON.stringify(JSON.stringify(first) + '\n')});
      process.stderr.write(${JSON.stringify(JSON.stringify(first) + '\n')});
      globalThis.listTaskSpaces=async()=>{throw Error('LOGIN_REQUIRED');};
      await (new Function('return (async()=>{'+source+'})()'))();
    `);
    await chmod(launcher, 0o700); process.env.PATH = `${directory}:${oldPath}`;
    await automation.start();
    const until = performance.now() + 5_000;
    while (!lines.some(line => JSON.parse(line).errorCode === 'LOGIN_REQUIRED')) {
      assert.ok(performance.now() < until); await delay(10);
    }
    assert.equal(automation.view.status, 'faulted');
    await automation.close();
    const events = lines.map(line => JSON.parse(line));
    assert.equal(lines.some(line => line.includes('PRIVATE')), false);
    assert.equal(events.filter(event => event.errorCode === 'COUNTDOWN_LAYOUT_UNVERIFIED').length, 1);
    assert.ok(events.every(event => parseAutomationIncident(event)));
    assert.equal(events.filter(event => event.errorCode === 'LOGIN_REQUIRED').length, 1);
  } finally { await automation.close(); process.env.PATH = oldPath; await rm(directory, { recursive: true, force: true }); }
});
