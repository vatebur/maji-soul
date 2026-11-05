import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StorageClient } from '../adapters/storage/client.ts';
import { GameActor } from '../application/game/actor.ts';
import { ActionExecutor, type ProductionTransport } from '../application/game/executor.ts';
import { bridgeCall, EgoProductionTransport, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import { handSourceStream, normalizeSyncGame } from '../adapters/majsoul/sync.ts';
import { normalizeAction, type VerifiedOperationTiming } from '../adapters/majsoul/normalize.ts';
import type { FriendRoom, GameObservation } from '../domain/game/types.ts';
import { digest, requireThat } from '../domain/game/value.ts';
import { exportLiveCapture } from './live-capture.ts';

export interface LiveAcceptanceOptions {
  outputDirectory: string; room: FriendRoom;
  /** Reuse this ledger across reconnects; defaults to the repository's live ledger. */
  databasePath?: string;
  /** An operator's current screenshot readback, bound to this exact protocol step. */
  countdown: VerifiedOperationTiming;
  sourceVersion: string;
  /** Explicit single-step selection, not an AI strategy or a fallback algorithm. */
  discardOnce?: boolean;
  /** Controlled live acceptance: revoke the page permit immediately before dispatch. */
  pauseBeforeDispatch?: boolean;
  countdownEvidence?: { screenshotPath: string; observedAt: string; displayedSeconds: number };
}

/** Uses the real worker, Actor, executor and Page bridge. Never loops decisions. */
export async function acceptLivePage(page: EgoPagePort, options: LiveAcceptanceOptions) {
  const directory = resolve(options.outputDirectory);
  await mkdir(resolve(directory, '..'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const sessionId = `live-${randomUUID()}`, databasePath = resolve(options.databasePath ?? fileURLToPath(new URL('../../data/live/state.sqlite', import.meta.url)));
  await mkdir(resolve(databasePath, '..'), { recursive: true, mode: 0o700 });
  const storage = new StorageClient(databasePath);
  let actor: GameActor | undefined;
  try {
    actor = await GameActor.open(storage, sessionId, randomUUID());
    const transport = new EgoProductionTransport(page);
    const guarded: ProductionTransport = { kind: 'live', invalidate: c => transport.invalidate(c),
      prepare: async (command, snapshot, intent) => {
        const send = await transport.prepare(command, snapshot, intent);
        return async action => {
          if (options.pauseBeforeDispatch) { actor!.pause(); await actor!.awaitControlBarrier(); }
          return send(action);
        };
      } };
    const executor = new ActionExecutor(actor, { transport: guarded, receiptTimeoutMs: 10_000 });
    await actor.awaitControlBarrier();
    const token = actor.beginSync(); await actor.awaitControlBarrier();
    const raw = await bridgeCall(page, 'sync');
    const pageState = await bridgeCall(page, 'read');
    requireThat(typeof pageState.gameUuid === 'string' && pageState.gameUuid.length > 0 && [0, 1, 2, 3].includes(pageState.ownSeat), 'GAME_IDENTITY_UNVERIFIED');
    const config = pageState.authSummary?.gameConfig;
    requireThat(config?.category === 1 && config.mode?.mode === 1 && config.mode.ai === true &&
      config.mode.detail_rule?.time_fixed === 300 && config.mode.detail_rule?.time_add === 0, 'FRIEND_ROOM_READBACK_MISMATCH');
    const gameMatchKey = `game-${digest(pageState.gameUuid).slice(0, 32)}`;
    const opening = raw.game_restore.actions.find((a: any) => a.name === 'ActionNewRound');
    requireThat(opening, 'SYNC_HAND_START_REQUIRED');
    // The server's per-hand commitment persists across reconnects. Public counters
    // and a coincidentally repeated opening hand cannot establish unique identity.
    const o = opening.payload ?? opening.data;
    requireThat(typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256), 'HAND_IDENTITY_UNVERIFIED');
    const gameHandKey = `hand-${digest([gameMatchKey, o.sha256]).slice(0, 32)}`;
    const sync = normalizeSyncGame(raw, { ...token, sessionId, room: options.room, gameMatchKey, gameHandKey,
      ownSeat: pageState.ownSeat, handOrdinal: 1, receivedAt: raw.receivedAt, timing: options.countdown });
    await actor.applySync(sync);
    await bridgeCall(page, 'ackSync', { generation: raw.generation, step: raw.step - 1 });
    const cursor = await bridgeCall(page, 'drain');
    requireThat(!cursor.reason && !cursor.overflow && cursor.records.length === 0 && cursor.lastStep === raw.step - 1, 'SYNC_CAPTURE_RACE');
    const subsequent: GameObservation[] = [];
    const pump = async () => {
      const batch = await bridgeCall(page, 'drain');
      if (batch.reason || batch.overflow) { actor!.failClosed(batch.overflow ? 'BRIDGE_QUEUE_OVERFLOW' : 'BRIDGE_UNTRUSTED'); throw Error('BRIDGE_UNTRUSTED'); }
      for (const record of batch.records) {
        if (record.kind !== 'action') { actor!.failClosed('BRIDGE_UNEXPECTED_RECORD'); throw Error('BRIDGE_UNEXPECTED_RECORD'); }
        const observations = normalizeAction(record.name, record.payload, { projection: actor!.projection,
          sourceStream: handSourceStream(gameMatchKey, gameHandKey), step: record.step,
          receivedAt: record.receivedAt, connectionEpoch: token.connectionEpoch });
        for (const observation of observations) { await actor!.ingest(observation); subsequent.push(observation); }
      }
    };
    let attemptId: string | null = null;
    if (options.discardOnce) {
      requireThat(options.room.autoWin === 'verified-on', 'AUTO_WIN_UNVERIFIED');
      transport.bind({ generation: cursor.generation, pageEpoch: cursor.pageEpoch, step: cursor.lastStep },
        { source: 'manual-client-countdown', budgetMs: 30_000, observedAt: options.countdown.sampledAt });
      await actor.resume();
      const snapshot = await actor.freezeDecision();
      const selected = snapshot.legalActions.find(a => a.action.kind === 'discard' && a.action.tsumogiri);
      requireThat(selected, 'ORDINARY_DRAW_REQUIRED');
      const attempt = await executor.executeLive(snapshot.id, selected.id); attemptId = attempt.id;
      const until = performance.now() + 10_000;
      while (['dispatching', 'awaiting-confirmation'].includes((await storage.getAttempt(attemptId))?.status ?? '') && performance.now() < until) {
        await pump();
        await new Promise(r => setTimeout(r, 100));
      }
    }
    actor.pause(); await actor.awaitControlBarrier();
    const inspection = await storage.inspect(sessionId);
    const attempt = attemptId ? await storage.getAttempt(attemptId) : null;
    const capture = await exportLiveCapture(join(directory, 'capture'), sessionId, sync, subsequent, options.sourceVersion);
    const pageAfter = await bridgeCall(page, 'read');
    const expectedStatus = options.pauseBeforeDispatch ? 'not-dispatched' : 'confirmed';
    const passed = !attempt || attempt.status === expectedStatus;
    const report = { schemaVersion: 1, evidenceKind: 'current-client-integration', status: passed ? 'passed' : 'blocked',
      scope: options.pauseBeforeDispatch ? 'pause-before-final-send' : options.discardOnce ? 'one-ordinary-discard' : 'complete-current-hand-sync', sessionId, databasePath,
      attempt, counts: inspection.counts, finalStateHash: digest(inspection.projection.state),
      paused: actor.control.paused && actor.control.controlPending === 0,
      countdownSource: 'manual-screenshot-readback', countdownEvidence: options.countdownEvidence ?? null,
      browserStatsBefore: cursor.stats ?? null, browserStatsAfter: pageAfter.stats ?? null,
      automationEnabled: false, captureDirectory: capture.directory,
      reportPath: join(directory, 'report.json') };
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } catch (error) {
    if (actor) { actor.pause(); await actor.awaitControlBarrier().catch(() => {}); }
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LIVE_ACCEPTANCE_FAILED';
    const report = { schemaVersion: 1, evidenceKind: 'current-client-integration', status: 'blocked', code,
      sessionId, databasePath, automationEnabled: false, reportPath: join(directory, 'report.json') };
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    if (actor) { actor.pause(); await actor.awaitControlBarrier().catch(() => {}); await actor.idle(); }
    await storage.close();
  }
}
