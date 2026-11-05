import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import type { ActorControl } from '../src/application/game/actor.ts';
import type { CallReceipt } from '../src/domain/game/types.ts';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';

/** Scripted Page boundary; all state, attempt persistence and replay run production code.
 * The disposable fixture is contract evidence, never an actual browser acceptance claim. */
export class ScriptedPage implements EgoPagePort {
  readonly at = new Date().toISOString();
  readonly calls: string[] = [];
  readonly controls: ActorControl[] = [];
  readonly databasePath: string;
  sends = 0;
  captureRace = false;
  delivery: CallReceipt['delivery'] = 'accepted';
  prepared: any;
  #records: unknown[] = [];
  constructor(databasePath: string) { this.databasePath = databasePath; }
  async evaluate(_source: string | ((argument: any) => any), argument?: unknown): Promise<any> {
    const { method, argument: input } = argument as { method: string; argument: any };
    this.calls.push(method);
    const cursor = { generation: this.sends, pageEpoch: 1, lastStep: 2 + this.sends, records: [] };
    if (method === 'pause') {
      const control = input ?? { processInstanceId: 'emergency-pause', controlEpoch: 0, paused: true, reason: null };
      this.controls.push(control); return { paused: control.paused };
    }
    if (method === 'read') return { ...cursor, ownSeat: 1, gameUuid: 'contract-only-game-uuid', authSummary: { gameConfig: {
      category: 1, mode: { mode: 1, ai: true, detail_rule: { time_fixed: 300, time_add: 0 } },
    } } };
    if (method === 'sync') return { generation: 0, receivedAt: this.at, step: 3, is_end: false,
      game_restore: { actions: [{ name: 'ActionNewRound', step: 0, payload: {
        chang: 0, ju: 0, ben: 0, liqibang: 0, left_tile_count: 69, sha256: 'a'.repeat(64),
        scores: [25000, 25000, 25000, 25000], doras: ['4z'], opens: [],
        tiles: initialView().ownConcealed.slice(0, 13).map(t => t.code), operation: null,
      } },
        { name: 'ActionDiscardTile', step: 1, payload: { seat: 0, tile: '9m', moqie: false, is_liqi: false, is_wliqi: false } },
        { name: 'ActionDealTile', step: 2, payload: { seat: 1, tile: '0m', left_tile_count: 68,
          operation: { seat: 1, operation_list: [{ type: 1 }], time_fixed: 300000, time_add: 0 } } },
      ] } };
    if (method === 'ackSync') return { generation: 0, step: 2 };
    if (method === 'drain') {
      if (this.captureRace) return { ...cursor, generation: 1, lastStep: 1, records: [{ kind: 'action' }] };
      const records = this.#records.splice(0); return { ...cursor, records };
    }
    if (method === 'prepare') {
      // The page must receive an intent that the actual worker has already committed.
      const raw = new DatabaseSync(this.databasePath, { readOnly: true });
      try {
        const row = raw.prepare('SELECT status, execution_mode, body FROM action_attempts WHERE attempt_id=?').get(input.intent.id);
        assert.equal(row?.status, 'dispatching'); assert.equal(row?.execution_mode, 'live');
        assert.deepEqual(JSON.parse(row!.body as string), input.intent);
      } finally { raw.close(); }
      this.prepared = input;
      return { token: 'contract-page-token' };
    }
    if (method === 'dispatch') {
      assert.equal(input.token, 'contract-page-token');
      assert.deepEqual(input.command, this.prepared.command);
      if (this.controls.at(-1)?.paused) return { callId: 'contract-page-pause', delivery: 'not-sent', observedAt: new Date().toISOString() };
      if (this.delivery === 'not-sent') return { callId: 'contract-page-refusal', delivery: 'not-sent', observedAt: new Date().toISOString() };
      this.sends++;
      if (this.delivery === 'accepted') this.#records.push({ kind: 'action', name: 'ActionDiscardTile', step: 3, receivedAt: new Date().toISOString(),
        payload: { seat: 1, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false } });
      return { callId: 'contract-native-client-request-7', delivery: this.delivery, observedAt: new Date().toISOString() };
    }
    throw Error('UNSCRIPTED_PAGE_METHOD');
  }
}

export async function createLiveScenario() {
  const directory = await mkdtemp(join(tmpdir(), 'maji-live-contract-')), run = join(directory, 'run');
  const page = new ScriptedPage(join(run, 'state.sqlite'));
  const options = { outputDirectory: run, databasePath: page.databasePath, room: buildPhase1Fixture().projection.room!, sourceVersion: 'contract-test-only',
    countdown: { source: 'client-countdown' as const, step: 2, sampledAt: page.at, remainingMs: 280000, uncertaintyMs: 1000 } };
  return { directory, page, options, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
