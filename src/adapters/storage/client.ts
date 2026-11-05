import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { ActionAttempt, AuthoritativeSync, CallReceipt, DecisionMode, DecisionSnapshot, GameObservation } from '../../domain/game/types.ts';
import { canonical, requireThat } from '../../domain/game/value.ts';
import type { ReserveActionInput, StorageMethod, StoragePort, StorageRequests, StorageResults } from '../../ports/storage.ts';

interface Pending { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
/** Bounded, fail-closed RPC client. A timed-out write has an unknown outcome: reopen and inspect its stable IDs. */
export class StorageClient implements StoragePort {
  readonly #worker: Worker;
  readonly #workerEpoch = randomUUID();
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;
  readonly #capacity: number;
  #unavailable = false;
  #closing = false;
  constructor(path: string, options: { timeoutMs?: number; capacity?: number; readOnly?: boolean } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5_000; this.#capacity = options.capacity ?? 64;
    requireThat(Number.isInteger(this.#timeoutMs) && this.#timeoutMs >= 1 && this.#timeoutMs <= 120_000 && Number.isInteger(this.#capacity) && this.#capacity >= 1 && this.#capacity <= 1024, 'INVALID_STORAGE_OPTIONS');
    this.#worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { path, workerEpoch: this.#workerEpoch, readOnly: options.readOnly ?? false } });
    this.#worker.on('message', (value: unknown) => {
      try {
        requireThat(value && typeof value === 'object' && Buffer.byteLength(canonical(value)) <= 2 * 1024 * 1024, 'STORAGE_PROTOCOL_MISMATCH');
        const message = value as Record<string, unknown>;
        requireThat(message.v === 1 && message.kind === 'response' && message.workerEpoch === this.#workerEpoch && typeof message.id === 'string' && typeof message.ok === 'boolean', 'STORAGE_PROTOCOL_MISMATCH');
        const pending = this.#pending.get(message.id); if (!pending) return;
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else {
          const error = message.error as { code?: unknown; effect?: unknown } | null;
          if (error?.effect === 'unknown') { pending.reject(new Error('STORAGE_OUTCOME_UNKNOWN')); this.#fail('STORAGE_OUTCOME_UNKNOWN'); }
          else pending.reject(new Error(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'STORAGE_TRANSACTION_FAILED'));
        }
      } catch { this.#fail('STORAGE_OUTCOME_UNKNOWN'); }
    });
    this.#worker.on('error', () => this.#fail('STORAGE_OUTCOME_UNKNOWN'));
    this.#worker.on('exit', () => { if (!this.#closing || this.#pending.size) this.#fail('STORAGE_OUTCOME_UNKNOWN'); });
  }
  #fail(code: string): void {
    if (this.#unavailable) return;
    this.#unavailable = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error(code)); }
    this.#pending.clear(); void this.#worker.terminate();
  }
  #call<K extends StorageMethod>(method: K, payload: StorageRequests[K]): Promise<StorageResults[K]> {
    if (this.#unavailable || (this.#closing && method !== 'close')) return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
    if (this.#pending.size >= this.#capacity) return Promise.reject(new Error('STORAGE_QUEUE_FULL'));
    const id = randomUUID(), request = { v: 1, kind: 'request', id, workerEpoch: this.#workerEpoch, method,
      context: { deadlineAt: new Date(Date.now() + this.#timeoutMs).toISOString() }, payload };
    try { requireThat(Buffer.byteLength(canonical(request)) <= 2 * 1024 * 1024, 'STORAGE_MESSAGE_TOO_LARGE'); }
    catch (error) { return Promise.reject(error); }
    return new Promise<StorageResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('STORAGE_OUTCOME_UNKNOWN'), this.#timeoutMs);
      this.#pending.set(id, { resolve: result => resolve(result as StorageResults[K]), reject, timer });
      try { this.#worker.postMessage(request); } catch { this.#fail('STORAGE_OUTCOME_UNKNOWN'); }
    });
  }
  openSession(sessionId: string, processInstanceId: string, startedAt: string) { return this.#call('openSession', { sessionId, processInstanceId, startedAt }); }
  findObservation(sessionId: string, epoch: number, dedupKey: string) { return this.#call('findObservation', { sessionId, epoch, dedupKey }); }
  commitGameEvent(sessionId: string, expectedSequence: number, observation: GameObservation) { return this.#call('commitGameEvent', { sessionId, expectedSequence, observation }); }
  commitSync(sessionId: string, expectedSequence: number, sync: AuthoritativeSync) { return this.#call('commitSync', { sessionId, expectedSequence, sync }); }
  setPendingMode(sessionId: string, mode: DecisionMode) { return this.#call('setPendingMode', { sessionId, mode }); }
  async saveDecision(snapshot: DecisionSnapshot, hash: string): Promise<void> { await this.#call('saveDecision', { snapshot, hash }); }
  reserveAction(input: ReserveActionInput) { return this.#call('reserveAction', input); }
  markDispatching(attemptId: string) { return this.#call('markDispatching', { attemptId }); }
  async assertDispatchCurrent(attemptId: string): Promise<void> { await this.#call('assertDispatchCurrent', { attemptId }); }
  recordReceipt(attemptId: string, receipt: CallReceipt) { return this.#call('recordReceipt', { attemptId, receipt }); }
  markSimulated(attemptId: string) { return this.#call('markSimulated', { attemptId }); }
  getAttempt(attemptId: string): Promise<ActionAttempt | null> { return this.#call('getAttempt', { attemptId }); }
  inspect(sessionId: string) { return this.#call('inspect', { sessionId }); }
  inspectMatch(gameMatchKey: string) { return this.#call('inspectMatch', { gameMatchKey }); }
  async recordFault(sessionId: string, code: string, at: string): Promise<void> { await this.#call('recordFault', { sessionId, code, at }); }
  async close(): Promise<void> {
    if (this.#closing || this.#unavailable) return;
    this.#closing = true;
    try { await this.#call('close', {}); } finally { this.#unavailable = true; await this.#worker.terminate(); }
  }
}
