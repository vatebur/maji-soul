import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { bridgeCall, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import type { LiveAcceptanceOptions } from './live.ts';

/** Run inside ego's documented Node environment; browser control stays in this process. */
export async function acceptLiveViaNode(page: EgoPagePort, options: LiveAcceptanceOptions, runtime: string): Promise<any> {
  const child = spawn(runtime, [fileURLToPath(new URL('./live-child.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Child diagnostics never enter page data or the report (and cannot expose raw frames).
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  let chain = Promise.resolve(), report: unknown;
  child.stdin.write(JSON.stringify({ kind: 'start', options }) + '\n');
  return await new Promise((resolve, reject) => {
    let settled = false;
    const abort = (code: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      lines.close(); child.stdin.destroy(); child.kill('SIGTERM');
      // Revoke outside the request chain, including when an earlier Page call is stuck.
      void bridgeCall(page, 'pause').catch(() => {});
      reject(Error(code));
    };
    const observeMs = Number.isInteger(options.observeMs) && options.observeMs! > 0 ? Math.min(options.observeMs!,300_000) : 0;
    const timer = setTimeout(() => abort('LIVE_CHILD_TIMEOUT'), 45_000+observeMs);
    child.on('error', () => abort('LIVE_NODE_UNAVAILABLE'));
    lines.on('line', line => {
      chain = chain.then(async () => {
        if (settled) return;
        if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw Error('LIVE_CHILD_PROTOCOL_LIMIT');
        const message = JSON.parse(line);
        if (message.kind === 'result') { report = message.report; return; }
        if (message.kind !== 'page') throw Error('LIVE_CHILD_FAILED');
        try {
          const result = await bridgeCall(page, message.method, message.argument);
          child.stdin.write(JSON.stringify({ id: message.id, ok: true, result }) + '\n');
        } catch (error) {
          const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'EGO_PAGE_FAILED';
          child.stdin.write(JSON.stringify({ id: message.id, ok: false, code }) + '\n');
        }
      }).catch(() => abort('LIVE_CHILD_FAILED'));
    });
    child.on('close', () => { void chain.then(() => {
      if (settled) return;
      if (!report) { abort('LIVE_CHILD_FAILED'); return; }
      settled = true; clearTimeout(timer); resolve(report);
    }); });
  });
}
