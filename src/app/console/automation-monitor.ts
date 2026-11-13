import { setTimeout as delay } from 'node:timers/promises';

export const recoveryDelayMs = (attempt: number) => Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
export function automationErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/control of this task space is with the user|browser commands are paused/i.test(message)) return 'BROWSER_CONTROL_WITH_USER';
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'AUTOMATION_FAILED';
}
export const requiresOperator = (code: string) => new Set([
  'BROWSER_CONTROL_WITH_USER', 'LOGIN_REQUIRED', 'CLIENT_VERSION_MISMATCH', 'PROTOCOL_HASH_MISMATCH',
  'ROOM_OWNER_REQUIRED', 'DEFAULT_ROOM_RULES_MISMATCH', 'ROOM_RECOVERY_EXECUTOR_ACTIVE',
  'ROOM_TERMINATE_REJECTED', 'ROOM_LEAVE_REJECTED', 'GAME_PAGE_AMBIGUOUS', 'INVALID_CLI_ARGUMENTS',
]).has(code);
export const requiresBrowserRestart = (code: string) => ['BROWSER_DISCONNECTED', 'BROWSER_COMMAND_TIMEOUT', 'BROWSER_CONNECTION_CLOSED'].includes(code);

/** A monitor interruption is reported only after work has exited. Its drained
 * report can prove that a narrowly scoped UI recovery has no uncertain sends. */
export class MatchMonitorInterrupted extends Error {
  readonly report: unknown;
  constructor(code: string, report: unknown) { super(code); this.report = report; }
}

/** Watches authoritative game progress, not cosmetic frames or repeated polling.
 * Cancellation is cooperative: work MUST finish draining before this returns. */
export async function monitorMatch<T>(work: (signal: AbortSignal) => Promise<T>, read: () => Promise<any>,
  signal: AbortSignal, progress: () => Promise<void>, options = { pollMs: 5_000, stalledMs: 120_000, readTimeoutMs: 15_000 }) {
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let error: Error | undefined, last = '', changedAt = performance.now(), done = false;
  const monitor = (async () => {
    while (!done && !combined.aborted) {
      try {
        await delay(options.pollMs, undefined, { signal: combined });
        if (done) break;
        let timer: NodeJS.Timeout | undefined;
        const state = await Promise.race([read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('GAME_HEALTH_READ_TIMEOUT')), options.readTimeoutMs);
        })]).finally(() => clearTimeout(timer));
        if (done || combined.aborted) break;
        if (state.connected === false && !state.matchEnded) throw Error('GAME_CONNECTION_LOST');
        const key = JSON.stringify([state.gameUuid, state.lastStep, state.handSha256, state.handEnded, state.matchEnded]);
        if (key !== last) { last = key; changedAt = performance.now(); await progress(); }
        else if (performance.now() - changedAt >= options.stalledMs) throw Error('GAME_PROGRESS_STALLED');
      } catch (cause) {
        if (!done && !signal.aborted && !controller.signal.aborted) {
          error = Error(automationErrorCode(cause)); controller.abort(error);
        }
        break;
      }
    }
  })();
  let result: T;
  try { result = await work(combined); }
  catch (cause) { throw error && !signal.aborted ? new MatchMonitorInterrupted(error.message, undefined) : cause; }
  finally { done = true; controller.abort(); await monitor; }
  if (error && !signal.aborted) throw new MatchMonitorInterrupted(error.message, result);
  return result;
}
