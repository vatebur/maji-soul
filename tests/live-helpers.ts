import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import type { ActorControl } from '../src/application/game/actor.ts';
import type { CallReceipt } from '../src/domain/game/types.ts';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { sampleSyncOperationTiming } from '../src/adapters/majsoul/operation-timing.ts';

/** Scripted Page boundary; all state, attempt persistence and replay run production code.
 * The disposable fixture is contract evidence, never an actual browser acceptance claim. */
export class ScriptedPage implements EgoPagePort {
  readonly at = new Date().toISOString();
  readonly calls: string[] = [];
  readonly controls: ActorControl[] = [];
  readonly databasePath: string;
  sends = 0;
  captureRace = false;
  phase2ActionsEnabled = false;
  offerRiichi = false;
  delivery: CallReceipt['delivery'] = 'accepted';
  autoWinState = 'enabled';
  autoWinNeedsEnable = false;
  prepared: any;
  #records: unknown[] = [];
  #inputGeneration = 0;
  #timingVerified = false;
  constructor(databasePath: string) { this.databasePath = databasePath; }
  async evaluate(_source: string | ((argument: any) => any), argument?: unknown): Promise<any> {
    const { method, argument: input } = argument as { method: string; argument: any };
    this.calls.push(method);
    const operations = {seat:1,operation_list:this.offerRiichi ? [{type:1},{type:7,combination:['0m']}] : [{type:1}],
      time_fixed:300000,time_add:0};
    const cursor = { generation: this.sends + this.#inputGeneration, pageEpoch: 1, lastStep: 2 + this.sends, records: [],
      phase2ActionsEnabled:this.phase2ActionsEnabled,stats:{bridgeActionSends:this.sends},
      operation:{step:2,value:operations} };
    if (method === 'automaticTiming') {
      const raw = await this.evaluate(_source, { method: 'sync', argument: null });
      const previous = structuredClone(raw);
      previous.requestedMonoMs -= 2500; previous.receivedMonoMs -= 2500;
      previous.receivedAt = new Date(Date.parse(raw.receivedAt) - 2500).toISOString();
      previous.game_restore.passed_waiting_time -= 3;
      return { raw, evidence: { source: 'automatic-client-countdown', samples: [
        sampleSyncOperationTiming(previous, { remainingMs: 283000, sampledMonoMs: previous.receivedMonoMs }),
        sampleSyncOperationTiming(raw, { remainingMs: 280000, sampledMonoMs: raw.receivedMonoMs }),
      ] } };
    }
    if (method === 'ensureAutoWin' || method === 'verifyAutoWin') {
      let clicked = false;
      if (method === 'ensureAutoWin' && this.autoWinNeedsEnable) {
        // The real Unity toggle emits pointerdown. The bridge listener revokes
        // timing even though no game action RPC was sent.
        this.#inputGeneration++; this.#timingVerified = false;
        this.autoWinNeedsEnable = false; this.autoWinState = 'enabled'; clicked = true;
      }
      if (this.autoWinState !== 'enabled') throw Error('AUTO_WIN_UNVERIFIED');
      return { state: 'enabled', pageEpoch: 1, generation: this.sends + this.#inputGeneration, step: cursor.lastStep, clicked, source: 'contract-pixels-only' };
    }
    if (method === 'ackTiming') { this.#timingVerified = true; return { verified: true, pageEpoch: 1, step: cursor.lastStep }; }
    if (method === 'pause') {
      const control = input ?? { processInstanceId: 'emergency-pause', controlEpoch: 0, paused: true, reason: null };
      this.controls.push(control); return { paused: control.paused };
    }
    if (method === 'read') return { ...cursor, ownSeat: 1, gameUuid: 'contract-only-game-uuid', authSummary: { gameConfig: {
      category: 1, mode: { mode: 1, ai: true, detail_rule: { time_fixed: 300, time_add: 0 } },
    } } };
    if (method === 'sync') return { generation: 0, pageEpoch: 1, requestedMonoMs: 4900, receivedMonoMs: 5000, receivedAt: this.at, step: 3, is_end: false,
      game_restore: { game_state: 1, last_pause_time_ms: 0, passed_waiting_time: 20, actions: [{ name: 'ActionNewRound', step: 0, payload: {
        chang: 0, ju: 0, ben: 0, liqibang: 0, left_tile_count: 69, sha256: 'a'.repeat(64),
        scores: [25000, 25000, 25000, 25000], doras: ['4z'], opens: [],
        tiles: initialView().ownConcealed.slice(0, 13).map(t => t.code), operation: null,
      } },
        { name: 'ActionDiscardTile', step: 1, payload: { seat: 0, tile: '9m', moqie: false, is_liqi: false, is_wliqi: false } },
        { name: 'ActionDealTile', step: 2, payload: { seat: 1, tile: '0m', left_tile_count: 68,
          operation: operations } },
      ] } };
    if (method === 'ackSync') return { generation: 0, step: 2 };
    if (method === 'drain') {
      if (this.captureRace) return { ...cursor, generation: 1, lastStep: 1, records: [{ kind: 'action' }] };
      const records = this.#records.splice(0); return { ...cursor, records };
    }
    if (method === 'dispatchPrepared') {
      // Model the actual page's combined guard, retaining overrides used by
      // tests to inject a refusal before any simulated network send.
      let prepared;
      try {
        prepared = await this.evaluate(_source,{method:'prepare',argument:input});
        if(Date.parse(input.command.expiresAt)<=Date.now())throw Error('PERMIT_EXPIRED');
      } catch(error) {
        const allowed=['DEADLINE_EXCEEDED','PERMIT_EXPIRED','FENCE_STALE','INGRESS_PENDING','AUTO_WIN_UNVERIFIED'];
        const code=error instanceof Error && allowed.includes(error.message)?error.message:'BRIDGE_GUARD_FAILED';
        return{callId:`bridge:1:not-sent:${code}:00000000-0000-4000-8000-000000000000`,delivery:'not-sent',observedAt:new Date().toISOString()};
      }
      return this.evaluate(_source,{method:'dispatch',argument:{command:input.command,token:prepared.token}});
    }
    if (method === 'prepare') {
      assert.equal(this.#timingVerified,true,'toggle input revoked timing; acknowledge after enabling');
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
        payload: { seat: 1, tile: '0m', moqie: true, is_liqi: this.prepared.action.action.kind==='riichi-discard', is_wliqi: false } });
      return { callId: 'contract-native-client-request-7', delivery: this.delivery, observedAt: new Date().toISOString() };
    }
    throw Error('UNSCRIPTED_PAGE_METHOD');
  }
}

export async function createLiveScenario() {
  const directory = await mkdtemp(join(tmpdir(), 'maji-live-contract-')), run = join(directory, 'run');
  const page = new ScriptedPage(join(run, 'state.sqlite'));
  const options = { outputDirectory: run, databasePath: page.databasePath, room: buildPhase1Fixture().projection.room!, sourceVersion: 'contract-test-only' };
  return { directory, page, options, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
