import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acceptLivePage } from '../src/app/live.ts';
import { replay } from '../src/app/replay.ts';
import { createLiveScenario as scenario, ScriptedPage } from './live-helpers.ts';

test('production acceptance assembly persists exactly one discard and exports an independently replayable capture', async () => {
  const h = await scenario();
  try {
    const report = await acceptLivePage(h.page, { ...h.options, discardOnce: true });
    assert.ok('scope' in report, JSON.stringify(report));
    assert.equal(report.status, 'passed'); assert.equal(report.scope, 'one-ordinary-discard');
    assert.equal(report.attempt?.status, 'confirmed'); assert.equal(report.attempt?.executionMode, 'live');
    assert.equal(report.counts.confirmations, 1); assert.equal(report.counts.outbox, 1);
    assert.equal(report.paused, true); assert.equal(report.automationEnabled, false);
    assert.equal(report.programPaused, true); assert.equal(report.clientAutoWinMayActAfterProgramPause, true);
    assert.equal(report.countdownSource, 'server-sync-and-client-pixels');
    assert.equal(h.page.prepared.timing.source, 'protocol-operation');
    assert.equal(h.page.sends, 1); assert.equal(h.page.prepared.tile, '0m');
    assert.equal(h.page.prepared.action.action.tsumogiri, true);
    assert.equal(h.page.controls.at(-1)?.paused, true);
    const replayed = await replay(report.captureDirectory, { outputDirectory: join(h.directory, 'replay') });
    assert.equal(replayed.status, 'passed'); assert.equal(replayed.ownDiscardFacts, 1);
    const serialized = await readFile(join(report.captureDirectory, 'events.jsonl'), 'utf8');
    assert.equal(serialized.includes('contract-only-game-uuid'), false);
    assert.equal(serialized.includes('contract-native-client-request'), false);
    assert.equal(serialized.includes('OperationOffered'), false);
  } finally { await h.cleanup(); }
});

test('room flags cannot replace automatic switch readback and final verification', async t => {
  for (const failure of ['initial','final'] as const) await t.test(failure, async () => {
    const h = await scenario();
    try {
      const evaluate = h.page.evaluate.bind(h.page);
      h.page.evaluate = async (source, argument) => {
        const method = (argument as {method:string}).method;
        if (method === (failure === 'initial' ? 'ensureAutoWin' : 'verifyAutoWin')) throw Error('AUTO_WIN_UNVERIFIED');
        return evaluate(source,argument);
      };
      const report = await acceptLivePage(h.page, { ...h.options, discardOnce:true });
      assert.equal(report.status,'blocked'); assert.equal(h.page.sends,0);
      assert.equal(h.page.calls.includes('prepare'),false);
      assert.equal(h.page.controls.at(-1)?.paused,true);
      const db = new DatabaseSync(h.page.databasePath,{readOnly:true});
      try {
        const rows = db.prepare('SELECT status FROM action_attempts').all();
        assert.equal(rows.length,failure === 'initial' ? 0 : 1);
        if (failure === 'final') assert.equal(rows[0]?.status,'not-dispatched');
      } finally {db.close();}
    } finally { await h.cleanup(); }
  });
});

test('sync-only assembly has no transmission even with a legal ordinary-discard window', async () => {
  const h = await scenario();
  try {
    const report = await acceptLivePage(h.page, h.options);
    assert.ok('scope' in report, JSON.stringify(report));
    assert.equal(report.scope, 'complete-current-hand-sync'); assert.equal(report.attempt, null);
    assert.equal(h.page.sends, 0); assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(report.counts.confirmations, 0); assert.equal(report.paused, true);
  } finally { await h.cleanup(); }
});

test('re-enabling the client switch re-acknowledges the original timing after local input revoked it', async () => {
  const h = await scenario();
  try {
    h.page.autoWinState = 'disabled'; h.page.autoWinNeedsEnable = true;
    const report = await acceptLivePage(h.page,{...h.options,room:{...h.options.room,autoWin:'unknown'},discardOnce:true});
    assert.equal(report.status,'passed'); assert.ok('autoWinReadback' in report);
    assert.equal(report.autoWinReadback.clicked,true);
    assert.ok(h.page.calls.indexOf('ensureAutoWin') < h.page.calls.indexOf('ackTiming'));
    assert.equal(h.page.prepared.expected.generation,1);
    assert.equal(h.page.prepared.timing.remainingMs,280000);
    assert.equal(h.page.sends,1);
  } finally { await h.cleanup(); }
});

test('an event racing the sync barrier prevents preparation and leaves the page paused', async () => {
  const h = await scenario();
  try {
    h.page.captureRace = true;
    const report = await acceptLivePage(h.page, { ...h.options, discardOnce: true });
    assert.equal(report.status, 'blocked'); assert.ok('code' in report); assert.equal(report.code, 'SYNC_CAPTURE_RACE');
    assert.equal(h.page.sends, 0); assert.equal(h.page.calls.includes('prepare'), false);
    assert.equal(h.page.controls.at(-1)?.paused, true);
    const raw = new DatabaseSync(h.page.databasePath, { readOnly: true });
    try { assert.equal(raw.prepare('SELECT count(*) AS n FROM action_attempts').get()?.n, 0); }
    finally { raw.close(); }
  } finally { await h.cleanup(); }
});

test('a refused or uncertain final send remains blocked without a retry or invented confirmation', async t => {
  for (const delivery of ['not-sent', 'unknown'] as const) await t.test(delivery, async () => {
    const h = await scenario();
    try {
      h.page.delivery = delivery;
      const report = await acceptLivePage(h.page, { ...h.options, discardOnce: true });
      assert.equal(report.status, 'blocked'); assert.ok('attempt' in report, JSON.stringify(report));
      assert.equal(report.attempt?.status, delivery === 'not-sent' ? 'not-dispatched' : 'uncertain');
      assert.equal(report.counts.confirmations, 0); assert.equal(report.counts.outbox, 0);
      assert.equal(report.paused, true); assert.equal(h.page.controls.at(-1)?.paused, true);
      assert.equal(h.page.calls.filter(c => c === 'dispatch').length, 1);
      assert.equal(h.page.sends, delivery === 'not-sent' ? 0 : 1);
      const stored = JSON.parse(await readFile(report.reportPath, 'utf8'));
      assert.equal(stored.status, 'blocked'); assert.equal(stored.attempt.status, report.attempt?.status);
    } finally { await h.cleanup(); }
  });
});

test('a new run and process cannot bypass an uncertain action in the shared game ledger', async () => {
  const h = await scenario();
  try {
    h.page.delivery = 'unknown';
    const first = await acceptLivePage(h.page, { ...h.options, discardOnce: true });
    assert.equal(first.status, 'blocked'); assert.ok('attempt' in first, JSON.stringify(first));
    assert.equal(first.attempt?.status, 'uncertain'); assert.equal(h.page.sends, 1);

    // A new connection/process may provide a fresh current-state sync, but that
    // alone cannot prove whether the previous command reached the server.
    const secondPage = new ScriptedPage(h.page.databasePath);
    const second = await acceptLivePage(secondPage, { ...h.options, outputDirectory: join(h.directory, 'second-run'),
      discardOnce: true });
    assert.equal(second.status, 'blocked'); assert.ok('code' in second);
    assert.equal(second.code, 'ACTION_RECONCILIATION_REQUIRED');
    assert.notEqual(second.sessionId, first.sessionId); assert.equal(second.databasePath, first.databasePath);
    assert.equal(secondPage.sends, 0); assert.equal(secondPage.calls.includes('prepare'), false);
    assert.equal(secondPage.controls.at(-1)?.paused, true);
    const raw = new DatabaseSync(h.page.databasePath, { readOnly: true });
    try {
      assert.equal(raw.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 2);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM action_attempts').get()?.n, 1);
      assert.equal(raw.prepare('SELECT status FROM action_attempts WHERE attempt_id=?').get(first.attempt!.id)?.status, 'uncertain');
      assert.equal(raw.prepare('SELECT count(*) AS n FROM action_confirmations').get()?.n, 0);
    } finally { raw.close(); }
  } finally { await h.cleanup(); }
});

test('live pause acceptance reaches the Page final fence and proves no dispatch', async () => {
  const h = await scenario();
  try {
    const report = await acceptLivePage(h.page, { ...h.options, discardOnce: true, pauseBeforeDispatch: true });
    assert.equal(report.status, 'passed'); assert.ok('attempt' in report);
    assert.equal(report.scope, 'pause-before-final-send');
    assert.equal(report.attempt?.status, 'not-dispatched'); assert.equal(report.attempt?.receipt?.delivery, 'not-sent');
    assert.equal(h.page.calls.filter(c => c === 'dispatch').length, 1);
    assert.equal(h.page.sends, 0); assert.equal(report.counts.confirmations, 0); assert.equal(report.paused, true);
  } finally { await h.cleanup(); }
});

test('a manual room claim cannot override a mismatched authoritative game configuration', async () => {
  const h = await scenario();
  try {
    const evaluate = h.page.evaluate.bind(h.page);
    h.page.evaluate = async (source, argument) => {
      const result = await evaluate(source, argument);
      if ((argument as { method: string }).method === 'read') result.authSummary.gameConfig.category = 2;
      return result;
    };
    const report = await acceptLivePage(h.page, { ...h.options, discardOnce: true });
    assert.equal(report.status, 'blocked'); assert.ok('code' in report);
    assert.equal(report.code, 'FRIEND_ROOM_READBACK_MISMATCH'); assert.equal(h.page.sends, 0);
    assert.equal(h.page.calls.includes('prepare'), false);
  } finally { await h.cleanup(); }
});
