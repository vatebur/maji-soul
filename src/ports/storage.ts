import type { ActionAttempt, AuthoritativeSync, CallReceipt, DecisionMode, DecisionSnapshot, ExecutionMode, GameObservation, GameProjection } from '../domain/game/types.ts';

export interface CommitResult { projection: GameProjection; duplicate: boolean }
export interface DispatchIntentResult { attempt: ActionAttempt; transitioned: boolean; rejectionCode?: string }
export interface ReserveActionInput {
  attemptId: string; decisionId: string; actionId: string; processInstanceId: string;
  executionMode: ExecutionMode; preparedAt: string;
}
export interface StorageInspection {
  projection: GameProjection; attempts: ActionAttempt[];
  counts: { events: number; outbox: number; confirmations: number; faults: number };
  recoveryRequired: boolean;
}
export interface MatchInspection {
  gameMatchKey: string;
  hands: { gameHandKey: string; ordinal: number; status: 'playing' | 'finished'; result?: NonNullable<GameProjection['handResult']> }[];
  matchStatus: 'unknown' | 'playing' | 'pending-result' | 'finished';
  matchResult?: NonNullable<GameProjection['matchResult']>;
  unresolvedAttempts: ActionAttempt[];
}
export interface StoragePort {
  openSession(sessionId: string, processInstanceId: string, startedAt: string): Promise<GameProjection>;
  findObservation(sessionId: string, epoch: number, dedupKey: string): Promise<{ fingerprint: string; sequence: number } | null>;
  commitGameEvent(sessionId: string, expectedSequence: number, observation: GameObservation): Promise<CommitResult>;
  commitSync(sessionId: string, expectedSequence: number, sync: AuthoritativeSync): Promise<CommitResult>;
  setPendingMode(sessionId: string, mode: DecisionMode): Promise<GameProjection>;
  saveDecision(snapshot: DecisionSnapshot, hash: string): Promise<void>;
  reserveAction(input: ReserveActionInput): Promise<{ attempt: ActionAttempt; created: boolean }>;
  markDispatching(attemptId: string): Promise<DispatchIntentResult>;
  assertDispatchCurrent(attemptId: string): Promise<void>;
  recordReceipt(attemptId: string, receipt: CallReceipt): Promise<ActionAttempt>;
  markSimulated(attemptId: string): Promise<ActionAttempt>;
  getAttempt(attemptId: string): Promise<ActionAttempt | null>;
  inspect(sessionId: string): Promise<StorageInspection>;
  inspectMatch(gameMatchKey: string): Promise<MatchInspection>;
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
  assertDispatchCurrent: { attemptId: string };
  recordReceipt: { attemptId: string; receipt: CallReceipt };
  markSimulated: { attemptId: string };
  getAttempt: { attemptId: string };
  inspect: { sessionId: string };
  inspectMatch: { gameMatchKey: string };
  recordFault: { sessionId: string; code: string; at: string };
  close: Record<string, never>;
}
export interface StorageResults {
  openSession: GameProjection;
  findObservation: { fingerprint: string; sequence: number } | null;
  commitGameEvent: CommitResult; commitSync: CommitResult; setPendingMode: GameProjection;
  saveDecision: null;
  reserveAction: { attempt: ActionAttempt; created: boolean };
  markDispatching: DispatchIntentResult;
  assertDispatchCurrent: null;
  recordReceipt: ActionAttempt; markSimulated: ActionAttempt; getAttempt: ActionAttempt | null;
  inspect: StorageInspection; inspectMatch: MatchInspection; recordFault: null; close: null;
}
export type StorageMethod = keyof StorageRequests;
