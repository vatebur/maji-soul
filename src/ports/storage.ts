import type { ActionAttempt, AuthoritativeSync, CallReceipt, DecisionMode, DecisionSnapshot, ExecutionMode, GameObservation, GameProjection } from '../domain/game/types.ts';

export interface CommitResult { projection: GameProjection; duplicate: boolean }
export interface ReserveActionInput {
  attemptId: string; decisionId: string; actionId: string; processInstanceId: string;
  executionMode: ExecutionMode; preparedAt: string;
}
export interface StorageInspection {
  projection: GameProjection; attempts: ActionAttempt[];
  counts: { events: number; outbox: number; confirmations: number; faults: number };
  recoveryRequired: boolean;
}
export interface StoragePort {
  openSession(sessionId: string, processInstanceId: string, startedAt: string): Promise<GameProjection>;
  findObservation(sessionId: string, epoch: number, dedupKey: string): Promise<{ fingerprint: string; sequence: number } | null>;
  commitGameEvent(sessionId: string, expectedSequence: number, observation: GameObservation): Promise<CommitResult>;
  commitSync(sessionId: string, expectedSequence: number, sync: AuthoritativeSync): Promise<CommitResult>;
  setPendingMode(sessionId: string, mode: DecisionMode): Promise<GameProjection>;
  saveDecision(snapshot: DecisionSnapshot, hash: string): Promise<void>;
  reserveAction(input: ReserveActionInput): Promise<{ attempt: ActionAttempt; created: boolean }>;
  markDispatching(attemptId: string): Promise<{ attempt: ActionAttempt; transitioned: boolean }>;
  recordReceipt(attemptId: string, receipt: CallReceipt): Promise<ActionAttempt>;
  markSimulated(attemptId: string): Promise<ActionAttempt>;
  getAttempt(attemptId: string): Promise<ActionAttempt | null>;
  inspect(sessionId: string): Promise<StorageInspection>;
  recordFault(sessionId: string, code: string, at: string): Promise<void>;
  close(): Promise<void>;
}

// Fixed RPC whitelist: worker transport cannot execute arbitrary SQL or call arbitrary methods.
export interface StorageRequests {
  openSession: { sessionId: string; processInstanceId: string; startedAt: string };
  findObservation: { sessionId: string; epoch: number; dedupKey: string };
  commitGameEvent: { sessionId: string; expectedSequence: number; observation: GameObservation };
  commitSync: { sessionId: string; expectedSequence: number; sync: AuthoritativeSync };
  setPendingMode: { sessionId: string; mode: DecisionMode };
  saveDecision: { snapshot: DecisionSnapshot; hash: string };
  reserveAction: ReserveActionInput;
  markDispatching: { attemptId: string };
  recordReceipt: { attemptId: string; receipt: CallReceipt };
  markSimulated: { attemptId: string };
  getAttempt: { attemptId: string };
  inspect: { sessionId: string };
  recordFault: { sessionId: string; code: string; at: string };
  close: Record<string, never>;
}
export interface StorageResults {
  openSession: GameProjection;
  findObservation: { fingerprint: string; sequence: number } | null;
  commitGameEvent: CommitResult; commitSync: CommitResult; setPendingMode: GameProjection;
  saveDecision: null;
  reserveAction: { attempt: ActionAttempt; created: boolean };
  markDispatching: { attempt: ActionAttempt; transitioned: boolean };
  recordReceipt: ActionAttempt; markSimulated: ActionAttempt; getAttempt: ActionAttempt | null;
  inspect: StorageInspection; recordFault: null; close: null;
}
export type StorageMethod = keyof StorageRequests;
