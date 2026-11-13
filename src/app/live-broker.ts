import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { bridgeCall, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import type { LiveAcceptanceOptions } from './live.ts';
import { validateObservationDuration } from './live-observation.ts';

/** Browser control stays here. A stopped/failed worker is always reaped before
 * recovery may replace the browser generation or launch another executor. */
export async function acceptLiveViaNode(page: EgoPagePort, options: LiveAcceptanceOptions, runtime: string, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  const observeMs = validateObservationDuration(options.observeMs);
  const child = spawn(runtime, [fileURLToPath(new URL('./live-child.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  let chain = Promise.resolve(), report: unknown, failure: string | undefined, stopped = false, closed = false;
  let lastControl: {processInstanceId:string; controlEpoch:number} | undefined;
  let stopBarrier: Promise<unknown> = Promise.resolve();
  let terminate: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const completion = Promise.withResolvers<void>();
  const send = (message: object) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const stop = () => {
    if (stopped || closed) return;
    stopped = true;
    send({ kind: 'stop' });
    // Revoke this actor's permissions without pretending that its unchanged
    // native connection is a new page. An unfenced pause increments pageEpoch
    // and invalidates the client's restore proof, stranding same-game recovery.
    // Unknown/failed ownership still takes the conservative invalidation path.
    stopBarrier = bridgeCall(page, 'pause', lastControl ? {...lastControl,paused:true} : undefined)
      .catch(() => lastControl ? bridgeCall(page,'pause').catch(() => {}) : undefined);
    terminate = setTimeout(() => {
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, 10_000);
  };
  const fail = (code: string) => { failure ??= code; stop(); };
  signal?.addEventListener('abort', stop, { once: true });
  child.once('error', () => fail('LIVE_NODE_UNAVAILABLE'));
  child.once('close', () => { closed = true; completion.resolve(); });
  const deadline = setTimeout(() => fail('LIVE_CHILD_TIMEOUT'), 45_000 + observeMs);
  send({ kind: 'start', options });
  lines.on('line', line => {
    chain = chain.then(async () => {
      if (closed || failure) return;
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw Error('LIVE_CHILD_PROTOCOL_LIMIT');
      const message = JSON.parse(line);
      if (message.kind === 'result') { report = message.report; return; }
      if (message.kind !== 'page') throw Error('LIVE_CHILD_FAILED');
      const traceStarted=performance.now();
      let traceCode:string|undefined;
      try {
        if (stopped && ['prepare', 'dispatch', 'dispatchPrepared'].includes(message.method)) throw Error('LIVE_CANCELLED');
        let argument=message.argument;
        if(message.method==='pause' && typeof argument?.processInstanceId==='string' &&
            Number.isSafeInteger(argument.controlEpoch) && argument.controlEpoch>=0){
          lastControl={processInstanceId:argument.processInstanceId,controlEpoch:argument.controlEpoch};
          // A queued resume publication must not undo the broker's stop.
          if(stopped)argument={...argument,paused:true};
        }
        const result = await bridgeCall(page, message.method, argument);
        send({ id: message.id, ok: true, result });
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'EGO_PAGE_FAILED';
        traceCode=code;
        send({ id: message.id, ok: false, code });
      } finally {
        if(process.env.MAJI_TIMING_TRACE==='1') {
          try { console.warn(JSON.stringify({event:'timing.page-call',method:message.method,
            durationMs:performance.now()-traceStarted,...(traceCode?{code:traceCode}:{})})); } catch { /* Read-only diagnostics cannot change child delivery. */ }
        }
      }
    }).catch(() => fail('LIVE_CHILD_FAILED'));
  });
  try {
    await completion.promise;
    await stopBarrier;
    // A blocked Page call must not hold shutdown forever. The child is gone;
    // queued calls test `closed` and may never send another action.
    if (failure) throw Error(failure);
    if (!report) throw Error(signal?.aborted ? 'LIVE_CANCELLED' : 'LIVE_CHILD_FAILED');
    return report;
  } finally {
    clearTimeout(deadline); clearTimeout(terminate); clearTimeout(kill);
    signal?.removeEventListener('abort', stop);
    lines.close(); child.stdin.destroy();
  }
}
