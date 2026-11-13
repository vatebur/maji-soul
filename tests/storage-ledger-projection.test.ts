import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageDatabase } from '../src/adapters/storage/database.ts';
import type { GameObservation, ObservationPayloads } from '../src/domain/game/types.ts';

const scores = { 0: 31000, 1: 27000, 2: 23000, 3: 19000 };
const hand: ObservationPayloads['HandEnded'] = { scores, reason: 'win', winners: [0], resultLabel: '完整结算', matchEnded: true };
const match: ObservationPayloads['MatchEnded'] = { scores, ranks: { 0: 1, 1: 2, 2: 3, 3: 4 } };

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'maji-ledger-projection-'));
  const path = join(directory, 'state.sqlite'), storage = new StorageDatabase(path), raw = new DatabaseSync(path);
  const sequences = new Map<string, number>();
  return {
    storage, raw, path,
    append(session: string, type: string, payload: unknown) {
      if (!sequences.has(session)) storage.openSession(session, `process-${session}`, '2026-11-05T00:00:00.000Z');
      const sequence = (sequences.get(session) ?? 0) + 1;
      sequences.set(session, sequence);
      raw.prepare('INSERT INTO game_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`${session}-${sequence}`, session, sequence, 0, `${sequence}`, `fingerprint-${sequence}`, type, JSON.stringify(payload));
    },
    close() { raw.close(); storage.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
function sync(gameMatchKey: string, gameHandKey: string, handOrdinal = 1, terminal?: unknown) {
  return { gameMatchKey, gameHandKey, handOrdinal, ...(terminal === undefined ? {} : { terminal }) };
}

test('ledger projection retains other-match sync rows that reset a shared session context', () => {
  const h = harness();
  try {
    h.append('shared', 'SyncApplied', sync('target', 'target-1'));
    h.append('shared', 'SyncApplied', sync('other', 'other-1'));
    h.append('shared', 'HandStarted', { type: 'HandStarted', payload: { gameHandKey: 'other-2', ordinal: 2 } });
    h.append('shared', 'HandEnded', { type: 'HandEnded', payload: hand });
    h.append('shared', 'MatchEnded', { type: 'MatchEnded', payload: match });
    assert.deepEqual(h.storage.inspectMatch('target'), {
      gameMatchKey: 'target', hands: [{ gameHandKey: 'target-1', ordinal: 1, status: 'playing' }],
      matchStatus: 'playing', unresolvedAttempts: [],
    });
    const other = h.storage.inspectMatch('other');
    assert.equal(other.hands.length, 2); assert.deepEqual(other.hands[1]!.result, hand);
    assert.deepEqual(other.matchResult, match);
  } finally { h.close(); }
});

test('interleaved sessions preserve lifecycle order and the complete nested terminal JSON', () => {
  const h = harness();
  try {
    h.append('first', 'SyncApplied', sync('target', 'target-1', 1, { hand }));
    h.append('second', 'SyncApplied', sync('target', 'target-1', 1, { hand, match }));
    h.append('first', 'MatchStarted', { type: 'MatchStarted', payload: { gameMatchKey: 'other' } });
    h.append('first', 'HandStarted', { type: 'HandStarted', payload: { gameHandKey: 'other-1', ordinal: 1 } });
    h.append('first', 'HandEnded', { type: 'HandEnded', payload: { ...hand, resultLabel: '另一对局' } });
    h.append('second', 'HandEnded', { type: 'HandEnded', payload: hand });
    const ledger = h.storage.inspectMatch('target');
    assert.deepEqual(ledger.hands, [{ gameHandKey: 'target-1', ordinal: 1, status: 'finished', result: hand }]);
    assert.deepEqual(ledger.matchResult, match); assert.equal(ledger.matchStatus, 'finished');
    assert.equal(h.storage.inspectMatch('other').hands[0]!.result!.resultLabel, '另一对局');
  } finally { h.close(); }
});

for (const field of ['scores', 'reason', 'winners', 'resultLabel', 'match-ranks'] as const) {
  test(`projected sync retains the ${field} settlement conflict fence`, () => {
    const h = harness();
    try {
      h.append('first', 'SyncApplied', sync('target', 'hand-1', 1, { hand, match }));
      const changedHand = structuredClone(hand), changedMatch = structuredClone(match);
      if (field === 'scores') { changedHand.scores[0] = 32000; changedHand.scores[1] = 26000; }
      if (field === 'reason') changedHand.reason = 'draw';
      if (field === 'winners') changedHand.winners = [1];
      if (field === 'resultLabel') changedHand.resultLabel = '冲突结算';
      if (field === 'match-ranks') changedMatch.ranks = { 0: 4, 1: 3, 2: 2, 3: 1 };
      h.append('second', 'SyncApplied', sync('target', 'hand-1', 1, { hand: changedHand, match: changedMatch }));
      assert.throws(() => h.storage.inspectMatch('target'), field === 'match-ranks' ? /MATCH_LEDGER_RESULT_CONFLICT/ : /HAND_LEDGER_RESULT_CONFLICT/);
    } finally { h.close(); }
  });
}

test('missing and null terminal metadata both remain nonterminal; empty nested values retain their JSON types', () => {
  const h = harness();
  try {
    h.append('first', 'SyncApplied', sync('target', 'hand-1'));
    h.append('first', 'SyncApplied', sync('target', 'hand-1', 1, null));
    assert.equal(h.storage.inspectMatch('target').hands[0]!.status, 'playing');
    const emptyLabelHand = { ...hand, winners: [], resultLabel: '' };
    h.append('second', 'SyncApplied', sync('target', 'hand-1', 1, { hand: emptyLabelHand, match: null }));
    const ledger = h.storage.inspectMatch('target');
    assert.deepEqual(ledger.hands[0]!.result, emptyLabelHand);
    assert.equal(ledger.matchStatus, 'pending-result'); assert.equal(ledger.matchResult, undefined);
  } finally { h.close(); }
});

test('large captured histories from many games never enter the JS ledger parser', t => {
  const h = harness();
  try {
    const history = readFileSync(new URL('./fixtures/phase1-live-discard/events.jsonl', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as GameObservation);
    const opening = history.find(event => event.type === 'HandStarted');
    assert.ok(opening?.type === 'HandStarted');
    let persistedBytes = 0;
    for (let game = 0; game < 40; game++) {
      const payload = { ...sync(`game-${game}`, `hand-${game}`), historyCoverage: 'complete-hand',
        handHistory: history, currentView: opening.payload.initialView, observedActions: history.filter(event => event.type === 'TileDiscarded') };
      persistedBytes += Buffer.byteLength(JSON.stringify(payload));
      h.append('shared-history', 'SyncApplied', payload);
    }
    assert.ok(persistedBytes > 100_000);
    const parse = JSON.parse, parsed: string[] = [];
    const mock = t.mock.method(JSON, 'parse', (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      parsed.push(text); return parse(text, reviver);
    });
    let ledger: ReturnType<StorageDatabase['inspectMatch']>;
    try { ledger = h.storage.inspectMatch('game-17'); } finally { mock.mock.restore(); }
    assert.deepEqual(ledger.hands, [{ gameHandKey: 'hand-17', ordinal: 1, status: 'playing' }]);
    assert.equal(parsed.length, 40); // Other-game rows still update their session's context.
    assert.ok(parsed.every(text => !text.includes('handHistory') && !text.includes('currentView') && !text.includes('observedActions')));
    assert.ok(parsed.reduce((sum, text) => sum + Buffer.byteLength(text), 0) < persistedBytes / 20);
  } finally { h.close(); }
});

test('the actual ledger query uses the covering index without evaluating historical JSON', t => {
  const h = harness();
  try {
    h.append('first', 'SyncApplied', sync('target', 'hand-1', 1, { hand, match }));
    const prepare = DatabaseSync.prototype.prepare;
    let query = '';
    const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      if (sql.includes('AS payload') && sql.includes('FROM game_events')) query = sql;
      return prepare.call(this, sql);
    });
    try { assert.deepEqual(h.storage.inspectMatch('target').matchResult, match); } finally { mock.mock.restore(); }
    assert.ok(query);
    const plan = h.raw.prepare('EXPLAIN QUERY PLAN ' + query).all().map(row => String(row.detail));
    assert.ok(plan.some(detail => detail.includes('USING COVERING INDEX game_events_ledger_metadata')));
    assert.ok(plan.some(detail => detail.includes('ORDER BY'))); // Restore original rowid context order.
    const bytecode = h.raw.prepare('EXPLAIN ' + query).all();
    assert.equal(bytecode.filter(row => row.opcode === 'Function' && String(row.p4).startsWith('json_')).length, 0);
  } finally { h.close(); }
});

test('schema 4 remains readable without mutation and upgrades populated history atomically to schema 5', () => {
  const h = harness();
  try {
    h.append('shared', 'SyncApplied', sync('target', 'hand-1', 1, { hand, match }));
    h.append('shared', 'SyncApplied', sync('other', 'other-1'));
    h.append('shared', 'HandEnded', { type: 'HandEnded', payload: { ...hand, resultLabel: 'other' } });
    const expected = h.storage.inspectMatch('target');
    // Removing only the new additive index reproduces the existing schema 4.
    h.raw.exec('DROP INDEX game_events_ledger_metadata; PRAGMA user_version=4;');
    const before = h.raw.prepare('SELECT rowid,* FROM game_events ORDER BY rowid').all();
    const reader = new StorageDatabase(h.path, true);
    try {
      assert.deepEqual(reader.inspectMatch('target'), expected);
      assert.equal(h.raw.prepare('PRAGMA user_version').get()?.user_version, 4);
      assert.equal(h.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='game_events_ledger_metadata'").get()?.n, 0);
    } finally { reader.close(); }
    const upgraded = new StorageDatabase(h.path);
    try {
      assert.equal(h.raw.prepare('PRAGMA user_version').get()?.user_version, 5);
      assert.deepEqual(upgraded.inspectMatch('target'), expected);
      assert.equal(upgraded.inspectMatch('other').hands[0]!.result!.resultLabel, 'other');
      assert.deepEqual(h.raw.prepare('SELECT rowid,* FROM game_events ORDER BY rowid').all(), before);
      assert.equal(h.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='game_events_ledger_metadata'").get()?.n, 1);
    } finally { upgraded.close(); }
  } finally { h.close(); }
});

test('a failure after index creation rolls the migration back and permits a clean retry', t => {
  const h = harness();
  try {
    h.append('first', 'SyncApplied', sync('target', 'hand-1', 1, { hand, match }));
    const expected = h.storage.inspectMatch('target');
    h.raw.exec('DROP INDEX game_events_ledger_metadata; PRAGMA user_version=4;');
    const before = h.raw.prepare('SELECT rowid,* FROM game_events ORDER BY rowid').all();
    const exec = DatabaseSync.prototype.exec;
    const mock = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
      if (sql === 'PRAGMA user_version=5;') throw new Error('INJECTED_VERSION_WRITE_FAILURE');
      return exec.call(this, sql);
    });
    try { assert.throws(() => new StorageDatabase(h.path), /INJECTED_VERSION_WRITE_FAILURE/); }
    finally { mock.mock.restore(); }
    assert.equal(h.raw.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.equal(h.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='game_events_ledger_metadata'").get()?.n, 0);
    assert.deepEqual(h.raw.prepare('SELECT rowid,* FROM game_events ORDER BY rowid').all(), before);
    const retried = new StorageDatabase(h.path);
    try {
      assert.equal(h.raw.prepare('PRAGMA user_version').get()?.user_version, 5);
      assert.deepEqual(retried.inspectMatch('target'), expected);
    } finally { retried.close(); }
  } finally { h.close(); }
});
