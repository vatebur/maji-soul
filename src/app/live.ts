import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StorageClient } from '../adapters/storage/client.ts';
import { GameActor } from '../application/game/actor.ts';
import { ActionExecutor, type ProductionTransport } from '../application/game/executor.ts';
import { bridgeCall, EgoProductionTransport, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import type { FriendRoom } from '../domain/game/types.ts';
import { digest, requireThat } from '../domain/game/value.ts';
import { exportLiveCapture } from './live-capture.ts';
import { requireLiveActionScope, selectLiveAction, validateLiveActionSelection, type LiveActionSelection } from './live-action-selection.ts';
import { isBoundaryProofFailure, LiveBoundaryFenceChallenge } from './live-boundary-fence.ts';
import { LiveGameSession, summarizeBrowserStats } from './live-session.ts';
import { validateObservationDuration } from './live-observation.ts';

export interface LiveAcceptanceOptions {
  outputDirectory: string; room: FriendRoom;
  /** Reuse this ledger across reconnects; defaults to the repository's live ledger. */
  databasePath?: string;
  sourceVersion: string;
  /** Bounded lifecycle observation; never chooses or repeats program actions. */
  observeMs?: number;
  /** Explicit single-step selection, not an AI strategy or a fallback algorithm. */
  discardOnce?: boolean;
  /** Explicit Stage 2 candidate selection in a fresh, single-window run. */
  phase2ActionOnce?: LiveActionSelection;
  /** Controlled live acceptance: revoke the page permit immediately before dispatch. */
  pauseBeforeDispatch?: boolean;
  /** In an observation, retain one Actor decision/permit and challenge it after a real new hand. */
  verifyBoundaryFences?: boolean;
}

/** Uses the real worker, Actor, executor and Page bridge. Never loops decisions. */
export async function acceptLivePage(page: EgoPagePort, options: LiveAcceptanceOptions) {
  const observeMs = validateObservationDuration(options.observeMs);
  const selectedPhase2 = options.phase2ActionOnce;
  if (selectedPhase2 !== undefined) {
    validateLiveActionSelection(selectedPhase2);
    requireThat(observeMs===0 && !options.discardOnce && !options.pauseBeforeDispatch && !options.verifyBoundaryFences,
      'INVALID_LIVE_ACTION_SELECTION');
  }
  requireThat(options.verifyBoundaryFences===undefined || options.verifyBoundaryFences===false ||
    options.verifyBoundaryFences===true && observeMs>0 && !options.discardOnce && !options.pauseBeforeDispatch, 'INVALID_BOUNDARY_FENCE_CHALLENGE');
  const boundaryChallenge = options.verifyBoundaryFences ? new LiveBoundaryFenceChallenge() : undefined;
  const directory = resolve(options.outputDirectory);
  await mkdir(resolve(directory, '..'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const sessionId = `live-${randomUUID()}`, databasePath = resolve(options.databasePath ?? fileURLToPath(new URL('../../data/live/state.sqlite', import.meta.url)));
  await mkdir(resolve(databasePath, '..'), { recursive: true, mode: 0o700 });
  const storage = new StorageClient(databasePath);
  let actor: GameActor | undefined;
  let executor: ActionExecutor | undefined;
  let liveSession: LiveGameSession | undefined;
  try {
    actor = await GameActor.open(storage, sessionId, randomUUID());
    const transport = boundaryChallenge ? undefined : new EgoProductionTransport(page);
    if (transport) {
      const guarded: ProductionTransport = { kind: 'live', invalidate: c => transport.invalidate(c),
        prepare: async (command, snapshot, intent) => {
          const send = await transport.prepare(command, snapshot, intent);
          return async action => {
            if (options.pauseBeforeDispatch) { actor!.pause(); await actor!.awaitControlBarrier(); }
            return send(action);
          };
        } };
      executor = new ActionExecutor(actor, { transport: guarded, receiptTimeoutMs: 10_000 });
    } else {
      // The diagnostic temporarily resumes only the Actor. Every control message
      // keeps the Page paused, including the Actor's local resume publication.
      actor.attachControlSink(async control => {
        const response = await bridgeCall(page, 'pause', { ...control, paused: true });
        requireThat(response?.paused===true, 'BOUNDARY_PAGE_NOT_PAUSED');
      });
    }
    await actor.awaitControlBarrier();
    const session = liveSession = new LiveGameSession(actor,page,options.room);
    const {cursor,timing,timingEvidence,autoWinReadback} = await session.synchronize(
      !!boundaryChallenge || observeMs===0 || options.discardOnce===true,
    ).catch(error => {
      if (!boundaryChallenge || !isBoundaryProofFailure(error)) throw error;
      boundaryChallenge.failArming(error);
      return session.synchronize(false);
    });
    if (boundaryChallenge) await boundaryChallenge.arm(actor, page, cursor);
    const initial = actor.projection;
    const initialOffer=observeMs===0 && !options.discardOnce && !selectedPhase2 &&
      initial.state?.operationWindow?.status==='open' ? {
        gameMatchKey:initial.gameMatchKey,gameHandKey:initial.gameHandKey,step:cursor.lastStep,
        offer:cursor.operation??null,candidates:initial.state.operationWindow.candidates,ownConcealed:initial.state.ownConcealed,
      } : null;
    let attemptId: string | null = null;
    if (options.discardOnce || selectedPhase2) {
      requireThat(transport && executor, 'INVALID_BOUNDARY_FENCE_CHALLENGE');
      requireThat(timing, 'TIMING_EVIDENCE_REQUIRED');
      if (selectedPhase2) {
        requireThat(cursor.phase2ActionsEnabled===true, 'PHASE2_ACTIONS_DISABLED');
        requireLiveActionScope(actor.projection,selectedPhase2);
      }
      transport.bind({ generation: cursor.generation, pageEpoch: cursor.pageEpoch, step: cursor.lastStep },
        timing);
      await liveSession.coordinator.resume();
      const snapshot = await actor.freezeDecision();
      const selected = selectedPhase2 ? selectLiveAction(snapshot,selectedPhase2) :
        snapshot.legalActions.find(a => a.action.kind === 'discard' && a.action.tsumogiri);
      requireThat(selected, 'ORDINARY_DRAW_REQUIRED');
      const attempt = await executor.executeLive(snapshot.id, selected.id); attemptId = attempt.id;
      const until = performance.now() + 10_000;
      while (['dispatching', 'awaiting-confirmation'].includes((await storage.getAttempt(attemptId))?.status ?? '') && performance.now() < until) {
        await liveSession.pump();
        await new Promise(r => setTimeout(r, 100));
      }
    }
    const pump = async () => {
      const handStarts = session.counts.handStarts;
      await session.pump();
      if (session.counts.handStarts>handStarts) boundaryChallenge?.checkAfterHandStart(actor!);
    };
    const observeUntil = performance.now()+observeMs;
    while (observeMs>0 && performance.now()<observeUntil && actor.projection.matchStatus!=='finished') {
      await pump();
      await new Promise(r=>setTimeout(r,100));
    }
    actor.pause(); await actor.awaitControlBarrier();
    // Settle ingress that raced the observation deadline or final pause. This is
    // a bounded drain; later changes make the report blocked rather than extend
    // observation indefinitely or claim an unobserved boundary was accepted.
    await pump();
    const inspection = await storage.inspect(sessionId);
    const attempt = attemptId ? await storage.getAttempt(attemptId) : null;
    const captures = [];
    for (const [index,segment] of liveSession.segments.entries()) captures.push(await exportLiveCapture(
      join(directory,index===0?'capture':`capture-${index+1}`),sessionId,segment.sync,segment.subsequent,options.sourceVersion));
    const capture = captures[0]!;
    const pageAfter = await bridgeCall(page, 'read');
    const finalCursor = liveSession.cursor;
    const settled = !!finalCursor && !pageAfter.reason && !pageAfter.overflow && !pageAfter.queued && pageAfter.connected !== false &&
      pageAfter.generation === finalCursor.generation && pageAfter.pageEpoch === finalCursor.pageEpoch && pageAfter.lastStep === finalCursor.lastStep;
    const expectedStatus = options.pauseBeforeDispatch ? 'not-dispatched' : 'confirmed';
    const autoWinRecovery=liveSession.autoWinRecovery;
    const autoWinRecoveryReady=actor.projection.matchStatus==='finished' || !autoWinRecovery || ['verified','not-required'].includes(autoWinRecovery.status);
    const boundaryFenceChallenge = boundaryChallenge?.report;
    const boundaryReady = !boundaryFenceChallenge || boundaryFenceChallenge.status==='passed' &&
      pageAfter.paused===true && pageAfter.stats?.bridgeActionSends===0;
    const browserStatsBefore=summarizeBrowserStats(cursor.stats),browserStatsAfter=summarizeBrowserStats(pageAfter.stats);
    const phase2Evidence=selectedPhase2 ? {
      selection:selectedPhase2,offer:cursor.operation??null,
      bridgeActionSends:browserStatsBefore?.bridgeActionSends!=null && browserStatsAfter?.bridgeActionSends!=null ?
        browserStatsAfter.bridgeActionSends-browserStatsBefore.bridgeActionSends : null,
      confirmations:inspection.counts.confirmations,
    } : null;
    const phase2Confirmed=!phase2Evidence || phase2Evidence.bridgeActionSends===1 && phase2Evidence.confirmations===1 &&
      attempt?.receipt?.delivery==='accepted' && !!attempt.confirmationEventId;
    const passed = settled && autoWinRecoveryReady && (!attempt || attempt.status === expectedStatus) && !liveSession.recovering &&
      !liveSession.awaitingSettlement && !actor.projection.matchEndPending && boundaryReady && phase2Confirmed;
    const report = { schemaVersion: 1, evidenceKind: 'current-client-integration', status: passed ? 'passed' : 'blocked',
      scope: observeMs>0 ? 'lifecycle-observation' : selectedPhase2 ? 'one-phase2-action' :
        options.pauseBeforeDispatch ? 'pause-before-final-send' : options.discardOnce ? 'one-ordinary-discard' : 'complete-current-hand-sync',
      sessionId, databasePath,
      attempt, executionDiagnostic:executor?.diagnostic ?? null, counts: inspection.counts, finalStateHash: digest(inspection.projection.state),
      ...(boundaryFenceChallenge ? {boundaryFenceChallenge} : {}),
      ...(phase2Evidence ? {phase2Evidence} : {}),
      ...(initialOffer ? {initialOffer} : {}),
      paused: actor.control.paused && actor.control.controlPending === 0,
      programPaused: actor.control.paused && actor.control.controlPending === 0,
      clientAutoWinLastReadback: autoWinRecovery ? autoWinRecovery.readback?.state ?? 'unknown' : autoWinReadback?.state ?? 'unknown',
      clientAutoWinMayActAfterProgramPause: true,
      countdownSource: timing ? 'server-sync-and-client-pixels' : 'no-executable-window', timing: timing ?? null, timingEvidence, autoWinReadback,
      autoWinRecovery, autoWinRecoveries:liveSession.autoWinRecoveries,
      browserStatsBefore,browserStatsAfter,
      observationClosure: {settled,drained:finalCursor,read:{generation:pageAfter.generation,pageEpoch:pageAfter.pageEpoch,
        lastStep:pageAfter.lastStep,connected:pageAfter.connected ?? null,queued:pageAfter.queued ?? 0,
        reason:pageAfter.reason ?? null,overflow:pageAfter.overflow ?? false}},
      clientWinDiagnostics: { request: pageAfter.lastClientWin ?? null, authority: pageAfter.lastOwnWin ?? null },
      lifecycle: { ...liveSession.counts, handOrdinal:actor.projection.handOrdinal,handStatus:actor.projection.handStatus,
        matchStatus:actor.projection.matchStatus,matchEndPending:actor.projection.matchEndPending ?? false,
        awaitingSettlement:liveSession.awaitingSettlement,recovering:liveSession.recovering },
      automationEnabled: false, captureDirectory: capture.directory, captureDirectories:captures.map(c=>c.directory),
      reportPath: join(directory, 'report.json') };
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } catch (error) {
    if (actor) { actor.pause(); await actor.awaitControlBarrier().catch(() => {}); }
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LIVE_ACCEPTANCE_FAILED';
    const diagnostics=liveSession?.diagnostics;
    const pageAfter=await bridgeCall(page,'read').catch(()=>null);
    const report = { schemaVersion: 1, evidenceKind: 'current-client-integration', status: 'blocked', code,
      sessionId, databasePath, executionDiagnostic:executor?.diagnostic ?? null, timingDiagnostics:diagnostics?.timing ?? null,
      ...(selectedPhase2 ? {phase2Selection:selectedPhase2} : {}),
      ...(boundaryChallenge ? {boundaryFenceChallenge:boundaryChallenge.report} : {}),
      autoWinRecovery:liveSession?.autoWinRecovery ?? null,autoWinRecoveries:liveSession?.autoWinRecoveries ?? [],
      browserStatsBefore:diagnostics?.browserStatsBefore ?? null,browserStatsAfter:summarizeBrowserStats(pageAfter?.stats),
      automationEnabled: false, reportPath: join(directory, 'report.json') };
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    if (actor) { actor.pause(); await actor.awaitControlBarrier().catch(() => {}); await actor.idle(); }
    await storage.close();
  }
}
