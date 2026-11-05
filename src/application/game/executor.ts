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

// Exact codes only: even an uppercase error message may contain arbitrary data.
// Diagnostics are process-local and never extend a receipt or the durable ledger.
const diagnosticCodes = [
  'ACTION_TIMEOUT', 'ACTION_NOT_LEGAL', 'ACTION_CHANGED', 'ACTION_RECONCILIATION_REQUIRED', 'ACTION_SLOT_TAKEN',
  'CONTROL_BARRIER_FAILED', 'CONTROL_BARRIER_PENDING', 'EXECUTION_PAUSED', 'DECISION_STALE', 'STATE_NOT_TRUSTED',
  'SYNC_REQUIRED', 'INGRESS_PENDING', 'WINDOW_CLOSED', 'FENCE_STALE', 'DEADLINE_UNKNOWN', 'DEADLINE_EXCEEDED',
  'PERMIT_INVALID', 'PERMIT_EXPIRED', 'PERMIT_CAPACITY', 'CLIENT_AUTO_WIN_WINDOW',
  'STORAGE_OUTCOME_UNKNOWN', 'STORAGE_UNAVAILABLE', 'STORAGE_QUEUE_FULL', 'STORAGE_MESSAGE_TOO_LARGE',
  'STORAGE_TRANSACTION_FAILED', 'VERSION_CONFLICT', 'RECOVERY_SYNC_REQUIRED', 'SESSION_TAKEN_OVER', 'STALE_PROCESS',
  'HAND_LEDGER_STALE', 'HAND_LEDGER_TERMINAL', 'MATCH_LEDGER_TERMINAL', 'HAND_LEDGER_RESULT_CONFLICT',
  'MATCH_LEDGER_RESULT_CONFLICT', 'ATTEMPT_SCOPE_STALE', 'DISPATCH_INTENT_REQUIRED',
  'BRIDGE_NOT_BOUND', 'BRIDGE_MISSING', 'BRIDGE_UNTRUSTED', 'BRIDGE_PERMIT_INVALID', 'BRIDGE_PREPARE_INVALID',
  'GAME_FINISHED', 'PROCESS_INSTANCE_STALE', 'SOURCE_CURSOR_STALE', 'DURABLE_INTENT_REQUIRED',
  'UNSUPPORTED_LIVE_ACTION', 'UNSUPPORTED_OPERATION', 'PHASE2_ACTIONS_DISABLED', 'DEADLINE_PROVENANCE_UNVERIFIED',
  'EGO_PAGE_FAILED', 'GAME_SOCKET_UNAVAILABLE', 'CONNECTION_REATTACH_REQUIRED',
  'AUTO_WIN_UNVERIFIED', 'AUTO_WIN_CDP_UNAVAILABLE', 'AUTO_WIN_PROFILE_UNVERIFIED', 'AUTO_WIN_VIEWPORT_MISMATCH',
  'AUTO_WIN_SCREENSHOT_INVALID', 'AUTO_WIN_SCREENSHOT_FORMAT', 'AUTO_WIN_SCREENSHOT_LIMIT', 'CLIENT_VERSION_MISMATCH',
  'AUTO_WIN_READBACK_STALE', 'AUTO_WIN_READBACK_INVALID', 'AUTO_WIN_READBACK_UNKNOWN', 'AUTO_WIN_READBACK_FAILED',
  'AUTO_WIN_TOGGLE_REQUIRES_PAUSE',
  'EXECUTION_ERROR', 'EXISTING_ATTEMPT', 'DISPATCH_NOT_GRANTED',
  'TRANSPORT_NOT_SENT', 'TRANSPORT_REJECTED', 'TRANSPORT_DELIVERY_UNKNOWN',
] as const;
type ExecutorDiagnosticCode = typeof diagnosticCodes[number];
type ExecutorPhase = 'control-barrier' | 'decision' | 'reserve' | 'dispatch-intent' | 'issue-permit' |
  'prepare' | 'ledger-check' | 'consume-permit' | 'dispatch' | 'receipt' | 'simulation';
export interface ExecutorDiagnostic {
  phase: ExecutorPhase;
  code: ExecutorDiagnosticCode;
  /** The transport callback was invoked; this does not prove any bytes were sent. */
  invocationStarted: boolean;
}
function diagnosticCode(value: unknown): ExecutorDiagnosticCode {
  return diagnosticCodes.find(code => code === value) ?? 'EXECUTION_ERROR';
}
function diagnosticError(error: unknown): ExecutorDiagnosticCode {
  try { return diagnosticCode(error instanceof Error ? error.message : undefined); }
  catch { return 'EXECUTION_ERROR'; }
}

export class ActionExecutor {
  #actor: GameActor;
  #transport: ContractTestTransport | ProductionTransport | undefined;
  #timeout: number;
  #busy = false;
  #diagnostic: ExecutorDiagnostic | null = null;
  constructor(actor: GameActor, options: ExecutorOptions = {}) {
    this.#actor = actor; this.#transport = options.transport; this.#timeout = options.receiptTimeoutMs ?? 5_000;
    requireThat(!this.#transport || ['contract-test', 'live'].includes(this.#transport.kind), 'TRANSPORT_KIND_INVALID');
    requireThat(Number.isInteger(this.#timeout) && this.#timeout > 0 && this.#timeout <= 30_000, 'INVALID_RECEIPT_TIMEOUT');
    if (this.#transport?.kind === 'live') {
      const transport = this.#transport;
      actor.attachControlSink(control => transport.invalidate(control));
    }
  }
  /** Latest submission only; callers cannot mutate this diagnostic or derive send authorization from it. */
  get diagnostic(): ExecutorDiagnostic | null { return this.#diagnostic && { ...this.#diagnostic }; }
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
    this.#diagnostic = null;
    let attempt: ActionAttempt | undefined, invoked = false;
    let phase: ExecutorPhase = 'control-barrier';
    const actor = this.#actor, store = actor.storage;
    try {
      await actor.awaitControlBarrier();
      phase = 'decision';
      const snapshot = actor.decision(decisionId);
      requireThat(snapshot.legalActions.some(c => c.id === actionId && c.authority === 'executor'), 'ACTION_NOT_LEGAL');
      phase = 'reserve';
      const reservation = await store.reserveAction({ attemptId: `${decisionId}:attempt`, decisionId, actionId,
        processInstanceId: actor.processInstanceId, executionMode: mode, preparedAt: isoNow(actor.clock) });
      attempt = reservation.attempt;
      if (!reservation.created) {
        this.#diagnostic = { phase, code:'EXISTING_ATTEMPT', invocationStarted:false };
        return attempt; // Never retry an existing claim, regardless of receipt.
      }
      if (mode === 'dry-run') {
        phase = 'issue-permit';
        const command = actor.issuePermit(decisionId, actionId, attempt.id);
        phase = 'consume-permit'; actor.consumePermit(command);
        phase = 'simulation';
        return await store.markSimulated(attempt.id);
      }
      phase = 'dispatch-intent';
      const intent = await store.markDispatching(attempt.id);
      if (!intent.transitioned) {
        this.#diagnostic = { phase, code:diagnosticCode(intent.rejectionCode ?? 'DISPATCH_NOT_GRANTED'), invocationStarted:false };
        if (intent.rejectionCode && intent.rejectionCode !== 'ATTEMPT_SCOPE_STALE') actor.failClosed('DISPATCH_LEDGER_STALE');
        return intent.attempt;
      }
      phase = 'issue-permit';
      const command = actor.issuePermit(decisionId, actionId, attempt.id);
      const transport = this.#transport!;
      phase = 'prepare';
      const send = await this.#bounded(transport.kind === 'live' ? transport.prepare(command, snapshot, intent.attempt) : transport.prepare(command));
      // Another session can advance the same authoritative hand while Page
      // preparation is awaiting. Recheck the original ledger after that wait.
      phase = 'ledger-check';
      try { await store.assertDispatchCurrent(attempt.id); }
      catch (error) {
        // Locally committed ingress already invalidates the prior scope. Its
        // new authoritative state does not need another sync merely to cancel.
        if (!(error instanceof Error && error.message === 'ATTEMPT_SCOPE_STALE')) actor.failClosed('DISPATCH_LEDGER_STALE');
        throw error;
      }
      phase = 'consume-permit';
      const action = actor.consumePermit(command);
      // Final authorization and invocation share this synchronous JS turn. prepare cannot send.
      phase = 'dispatch';
      invoked = true;
      const receipt = await this.#bounded(send(action));
      if (receipt.delivery === 'not-sent' || receipt.delivery === 'rejected' || receipt.delivery === 'unknown') {
        this.#diagnostic = { phase, invocationStarted:true, code:receipt.delivery === 'not-sent' ? 'TRANSPORT_NOT_SENT' :
          receipt.delivery === 'rejected' ? 'TRANSPORT_REJECTED' : 'TRANSPORT_DELIVERY_UNKNOWN' };
      }
      phase = 'receipt';
      const result = await store.recordReceipt(attempt.id, receipt);
      if (result.status === 'uncertain') actor.failClosed('ACTION_UNCERTAIN');
      return result;
    } catch (error) {
      this.#diagnostic = { phase, code:diagnosticError(error), invocationStarted:invoked };
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
