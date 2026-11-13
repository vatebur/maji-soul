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
  let terminate: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const completion = Promise.withResolvers<void>();
  const send = (message: object) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const stop = () => {
    if (stopped || closed) return;
    stopped = true;
    send({ kind: 'stop' });
    void bridgeCall(page, 'pause').catch(() => {});
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
      try {
        if (stopped && ['prepare', 'dispatch'].includes(message.method)) throw Error('LIVE_CANCELLED');
        const result = await bridgeCall(page, message.method, message.argument);
        send({ id: message.id, ok: true, result });
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'EGO_PAGE_FAILED';
        send({ id: message.id, ok: false, code });
      }
    }).catch(() => fail('LIVE_CHILD_FAILED'));
  });
  try {
    await completion.promise;
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
