import { randomUUID } from 'node:crypto';
import type { ActionAttempt, CallReceipt, FencedActionCommand, LegalAction } from '../../domain/game/types.ts';
import { requireThat } from '../../domain/game/value.ts';
import { GameActor } from './actor.ts';
import { isoNow } from './clock.ts';

// No production transport is supplied. Only a controlled in-process fake may implement this
// contract until the browser request allocator and final-send fence pass live validation.
export interface ContractTestTransport {
  kind: 'contract-test';
  prepare(command: FencedActionCommand): Promise<(action: LegalAction) => Promise<CallReceipt>>;
}
export interface ExecutorOptions { transport?: ContractTestTransport; receiptTimeoutMs?: number }
export class ActionExecutor {
  #actor: GameActor;
  #transport: ContractTestTransport | undefined;
  #timeout: number;
  #busy = false;
  constructor(actor: GameActor, options: ExecutorOptions = {}) {
    this.#actor = actor; this.#transport = options.transport; this.#timeout = options.receiptTimeoutMs ?? 5_000;
    requireThat(!this.#transport || this.#transport.kind === 'contract-test', 'LIVE_EXECUTION_UNAVAILABLE');
    requireThat(Number.isInteger(this.#timeout) && this.#timeout > 0 && this.#timeout <= 30_000, 'INVALID_RECEIPT_TIMEOUT');
  }
  dryRun(decisionId: string, actionId: string): Promise<ActionAttempt> { return this.#run(decisionId, actionId, 'dry-run'); }
  executeContract(decisionId: string, actionId: string): Promise<ActionAttempt> {
    requireThat(this.#transport, 'CONTRACT_TRANSPORT_REQUIRED'); return this.#run(decisionId, actionId, 'contract-test');
  }
  async #bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ACTION_TIMEOUT')), this.#timeout); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async #run(decisionId: string, actionId: string, mode: 'dry-run' | 'contract-test'): Promise<ActionAttempt> {
    requireThat(!this.#busy, 'EXECUTOR_BUSY'); this.#busy = true;
    let attempt: ActionAttempt | undefined, invoked = false;
    const actor = this.#actor, store = actor.storage;
    try {
      const snapshot = actor.decision(decisionId);
      requireThat(snapshot.legalActions.some(c => c.id === actionId && c.authority === 'executor'), 'ACTION_NOT_LEGAL');
      const reservation = await store.reserveAction({ attemptId: `${decisionId}:attempt`, decisionId, actionId,
        processInstanceId: actor.processInstanceId, executionMode: mode, preparedAt: isoNow(actor.clock) });
      attempt = reservation.attempt;
      if (!reservation.created) return attempt; // Never retry an existing claim, regardless of receipt.
      if (mode === 'dry-run') {
        const command = actor.issuePermit(decisionId, actionId, attempt.id); actor.consumePermit(command);
        return await store.markSimulated(attempt.id);
      }
      const intent = await store.markDispatching(attempt.id);
      if (!intent.transitioned) return intent.attempt;
      const command = actor.issuePermit(decisionId, actionId, attempt.id);
      const send = await this.#bounded(this.#transport!.prepare(command));
      const action = actor.consumePermit(command);
      // Final authorization and invocation share this synchronous JS turn. prepare cannot send.
      invoked = true;
      const receipt = await this.#bounded(send(action));
      const result = await store.recordReceipt(attempt.id, receipt);
      if (result.status === 'uncertain') actor.failClosed('ACTION_UNCERTAIN');
      return result;
    } catch (error) {
      if (attempt) {
        try {
          const result = await store.recordReceipt(attempt.id, { callId: randomUUID(), delivery: invoked ? 'unknown' : 'not-sent', observedAt: isoNow(actor.clock) });
          if (invoked) actor.failClosed('ACTION_UNCERTAIN'); return result;
        } catch { actor.failClosed('STORAGE_OUTCOME_UNKNOWN'); }
      } else if (error instanceof Error && /STORAGE|WORKER|VERSION_CONFLICT/.test(error.message)) actor.failClosed('STORAGE_OUTCOME_UNKNOWN');
      throw error;
    } finally { this.#busy = false; }
  }
}
