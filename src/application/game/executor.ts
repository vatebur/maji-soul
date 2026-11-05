import { randomUUID } from 'node:crypto';
import type { ActionAttempt, CallReceipt, DecisionSnapshot, ExecutionMode, FencedActionCommand, LegalAction } from '../../domain/game/types.ts';
import { requireThat } from '../../domain/game/value.ts';
import { GameActor, type ActorControl } from './actor.ts';
import { isoNow } from './clock.ts';

export interface ContractTestTransport {
  kind: 'contract-test';
  prepare(command: FencedActionCommand): Promise<(action: LegalAction) => Promise<CallReceipt>>;
}
/** prepare never sends. The returned function must repeat authorization in the browser's
 * synchronous final send turn and return not-sent when that final fence rejects. */
export interface ProductionTransport {
  kind: 'live';
  invalidate(control: ActorControl): void | Promise<void>;
  prepare(command: FencedActionCommand, snapshot: DecisionSnapshot, intent: ActionAttempt): Promise<(action: LegalAction) => Promise<CallReceipt>>;
}
export interface ExecutorOptions { transport?: ContractTestTransport | ProductionTransport; receiptTimeoutMs?: number }
export class ActionExecutor {
  #actor: GameActor;
  #transport: ContractTestTransport | ProductionTransport | undefined;
  #timeout: number;
  #busy = false;
  constructor(actor: GameActor, options: ExecutorOptions = {}) {
    this.#actor = actor; this.#transport = options.transport; this.#timeout = options.receiptTimeoutMs ?? 5_000;
    requireThat(!this.#transport || ['contract-test', 'live'].includes(this.#transport.kind), 'TRANSPORT_KIND_INVALID');
    requireThat(Number.isInteger(this.#timeout) && this.#timeout > 0 && this.#timeout <= 30_000, 'INVALID_RECEIPT_TIMEOUT');
    if (this.#transport?.kind === 'live') {
      const transport = this.#transport;
      actor.attachControlSink(control => transport.invalidate(control));
    }
  }
  dryRun(decisionId: string, actionId: string): Promise<ActionAttempt> { return this.#run(decisionId, actionId, 'dry-run'); }
  executeContract(decisionId: string, actionId: string): Promise<ActionAttempt> {
    requireThat(this.#transport?.kind === 'contract-test', 'CONTRACT_TRANSPORT_REQUIRED'); return this.#run(decisionId, actionId, 'contract-test');
  }
  executeLive(decisionId: string, actionId: string): Promise<ActionAttempt> {
    requireThat(this.#transport?.kind === 'live', 'LIVE_TRANSPORT_REQUIRED'); return this.#run(decisionId, actionId, 'live');
  }
  async #bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ACTION_TIMEOUT')), this.#timeout); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async #run(decisionId: string, actionId: string, mode: ExecutionMode): Promise<ActionAttempt> {
    requireThat(!this.#busy, 'EXECUTOR_BUSY'); this.#busy = true;
    let attempt: ActionAttempt | undefined, invoked = false;
    const actor = this.#actor, store = actor.storage;
    try {
      await actor.awaitControlBarrier();
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
      const transport = this.#transport!;
      const send = await this.#bounded(transport.kind === 'live' ? transport.prepare(command, snapshot, intent.attempt) : transport.prepare(command));
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
