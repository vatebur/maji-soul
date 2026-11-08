import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { acceptLiveViaNode } from '../src/app/live-broker.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { createLiveScenario } from './live-helpers.ts';

test('the stdio broker hosts a real Node child and SQLite worker for sync-only acceptance', async () => {
  const h = await createLiveScenario();
  try {
    const report = await acceptLiveViaNode(h.page, h.options, process.execPath);
    assert.equal(report.status, 'passed'); assert.equal(report.scope, 'complete-current-hand-sync');
    assert.equal(report.attempt, null); assert.equal(report.paused, true); assert.equal(h.page.sends, 0);
    assert.equal(h.page.calls.includes('sync'), true); assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(h.page.controls.at(-1)?.paused, true);
    const raw = new DatabaseSync(h.page.databasePath, { readOnly: true });
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 4);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM action_attempts').get()?.n, 0);
      const state = JSON.parse(raw.prepare('SELECT projection FROM checkpoints').get()!.projection as string);
      assert.equal(state.state.ownConcealed.length, 14); assert.equal(state.state.trust, 'trusted');
    } finally { raw.close(); }
  } finally { await h.cleanup(); }
});

test('the child broker carries a persisted dispatch and authority confirmation across the Page RPC boundary', async () => {
  const h = await createLiveScenario();
  try {
    // ScriptedPage.prepare independently reads the child worker's dispatching row.
    const report = await acceptLiveViaNode(h.page, { ...h.options, discardOnce: true }, process.execPath);
    assert.equal(report.status, 'passed'); assert.equal(report.attempt.status, 'confirmed');
    assert.equal(report.attempt.executionMode, 'live'); assert.equal(report.counts.confirmations, 1);
    assert.equal(report.counts.outbox, 1); assert.equal(h.page.sends, 1);
    assert.equal(h.page.calls.filter(method => method === 'prepare').length, 1);
    assert.equal(h.page.calls.filter(method => method === 'dispatch').length, 1);
    assert.equal(h.page.prepared.tile, '0m'); assert.equal(h.page.controls.at(-1)?.paused, true);
  } finally { await h.cleanup(); }
});

test('Page failure replies cross stdio as a safe code and cannot prepare or leak error details', async () => {
  const h = await createLiveScenario();
  try {
    const sensitive = 'COOKIE=SHOULD_NOT_LEAK';
    const page: EgoPagePort = { evaluate: async (source, argument) => {
      if ((argument as { method: string }).method === 'automaticTiming') throw new Error(sensitive);
      return h.page.evaluate(source, argument);
    } };
    const report = await acceptLiveViaNode(page, { ...h.options, discardOnce: true }, process.execPath);
    assert.equal(report.status, 'blocked'); assert.equal(report.code, 'EGO_PAGE_FAILED');
    assert.equal(h.page.sends, 0); assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(h.page.controls.at(-1)?.paused, true);
    assert.equal(JSON.stringify(report).includes(sensitive), false);
    assert.equal((await readFile(report.reportPath, 'utf8')).includes(sensitive), false);
    const raw = new DatabaseSync(h.page.databasePath, { readOnly: true });
    try {
      assert.equal(raw.prepare('SELECT count(*) AS n FROM game_events').get()?.n, 0);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM action_attempts').get()?.n, 0);
    } finally { raw.close(); }
  } finally { await h.cleanup(); }
});

test('native failure receipts retain the known-not-sent versus uncertain distinction across stdio', async t => {
  for (const delivery of ['not-sent', 'unknown'] as const) await t.test(delivery, async () => {
    const h = await createLiveScenario();
    try {
      h.page.delivery = delivery;
      const report = await acceptLiveViaNode(h.page, { ...h.options, discardOnce: true }, process.execPath);
      assert.equal(report.status, 'blocked');
      assert.equal(report.attempt.status, delivery === 'not-sent' ? 'not-dispatched' : 'uncertain');
      assert.equal(report.attempt.receipt.delivery, delivery);
      assert.equal(report.counts.confirmations, 0); assert.equal(report.counts.outbox, 0);
      assert.equal(h.page.sends, delivery === 'not-sent' ? 0 : 1);
      assert.equal(h.page.calls.filter(method => method === 'dispatch').length, 1);
      assert.equal(h.page.controls.at(-1)?.paused, true);
    } finally { await h.cleanup(); }
  });
});

test('an unavailable child runtime fails with a safe error before any gameplay RPC', async () => {
  const h = await createLiveScenario();
  try {
    await assert.rejects(acceptLiveViaNode(h.page, h.options, '/definitely-missing-maji-node'), /LIVE_NODE_UNAVAILABLE/);
    assert.equal(h.page.calls.every(method => method === 'pause'), true);
  } finally { await h.cleanup(); }
});


test('console stop is forwarded to the real child and closes a long observation early', async () => {
  const h = await createLiveScenario();
  const cancellation = new AbortController();
  let stopped = false;
  const page: EgoPagePort = { evaluate: async (source, argument) => {
    const result = await h.page.evaluate(source, argument);
    if (!stopped && (argument as {method:string}).method === 'drain') {
      stopped = true;
      cancellation.abort();
    }
    return result;
  } };
  try {
    const began = Date.now();
    const report = await acceptLiveViaNode(page, { ...h.options, observeMs: 60_000 }, process.execPath, cancellation.signal);
    assert.equal(stopped, true);
    assert.ok(Date.now() - began < 10_000);
    assert.equal(report.programPaused, true);
    assert.equal(h.page.sends, 0);
    assert.equal(h.page.controls.at(-1)?.paused, true);
  } finally { await h.cleanup(); }
});
