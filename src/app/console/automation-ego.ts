import { waitForLiveOpening } from './opening.ts';
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

/** Browser orchestration stays in ego; each match uses the pinned Node worker and the same ledger. */
export async function runAutomation(page: EgoPagePort, runtime: string, options: LiveAcceptanceOptions, directory: string,
  limits: { maxMatches: number; maxDurationMs: number },
  driver: {accept:typeof acceptLiveViaNode;install:typeof installLiveBridge;call:typeof bridgeCall;confirmResult?:typeof confirmMatchResult;startRoom?:typeof startFriendRoom} = { accept: acceptLiveViaNode, install: installLiveBridge, call: bridgeCall, confirmResult:confirmMatchResult, startRoom:startFriendRoom }) {
  const cancellation = new AbortController(), started = Date.now();
  let view: AutomationView = { available: true, enabled: true, status: 'starting', completedMatches: 0, sessionId: null };
  const publish = async (patch: Partial<AutomationView>) => {
    view = { ...view, ...patch };
    const file = join(directory, 'status.json');
    await writeFile(file + '.tmp', JSON.stringify(view));
    await rename(file + '.tmp', file);
  };
  const poll = setInterval(() => {
    void readFile(join(directory, 'control.json'), 'utf8').then(text => {
      if (!JSON.parse(text).enabled) cancellation.abort();
    }).catch(() => cancellation.abort());
  }, 100);
  const signal = cancellation.signal;
  try {
    await publish({});
    const setViewport = async () => {
      if (page.cdp) await page.cdp('Emulation.setDeviceMetricsOverride', {width:2036,height:918,deviceScaleFactor:1,mobile:false});
    };
    await setViewport();
    let read = await driver.call(page, 'read').catch(() => null);
    if (!read?.akagiEnabled || (!read.matchEnded && ((read.reason && !['MATCH_CHANGED','CONNECTION_CHANGED'].includes(read.reason)) || (read.gameUuid && read.authSummary && !nativeRestoreProof(read))))) {
      await driver.install(page, true, { akagiEnabled: true });
      await setViewport();
    }
    let confirmedResult: string | null = null;
    while (!signal.aborted && view.completedMatches < limits.maxMatches && Date.now() - started < limits.maxDurationMs) {
      await publish({ status: 'waiting' });
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
            const start = await driver.call(page, 'startNextMatch', { roomId: options.room.roomId });
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
      if (read.gameUuid && !await waitForLiveOpening(page,read.gameUuid,signal,driver.call)) break;
      const sessionId = `live-${randomUUID()}`;
      await publish({ status: 'playing', sessionId });
      const { phase2ActionOnce: _selection, ...matchOptions } = options;
      const report = await driver.accept(page, { ...matchOptions, sessionId, akagi: true, resumeMatch: true,
        discardOnce: false, verifyBoundaryFences: false, pauseBeforeDispatch: false,
        observeMs: options.observeMs ?? 1_800_000,
        outputDirectory: join(options.outputDirectory, sessionId) }, runtime, signal);
      if (signal.aborted) break;
      if (report.status !== 'passed' || report.lifecycle?.matchStatus !== 'finished') throw Error(report.code ?? 'MATCH_NOT_COMPLETED');
      await publish({ completedMatches: view.completedMatches + 1 });
      if (view.completedMatches >= limits.maxMatches || Date.now() - started >= limits.maxDurationMs) break;
      await publish({ status: 'waiting' });
      // Keep the lobby connection and room membership through the next start.
      // The bridge only re-arms start after this match settled and its executor released.
    }
    await publish({ enabled: false, status: 'stopped' });
  } catch (error) {
    await publish({ enabled: false, status: signal.aborted ? 'stopped' : 'faulted',
      errorCode: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'AUTOMATION_FAILED' });
  } finally {
    clearInterval(poll);
    const current = await driver.call(page, 'read').catch(() => null);
    if (!current?.paused) await driver.call(page, 'pause').catch(() => {});
  }
}
