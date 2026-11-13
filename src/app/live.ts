import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { StorageClient } from '../adapters/storage/client.ts';
import { GameActor } from '../application/game/actor.ts';
import { ActionExecutor, type ProductionTransport } from '../application/game/executor.ts';
import { bridgeCall, EgoProductionTransport, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import type { ActionAttempt, FriendRoom } from '../domain/game/types.ts';
import { digest, requireThat } from '../domain/game/value.ts';
import { exportLiveCapture } from './live-capture.ts';
import { requireLiveActionScope, selectLiveAction, validateLiveActionSelection, type LiveActionSelection } from './live-action-selection.ts';
import { isBoundaryProofFailure, LiveBoundaryFenceChallenge } from './live-boundary-fence.ts';
import { LiveGameSession, summarizeBrowserStats } from './live-session.ts';
import { AkagiRunner } from '../adapters/engine/akagi.ts';
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
  /** Explicit opt-in for one bounded Akagi match. */
  akagi?: boolean;
  /** Console control may attach after the opening; all action fences still apply. */
  resumeMatch?: boolean;
  /** Assigned by the live console so it can follow this match immediately. */
  sessionId?: string;
}

/** Uses the real worker, Actor, executor and Page bridge. */
export async function acceptLivePage(page: EgoPagePort, options: LiveAcceptanceOptions, signal?: AbortSignal,
  createRunner: () => Pick<AkagiRunner, 'init' | 'decide' | 'close'> = () => new AkagiRunner()) {
  if (options.sessionId !== undefined) requireThat(/^live-[a-zA-Z0-9-]{1,100}$/.test(options.sessionId), 'INVALID_SESSION_ID');
  const observeMs = validateObservationDuration(options.observeMs);
  const selectedPhase2 = options.phase2ActionOnce;
  const akagi = options.akagi === true;
  requireThat(!akagi || observeMs > 0 && !options.discardOnce && !selectedPhase2 &&
    !options.pauseBeforeDispatch && !options.verifyBoundaryFences, 'INVALID_AKAGI_RUN');
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
  const sessionId = options.sessionId ?? `live-${randomUUID()}`, databasePath = resolve(options.databasePath ?? fileURLToPath(new URL('../../data/live/state.sqlite', import.meta.url)));
  await mkdir(resolve(databasePath, '..'), { recursive: true, mode: 0o700 });
  const storage = new StorageClient(databasePath);
  let actor: GameActor | undefined;
  let executor: ActionExecutor | undefined;
  let liveSession: LiveGameSession | undefined;
  let runner: Pick<AkagiRunner, 'init' | 'decide' | 'close'> | undefined;
  let beganAtMatchOpening = false;
  const automated = { attempted: 0, confirmed: 0, confirmedDiscards: 0, acceptedPasses: 0, skippedExpiredWindows: 0 };
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
    if (akagi) {
      runner = createRunner();
      await runner.init();
    }
    const session = liveSession = new LiveGameSession(actor,page,options.room,akagi);
    const synchronizeOpening = async () => {
      const deadline = performance.now() + 30_000;
      const continuous = akagi && options.resumeMatch === true;
      const openingScope = continuous ? await bridgeCall(page, 'read') : null;
      for (let attempt = 0; ; attempt++) {
        requireThat(!signal?.aborted, 'LIVE_CANCELLED');
        requireThat(performance.now() < deadline, 'SYNC_START_TIMEOUT');
        try {
          const result = await session.synchronize(!!boundaryChallenge || observeMs===0 || options.discardOnce===true);
          requireThat(!signal?.aborted, 'LIVE_CANCELLED');
          requireThat(performance.now() < deadline, 'SYNC_START_TIMEOUT');
          if (openingScope) requireThat(result.cursor.pageEpoch === openingScope.pageEpoch &&
            result.sync.gameMatchKey === `game-${digest(openingScope.gameUuid).slice(0,32)}`, 'SYNC_IDENTITY_CHANGED');
          return result;
        }
        catch (error) {
          // Live events can advance while a startup snapshot is in flight.
          // Recollect before any decision exists; never reuse the stale proof.
          requireThat(!signal?.aborted, 'LIVE_CANCELLED');
          const restoreGap = continuous && error instanceof Error &&
            ['SYNC_HAND_START_REQUIRED', 'SYNC_RESPONSE_INCOMPLETE', 'SYNC_HISTORY_INCOMPLETE'].includes(error.message);
          const racing = error instanceof Error && ['SYNC_STALE','SYNC_INGRESS_RACE','SYNC_CAPTURE_RACE'].includes(error.message);
          if (!restoreGap && !racing || (restoreGap || !continuous) && attempt >= 4 || performance.now() >= deadline) throw error;
          if (!openingScope) continue;
          const current = await bridgeCall(page, 'read');
          requireThat(current.pageEpoch === openingScope.pageEpoch && current.gameUuid === openingScope.gameUuid, 'SYNC_IDENTITY_CHANGED');
          requireThat(!signal?.aborted, 'LIVE_CANCELLED');
          // Fast robot turns can exhaust five immediate RPC retries in two
          // seconds. Yield between complete collections, within one deadline.
          // Await any in-flight sync above; racing it against abort could leave
          // a late SQLite commit running after the actor has been closed.
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw error;
          try { await delay(Math.min(restoreGap ? 500 : 200, remaining), undefined, { signal }); }
          catch { requireThat(!signal?.aborted, 'LIVE_CANCELLED'); throw error; }
          if (performance.now() >= deadline) throw error;
        }
      }
    };
    const {sync,cursor,timing,timingEvidence,autoWinReadback} = await synchronizeOpening().catch(error => {
      if (!boundaryChallenge || !isBoundaryProofFailure(error)) throw error;
      boundaryChallenge.failArming(error);
      return session.synchronize(false);
    });
    // Initial restore also archives discards made before this worker took over.
    // Only later discards need confirmation by this worker or forced riichi play.
    const initialOwnDiscards = (await storage.inspect(sessionId)).counts.outbox;
    const initialForcedRiichiDiscards = new Set(session.forcedRiichiDiscards);
    if (boundaryChallenge) await boundaryChallenge.arm(actor, page, cursor);
    if (akagi) {
      const first = sync.handHistory[0];
      if (first?.type === 'HandStarted') {
        const view = first.payload.initialView;
        beganAtMatchOpening = sync.handOrdinal === 1 && view.roundWind === '1z' && view.handNumber === 1 &&
          view.honba === 0 && view.riichiSticks === 0 && Object.values(view.players).every(player => player.score === 25000) &&
          !sync.observedActions.some(event => event.type === 'TileDiscarded' && event.payload.actor === view.ownSeat);
      }
    }
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
    let previousWindow: { sourceCursor: string; gameHandKey: string; until: number } | undefined;
    let timingRetry: { sourceCursor: string | null; gameHandKey: string | null; attempts: number; until: number } | undefined;
    let awaitingAutoWin: { cursor: string; until: number } | undefined;
    const skipExpiredWindow = async (sourceCursor: string, gameHandKey: string) => {
      await session.skipExpiredWindow(sourceCursor, gameHandKey);
      automated.skippedExpiredWindows++;
      // Keep ingesting while this exact offer closes; never resample or retry it.
      previousWindow = { sourceCursor, gameHandKey, until: performance.now() + 10_000 };
    };
    while (!signal?.aborted && observeMs>0 && performance.now()<observeUntil && actor.projection.matchStatus!=='finished') {
      await pump();
      if (runner) {
        const projection = actor.projection;
        if (previousWindow && projection.gameHandKey === previousWindow.gameHandKey &&
            projection.sourceCursor === previousWindow.sourceCursor && projection.handStatus === 'playing') {
          requireThat(performance.now() < previousWindow.until, 'AKAGI_WINDOW_DID_NOT_ADVANCE');
        } else {
          previousWindow = undefined;
          const window = projection.state?.operationWindow;
          if (window?.status === 'open' && projection.handStatus === 'playing' && !session.recovering &&
              !session.awaitingSettlement && !projection.matchEndPending) {
            if (window.candidates.some(candidate => candidate.authority === 'client-auto-win')) {
              const key = projection.sourceCursor!;
              if (awaitingAutoWin?.cursor !== key) awaitingAutoWin = { cursor: key, until: performance.now() + 10_000 };
              requireThat(performance.now() < awaitingAutoWin.until, 'CLIENT_AUTO_WIN_DID_NOT_ADVANCE');
            } else {
              awaitingAutoWin = undefined;
              const fresh = await session.synchronize(true, true).catch(async error => {
                if (error instanceof Error && error.message === 'AUTO_WIN_WINDOW_EXPIRED' && !actor!.control.needsSync) {
                  await skipExpiredWindow(projection.sourceCursor!, projection.gameHandKey!);
                  await pump();
                  return null;
                }
                const stale = error instanceof Error && ['COUNTDOWN_SAMPLE_STALE', 'COUNTDOWN_READBACK_STALE',
                  'AKAGI_WINDOW_CHANGED', 'AUTO_WIN_SAMPLE_STALE', 'SYNC_INGRESS_RACE', 'SYNC_STALE', 'COUNTDOWN_DIGITS_UNREADABLE',
                  'COUNTDOWN_LAYOUT_UNVERIFIED', 'COUNTDOWN_GLYPH_UNVERIFIED', 'COUNTDOWN_BANK_UNREADABLE'].includes(error.message);
                if (!stale || actor!.control.needsSync) throw error;
                await pump();
                const current = actor!.projection;
                if (session.recovering || current.gameHandKey !== projection.gameHandKey ||
                  current.sourceCursor !== projection.sourceCursor || current.matchStatus === 'finished') timingRetry = undefined;
                else {
                  // An animation or local input can invalidate a screenshot
                  // before the server advances. Recollect within this exact
                  // window while paused; never reuse the rejected evidence.
                  if (!timingRetry || timingRetry.sourceCursor !== projection.sourceCursor || timingRetry.gameHandKey !== projection.gameHandKey)
                    timingRetry = { sourceCursor: projection.sourceCursor, gameHandKey: projection.gameHandKey,
                      attempts: 0, until: performance.now() + 10_000 };
                  requireThat(++timingRetry.attempts <= 3 && performance.now() < timingRetry.until, error.message);
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
                return null;
              });
              if (!fresh) continue;
              timingRetry = undefined;
              requireThat(fresh.sync.sourceCursor === projection.sourceCursor &&
                fresh.sync.gameHandKey === projection.gameHandKey, 'AKAGI_WINDOW_CHANGED');
              if (fresh.expiredWindow) {
                await skipExpiredWindow(projection.sourceCursor!, fresh.sync.gameHandKey);
                continue;
              }
              requireThat(fresh.timing, 'TIMING_EVIDENCE_REQUIRED');
              transport!.bind({ generation: fresh.cursor.generation, pageEpoch: fresh.cursor.pageEpoch, step: fresh.cursor.lastStep }, fresh.timing);
              if (signal?.aborted) break;
              let executing = false, attempt: ActionAttempt | undefined;
              try {
                await session.coordinator.resume();
                const snapshot = await actor.freezeDecision();
                const selected = await runner.decide(snapshot, fresh.sync.handHistory);
                if (performance.now() >= observeUntil) break;
                if (signal?.aborted) break;
                automated.attempted++;
                executing = true;
                attempt = await executor!.executeLive(snapshot.id, selected.id);
                // Once sent, drain its normal confirmation window even when
                // the observation slice expires; never abandon a submission
                // merely to rotate workers at the time boundary.
                const until = performance.now() + 10_000;
                let status = attempt.status;
                while (['dispatching', 'awaiting-confirmation'].includes(status) && performance.now() < until) {
                  await pump();
                  status = (await storage.getAttempt(attempt.id))!.status;
                  if (status === 'awaiting-confirmation') await new Promise(resolve => setTimeout(resolve, 100));
                }
                requireThat(status === 'confirmed', executor!.diagnostic?.code ?? 'AKAGI_ACTION_UNCONFIRMED');
                if (selected.action.kind === 'pass') automated.acceptedPasses++;
                else {
                  automated.confirmed++;
                  if (selected.action.kind === 'discard' || selected.action.kind === 'riichi-discard') automated.confirmedDiscards++;
                }
                previousWindow = { sourceCursor: snapshot.sourceCursor, gameHandKey: fresh.sync.gameHandKey, until };
              } catch (error) {
                const diagnostic = executor!.diagnostic;
                const expired = error instanceof Error && ['DEADLINE_EXCEEDED', 'PERMIT_EXPIRED'].includes(error.message);
                const notSent = !executing || diagnostic && !diagnostic.invocationStarted &&
                  ['DEADLINE_EXCEEDED', 'PERMIT_EXPIRED'].includes(diagnostic.code) &&
                  (!attempt || attempt.status === 'not-dispatched' && attempt.receipt?.delivery === 'not-sent');
                // Expiration before persistence, after strategy, or during
                // prepare is recoverable only when dispatch never started.
                if (!expired || !notSent || actor.control.needsSync) throw error;
                await skipExpiredWindow(projection.sourceCursor!, fresh.sync.gameHandKey);
              }
            }
          }
        }
      }
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
    const forcedRiichiDiscards = [...session.forcedRiichiDiscards].filter(cursor => !initialForcedRiichiDiscards.has(cursor));
    const expiredWindowDiscards = [...session.expiredWindowDiscards];
    const unmatchedOwnDiscards = inspection.counts.outbox - initialOwnDiscards - automated.confirmedDiscards - forcedRiichiDiscards.length -
      (options.resumeMatch === true ? expiredWindowDiscards.length : 0);
    const matchLedger = akagi && actor.projection.gameMatchKey ? await storage.inspectMatch(actor.projection.gameMatchKey) : null;
    const observationLimitReached = akagi && !signal?.aborted && performance.now() >= observeUntil &&
      actor.projection.matchStatus === 'playing';
    const recovery = { canResume: options.resumeMatch === true && settled &&
      actor.control.paused && actor.control.controlPending === 0 && pageAfter.paused === true &&
      unmatchedOwnDiscards === 0 && matchLedger?.unresolvedAttempts.length === 0 &&
      !liveSession.recovering && !liveSession.awaitingSettlement && !actor.projection.matchEndPending,
      gameMatchKey: actor.projection.gameMatchKey, unresolvedAttempts: matchLedger?.unresolvedAttempts.length ?? null };
    // Execution coverage is an acceptance verdict, separate from whether the
    // server has conclusively finished this game. Native/manual discards stay
    // unexplained in that verdict, but cannot keep a settled game on screen.
    const matchCompletion = { canStartNextMatch: akagi && options.resumeMatch === true && settled &&
      actor.control.paused && actor.control.controlPending === 0 && pageAfter.paused === true &&
      actor.projection.matchStatus === 'finished' && matchLedger?.matchStatus === 'finished' &&
      !!actor.projection.matchResult && digest(actor.projection.matchResult) === digest(matchLedger.matchResult) &&
      matchLedger.unresolvedAttempts.length === 0 && !liveSession.recovering &&
      !liveSession.awaitingSettlement && !actor.projection.matchEndPending,
      gameMatchKey: actor.projection.gameMatchKey, unresolvedAttempts: matchLedger?.unresolvedAttempts.length ?? null,
      executionCoverageComplete: unmatchedOwnDiscards === 0, unmatchedOwnDiscards };
    const passed = settled && (!akagi || (beganAtMatchOpening || options.resumeMatch === true) && actor.projection.matchStatus === 'finished' &&
      (automated.confirmedDiscards > 0 || options.resumeMatch === true) && unmatchedOwnDiscards === 0 && matchLedger?.unresolvedAttempts.length === 0) &&
      (akagi || autoWinRecoveryReady) && (!attempt || attempt.status === expectedStatus) && !liveSession.recovering &&
      !liveSession.awaitingSettlement && !actor.projection.matchEndPending && boundaryReady && phase2Confirmed;
    const completedReport = { schemaVersion: 1, evidenceKind: 'current-client-integration', status: passed ? 'passed' : 'blocked',
      scope: akagi ? options.resumeMatch ? 'akagi-current-match' : 'akagi-one-match' : observeMs>0 ? 'lifecycle-observation' : selectedPhase2 ? 'one-phase2-action' :
        options.pauseBeforeDispatch ? 'pause-before-final-send' : options.discardOnce ? 'one-ordinary-discard' : 'complete-current-hand-sync',
      sessionId, databasePath,
      attempt, executionDiagnostic:executor?.diagnostic ?? null, counts: inspection.counts, finalStateHash: digest(inspection.projection.state),
      ...(boundaryFenceChallenge ? {boundaryFenceChallenge} : {}),
      ...(phase2Evidence ? {phase2Evidence} : {}),
      ...(initialOffer ? {initialOffer} : {}),
      paused: actor.control.paused && actor.control.controlPending === 0,
      programPaused: actor.control.paused && actor.control.controlPending === 0,
      recovery,
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
      ...(akagi ? { automated, beganAtMatchOpening, initialOwnDiscards, forcedRiichiDiscards, expiredWindowDiscards, unmatchedOwnDiscards, matchCompletion, gameMatchKey: inspection.projection.gameMatchKey, roomId: options.room.roomId,
        matchResult: inspection.projection.matchResult ?? null } : {}),
      automationEnabled: akagi, captureDirectory: capture.directory, captureDirectories:captures.map(c=>c.directory),
      reportPath: join(directory, 'report.json') };
    const report = observationLimitReached ? { ...completedReport, code: 'MATCH_OBSERVATION_LIMIT', recovery,
      timingDiagnostics: null, settlementDiagnostics: null } : completedReport;
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } catch (error) {
    let programPaused = false;
    if (actor) { actor.pause(); programPaused = await actor.awaitControlBarrier().then(() => true, () => false); }
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'LIVE_ACCEPTANCE_FAILED';
    const diagnostics=liveSession?.diagnostics;
    const pageAfter=await bridgeCall(page,'read').catch(()=>null);
    const gameMatchKey = actor?.projection.gameMatchKey ?? (typeof pageAfter?.gameUuid === 'string' && pageAfter.gameUuid
      ? `game-${digest(pageAfter.gameUuid).slice(0,32)}` : null);
    const ledger = gameMatchKey ? await storage.inspectMatch(gameMatchKey).catch(() => null) : null;
    const recovery = { canResume: programPaused && pageAfter?.paused === true && ledger?.unresolvedAttempts.length === 0,
      gameMatchKey,
      unresolvedAttempts: ledger?.unresolvedAttempts.length ?? null };
    const report = { schemaVersion: 1, evidenceKind: 'current-client-integration', status: 'blocked', code,
      sessionId, databasePath, executionDiagnostic:executor?.diagnostic ?? null, timingDiagnostics:diagnostics?.timing ?? null, settlementDiagnostics:diagnostics?.settlement ?? null,
      programPaused, recovery,
      ...(selectedPhase2 ? {phase2Selection:selectedPhase2} : {}),
      ...(boundaryChallenge ? {boundaryFenceChallenge:boundaryChallenge.report} : {}),
      autoWinRecovery:liveSession?.autoWinRecovery ?? null,autoWinRecoveries:liveSession?.autoWinRecoveries ?? [],
      browserStatsBefore:diagnostics?.browserStatsBefore ?? null,browserStatsAfter:summarizeBrowserStats(pageAfter?.stats),
      ...(akagi ? { automated, beganAtMatchOpening, gameMatchKey: actor?.projection.gameMatchKey ?? null, roomId: options.room.roomId } : {}),
      automationEnabled: akagi, reportPath: join(directory, 'report.json') };
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    runner?.close();
    if (actor) {
      actor.pause();
      const barrier = await actor.awaitControlBarrier().then(() => true, () => false);
      await actor.idle();
      if (akagi && barrier) await bridgeCall(page, 'releaseAkagi', actor.control).catch(() => {});
    }
    await storage.close();
  }
}
