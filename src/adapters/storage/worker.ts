import { parentPort, workerData } from 'node:worker_threads';
import { StorageDatabase } from './database.ts';
import { boolean, object, string, timestamp } from '../../schemas/game.ts';
import { canonical, requireThat } from '../../domain/game/value.ts';

const port = parentPort;
requireThat(port, 'STORAGE_WORKER_REQUIRED');
const data = object(workerData, ['path', 'workerEpoch', 'readOnly']); string(data.path, 4096); string(data.workerEpoch); boolean(data.readOnly);
const database = new StorageDatabase(data.path, data.readOnly as boolean);
port.on('message', (input: unknown) => {
  let id: string | undefined;
  let dispatchCompleted = false;
  try {
    requireThat(Buffer.byteLength(canonical(input)) <= 2 * 1024 * 1024, 'STORAGE_MESSAGE_TOO_LARGE');
    const m = object(input, ['v', 'kind', 'id', 'workerEpoch', 'method', 'context', 'payload']);
    requireThat(m.v === 1 && m.kind === 'request' && m.workerEpoch === data.workerEpoch, 'STORAGE_PROTOCOL_MISMATCH');
    string(m.id); string(m.method); id = m.id;
    const context = object(m.context, ['deadlineAt']); timestamp(context.deadlineAt);
    requireThat(Date.now() < Date.parse(context.deadlineAt), 'STORAGE_REQUEST_EXPIRED');
    const result = database.dispatch(m.method, m.payload);
    dispatchCompleted = true;
    requireThat(Buffer.byteLength(canonical(result)) <= 2 * 1024 * 1024, 'STORAGE_RESULT_TOO_LARGE');
    port.postMessage({ v: 1, kind: 'response', id, workerEpoch: data.workerEpoch, ok: true, result });
    if (m.method === 'close') port.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'STORAGE_TRANSACTION_FAILED';
    if (id) port.postMessage({ v: 1, kind: 'response', id, workerEpoch: data.workerEpoch, ok: false, error: { code, effect: dispatchCompleted || code === 'STORAGE_TRANSACTION_FAILED' ? 'unknown' : 'none', retry: 'none' } });
    else { database.close(); port.close(); }
  }
});
