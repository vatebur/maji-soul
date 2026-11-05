// The ego Node helper cannot host worker_threads reliably. Keep the Actor and
// SQLite worker in the pinned project Node, and exchange only whitelisted RPCs.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { acceptLivePage, type LiveAcceptanceOptions } from './live.ts';
import type { EgoPagePort } from '../adapters/majsoul/ego-transport.ts';

const lines = createInterface({ input: process.stdin });
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let started = false;
const page: EgoPagePort = { evaluate(_source, argument) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Error('EGO_RPC_TIMEOUT')); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    process.stdout.write(JSON.stringify({ kind: 'page', id, ...argument }) + '\n');
  });
} };
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (!started) {
      if (message.kind !== 'start') throw Error('EGO_RPC_INVALID'); started = true;
      void acceptLivePage(page, message.options as LiveAcceptanceOptions).then(report => {
        process.stdout.write(JSON.stringify({ kind: 'result', report }) + '\n'); lines.close(); process.stdin.destroy();
      }).catch(() => { process.stdout.write(JSON.stringify({ kind: 'error', code: 'LIVE_CHILD_FAILED' }) + '\n'); process.exitCode = 1; lines.close(); process.stdin.destroy(); });
    } else {
      const request = pending.get(message.id); if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else request.reject(Error(typeof message.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(message.code) ? message.code : 'EGO_PAGE_FAILED'));
    }
  } catch { process.exitCode = 1; lines.close(); process.stdin.destroy(); }
});
