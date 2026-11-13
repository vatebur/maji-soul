import { monitorMatch, MatchMonitorInterrupted, recoveryDelayMs, automationErrorCode, requiresOperator, requiresBrowserRestart } from './automation-monitor.ts';
import { automationIncident, writeAutomationIncident, type AutomationIncident } from './automation-incidents.ts';
import { recoverAudienceRoom } from './room-recovery.ts';
import { prepareAudienceRoom } from './room-lifecycle.ts';
import { startAudienceRoom } from '../../adapters/majsoul/lobby-screen.ts';
import { waitForLiveOpening, openingTableVisible } from './opening.ts';
import { confirmMatchResult, startFriendRoom } from '../../adapters/majsoul/result-screen.ts';
import { nativeRestoreProof } from '../../adapters/majsoul/auto-win.ts';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptLiveViaNode } from '../live-broker.ts';
import { installLiveBridge } from '../../adapters/majsoul/install.ts';
import { bridgeCall, type EgoPagePort } from '../../adapters/majsoul/ego-transport.ts';
import type { LiveAcceptanceOptions } from '../live.ts';
import type { AutomationView } from './automation.ts';
import { digest } from '../../domain/game/value.ts';
import { dismissInactivityNotice, inspectInactivityNotice, hasInactivityNoticeScope } from '../../adapters/majsoul/inactivity-notice.ts';

const recoverableMatchErrors = new Set(['DEADLINE_EXCEEDED', 'PERMIT_EXPIRED', 'COUNTDOWN_EXPIRED',
  'SYNC_HAND_START_REQUIRED', 'SYNC_RESPONSE_INCOMPLETE', 'SYNC_HISTORY_INCOMPLETE', 'SYNC_STALE', 'SYNC_INGRESS_RACE', 'SYNC_CAPTURE_RACE',
  'COUNTDOWN_SAMPLE_STALE', 'COUNTDOWN_READBACK_STALE', 'COUNTDOWN_DIGITS_UNREADABLE', 'COUNTDOWN_LAYOUT_UNVERIFIED',
  'COUNTDOWN_GLYPH_UNVERIFIED', 'COUNTDOWN_BANK_UNREADABLE', 'AUTO_WIN_READBACK_STALE', 'AKAGI_WINDOW_CHANGED']);

export interface AutomationDriver {
  accept: typeof acceptLiveViaNode; install: typeof installLiveBridge; call: typeof bridgeCall;
  confirmResult?: typeof confirmMatchResult; startRoom?: typeof startFriendRoom; prepareRoom?: typeof prepareAudienceRoom;
  recoverRoom?: typeof recoverAudienceRoom;
  opening?: typeof waitForLiveOpening;
  inspectInactivity?: typeof inspectInactivityNotice; dismissInactivity?: typeof dismissInactivityNotice;
  monitor?: typeof monitorMatch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  incident?: (event: AutomationIncident) => void;
}

/** Transport-neutral orchestration. Browser adapters share the same monitored loop,
 * pinned Node match worker and durable action ledger. */
export async function runAutomation(page: EgoPagePort, runtime: string, options: LiveAcceptanceOptions, directory: string,
  driver: AutomationDriver = { accept: acceptLiveViaNode, install: installLiveBridge, call: bridgeCall, confirmResult:confirmMatchResult, startRoom:startAudienceRoom, prepareRoom:prepareAudienceRoom, recoverRoom:recoverAudienceRoom, incident:writeAutomationIncident,
    inspectInactivity:inspectInactivityNotice, dismissInactivity:dismissInactivityNotice }) {
  const cancellation = new AbortController();
  let view: AutomationView = { available: true, enabled: true, status: 'starting', completedMatches: 0, sessionId: null, recoveryCount: 0 };
  const previous = await readFile(join(directory, 'recovery.json'), 'utf8').then(text => JSON.parse(text) as AutomationView).catch(() => null);
  if (previous) view = { ...view, completedMatches: previous.completedMatches, recoveryCount: previous.recoveryCount ?? 0,
    lastErrorCode: previous.lastErrorCode ?? null, lastErrorAt: previous.lastErrorAt ?? null };
  let writes = Promise.resolve();
  const publish = async (patch: Partial<AutomationView>) => {
    view = { ...view, ...patch, heartbeatAt: new Date().toISOString() };
    if (patch.lastErrorAt && patch.lastErrorCode && (patch.status === 'recovering' || patch.status === 'faulted')) {
      try { driver.incident?.(automationIncident(patch.lastErrorCode, view.recoveryCount ?? 0, patch.status, patch.lastErrorAt)); }
      catch { /* An unavailable logging sink must not prevent recovery. */ }
    }
    const body = JSON.stringify(view), file = join(directory, 'status.json');
    writes = writes.then(async () => { await writeFile(file + '.tmp', body); await rename(file + '.tmp', file); });
    await writes;
  };
  const poll = setInterval(() => {
    void readFile(join(directory, 'control.json'), 'utf8').then(text => {
      if (!JSON.parse(text).enabled) cancellation.abort();
    }).catch(() => cancellation.abort());
  }, 100);
  const heartbeat = setInterval(() => { void publish({}).catch(() => cancellation.abort()); }, 2_000);
  const signal = cancellation.signal;
  const sleep = driver.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const requested = async () => {
    if (!JSON.parse(await readFile(join(directory, 'control.json'), 'utf8')).enabled) cancellation.abort();
    return !signal.aborted;
  };
  try {
    await publish({});
    const setViewport = async () => {
      if (page.cdp) await page.cdp('Emulation.setDeviceMetricsOverride', {width:2036,height:918,deviceScaleFactor:1,mobile:false});
    };
    let initialized = false;
    let confirmedResult: string | null = null;
    let activeRoom = options.room;
    let matchRecoveries = 0, failures = 0, needsRecovery = !!previous && !!driver.recoverRoom;
    while (await requested()) {
      try {
        if (needsRecovery) {
          await driver.recoverRoom!(page, activeRoom, signal);
          delete view.errorCode;
          needsRecovery = false; initialized = false; confirmedResult = null;
        }
        await setViewport();
        let read = await driver.call(page, 'read').catch(() => null);
        const terminalDisconnect = read?.reason === 'DISCONNECTED' && read.matchEnded && read.paused &&
          read.controlEpoch === 0 && read.matchResult?.result?.players?.length === 4;
        // An interrupted worker can leave its process fence bound. Reload rather
        // than allowing a new actor to impersonate or release that old owner.
        if (!initialized && (!read?.akagiEnabled || read.controlEpoch > 0 || read.overflow ||
            read.reason && !['MATCH_CHANGED','CONNECTION_CHANGED'].includes(read.reason) && !terminalDisconnect ||
            driver.prepareRoom && read.audienceRoomsVersion !== 6 ||
            !read.matchEnded && read.gameUuid && read.authSummary && !nativeRestoreProof(read))) {
          await driver.install(page, true, { akagiEnabled: true });
          await setViewport();
        }
        initialized = true;
        await publish({ status: 'waiting', recruitUntil:null });
        if(driver.prepareRoom){
          const current=await driver.call(page,'read').catch(()=>null);
          if(current?.matchEnded && confirmedResult!==current.gameUuid){
            await driver.confirmResult?.(page,current.gameUuid);confirmedResult=current.gameUuid;
          }
          const prepared=await driver.prepareRoom(page,activeRoom,signal,publish);
          if(signal.aborted)break;
          if(prepared)activeRoom=prepared;
        }
        let deadline = Date.now() + 60_000;
        let readinessError: string | undefined;
        // A reloaded client reconnects to its existing game or returns to its room.
        while (!signal.aborted) {
          read = await driver.call(page, 'read');
          if (read.authSummary && !read.matchEnded && (!read.reason || ['MATCH_CHANGED','CONNECTION_CHANGED'].includes(read.reason))) break;
          if (Date.now() > deadline) throw Error(readinessError ?? 'GAME_START_TIMEOUT');
          if (read.matchEnded && confirmedResult !== read.gameUuid) {
            await driver.confirmResult?.(page, read.gameUuid);
            confirmedResult = read.gameUuid;
          }
          if (!read.authSummary || read.matchEnded) {
            try {
              if (signal.aborted) break;
              // Resizing invalidates the bridge generation. Do it before asking
              // for the room proof that the native start click must preserve.
              if (page.cdp) await page.cdp('Emulation.clearDeviceMetricsOverride', {});
              const start = await driver.call(page, 'startNextMatch', { roomId: activeRoom.roomId, allowViewers:!!driver.prepareRoom });
              if (start.ready && !await driver.startRoom?.(page,start.expected)) continue;
              // Do not repeat a start, including an uncertain response.
              deadline = Date.now() + 60_000;
              while (!signal.aborted) {
                read = await driver.call(page, 'read');
                if (read.authSummary && !read.matchEnded && (!read.reason || ['MATCH_CHANGED','CONNECTION_CHANGED'].includes(read.reason))) break;
                if (Date.now() > deadline) throw Error('GAME_START_TIMEOUT');
                await delay(200);
              }
              break;
            } catch (error) {
              if (!(error instanceof Error && ['LOBBY_NOT_READY','ROOM_NOT_READY','ROOM_FETCH_FAILED'].includes(error.message))) throw error;
              readinessError = error.message;
            }
          }
          await delay(200);
        }
        if (signal.aborted) break;
        // Lobby recognition uses the native viewport and clears the override.
        // Restore the calibrated table size before any visual execution checks.
        await setViewport();
        await publish({lastProgressAt:new Date().toISOString()});
        if (driver.dismissInactivity && hasInactivityNoticeScope(await driver.call(page, 'read')))
          await driver.dismissInactivity(page, signal);
        const opening = (gameUuid:string) => (driver.opening??waitForLiveOpening)(page,gameUuid,signal,driver.call,
          60_000,openingTableVisible,driver.dismissInactivity);
        if (read.gameUuid && !await opening(read.gameUuid)) break;
        const { phase2ActionOnce: _selection, ...matchOptions } = options;
        const canResume = (report: any, current: any) => report.recovery?.canResume === true &&
          report.recovery.unresolvedAttempts === 0 && current?.connected === true &&
          current.paused === true && current.controlEpoch === 0 && current.gameUuid &&
          `game-${digest(current.gameUuid).slice(0,32)}` === report.recovery.gameMatchKey &&
          !current.reason && !current.overflow;
        let report;
        const recoverNotice = async (drained:any) => {
          if (!await requested()) return false;
          const current=await driver.call(page,'read');
          if (drained?.programPaused !== true || drained.recovery?.unresolvedAttempts !== 0 ||
              !hasInactivityNoticeScope(current) ||
              drained.recovery.gameMatchKey !== `game-${digest(current.gameUuid).slice(0,32)}`)
            throw Error('INACTIVITY_NOTICE_SCOPE_CHANGED');
          await publish({status:'recovering',recruitUntil:null});
          await driver.dismissInactivity!(page,signal);
          if (!await requested()) return false;
          const after=await driver.call(page,'read');
          if (!hasInactivityNoticeScope(after) || after.gameUuid!==current.gameUuid || after.pageEpoch!==current.pageEpoch)
            throw Error('INACTIVITY_NOTICE_SCOPE_CHANGED');
          if (!await opening(current.gameUuid)) return false;
          await publish({lastProgressAt:new Date().toISOString()});
          return true;
        };
        for (;;) {
          const sessionId = `live-${randomUUID()}`;
          await publish({ status: 'playing', sessionId });
          try {
            report = await (driver.monitor ?? monitorMatch)(matchSignal => driver.accept(page, { ...matchOptions, room:activeRoom, sessionId, akagi: true, resumeMatch: true,
              discardOnce: false, verifyBoundaryFences: false, pauseBeforeDispatch: false,
              observeMs: options.observeMs ?? 1_800_000,
              outputDirectory: join(options.outputDirectory, sessionId) }, runtime, matchSignal), async () => {
                const current = await driver.call(page, 'read');
                if (driver.inspectInactivity && current.connected && !current.matchEnded && current.gameUuid &&
                    (await driver.inspectInactivity(page)).visible) throw Error('INACTIVITY_NOTICE_DETECTED');
                return current;
              }, signal, () => publish({ lastProgressAt: new Date().toISOString() }));
          } catch (error) {
            if (!(error instanceof MatchMonitorInterrupted && error.message === 'INACTIVITY_NOTICE_DETECTED' && driver.dismissInactivity)) throw error;
            // Native AFK discards remain uncovered in the old report. They are
            // never reclassified as program confirmations. A new actor may do
            // a full same-game sync only after every old submission is settled.
            if (!await recoverNotice(error.report)) break;
            continue;
          }
          // A modal can invalidate the worker's visual check before the next
          // monitor tick. Its drained report is still the ownership boundary;
          // inspect here before treating that exit as a room recovery.
          if (!signal.aborted && report.status==='blocked' && driver.inspectInactivity && driver.dismissInactivity &&
              (await driver.inspectInactivity(page)).visible) {
            if (!await recoverNotice(report)) break;
            continue;
          }
          if (signal.aborted || report.status !== 'blocked' || report.code !== 'MATCH_OBSERVATION_LIMIT') break;
          const current = await driver.call(page, 'read').catch(() => null);
          if (!canResume(report, current)) break;
          // A half-match can exceed the bounded worker observation. Continue the
          // same game after its worker drained and released; do not recruit,
          // start a new game, count a completion, or spend an error recovery.
        }
        if (signal.aborted) break;
        const completed = report.lifecycle?.matchStatus === 'finished' &&
          (report.status === 'passed' || report.matchCompletion?.canStartNextMatch === true &&
            report.matchCompletion.unresolvedAttempts === 0 && typeof report.gameMatchKey === 'string' &&
            /^game-[0-9a-f]{32}$/.test(report.gameMatchKey) && report.matchCompletion.gameMatchKey === report.gameMatchKey);
        if (!completed) {
          const current=await driver.call(page,'read').catch(()=>null);
          if (!driver.recoverRoom && recoverableMatchErrors.has(report.code) && canResume(report,current) && matchRecoveries++ < 3) {
            // The old worker has drained, released its fence, and checked the
            // shared ledger. A new session must restore the current hand before
            // deciding; never replay the old decision or re-start this game.
            await publish({ status: 'recovering', recruitUntil: null });
            await delay(250);
            continue;
          }
          throw Error(report.code ?? 'MATCH_NOT_COMPLETED');
        }
        failures=0;
        matchRecoveries=0;
        await publish({ completedMatches: view.completedMatches + 1 });
        if (!await requested()) break;
        await publish({ status: 'waiting' });
        // Keep the lobby connection and room membership through the next start.
        // The bridge only re-arms start after this match settled and its executor released.
      } catch (error) {
        if (signal.aborted || !await requested()) break;
        const code = automationErrorCode(error);
        if (!driver.recoverRoom || requiresOperator(code) || requiresBrowserRestart(code)) throw Error(code);
        failures++; needsRecovery = true; matchRecoveries = 0;
        const waitMs = recoveryDelayMs(failures);
        await publish({ status: 'recovering', sessionId: null, roomId: null, recruitUntil: null,
          recoveryCount: (view.recoveryCount ?? 0) + 1, errorCode: code, lastErrorCode: code,
          lastErrorAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + waitMs).toISOString() });
        await sleep(waitMs, signal);
        await publish({ nextRetryAt: null });
      }
    }
    await publish({ enabled: false, status: 'stopped', recruitUntil:null });
  } catch (error) {
    const code = automationErrorCode(error);
    await publish({ enabled: false, status: signal.aborted ? 'stopped' : 'faulted', recruitUntil:null,
      errorCode: code, ...(signal.aborted ? {} : { lastErrorCode: code, lastErrorAt: new Date().toISOString(),
        recoveryCount: (view.recoveryCount ?? 0) + 1 }) });
  } finally {
    clearInterval(poll); clearInterval(heartbeat);
    await writes.catch(() => {});
    const current = await driver.call(page, 'read').catch(() => null);
    if (!current?.paused) await driver.call(page, 'pause').catch(() => {});
  }
}
