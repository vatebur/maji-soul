import type { CommentaryContext, CommentaryRecord, CommentarySelection } from '../application/live/commentary-contract.ts';
import type { DiscardArchive } from '../application/live/explanation.ts';
import type { ActionAttempt, AuthoritativeSync, CallReceipt, DecisionMode, DecisionSnapshot, ExecutionMode, GameObservation, GameProjection, ObservedAction } from '../domain/game/types.ts';

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
export interface ReplayFence { revision: number; mode: DecisionMode | null }
export type DeliveryStatus = 'simulated' | 'published' | 'blocked' | 'expired' | 'uncertain' | 'failed';
export interface ConsoleWrite { id: string; fingerprint: string; at: string; body: unknown }

export interface StorageRequests {
  readCommentaryContext: { id: string };
  saveCommentary: { id: string; contextHash: string; selection: CommentarySelection; personaChoices: string[]; configRevision: number; at: string };
  openReplaySession: { sessionId: string; runId: string; startedAt: string };
  commitReplayEvent: { sessionId: string; expectedSequence: number; observation: GameObservation } & ReplayFence;
  readDiscards: { sessionId: string; limit: number };
  readProjection: { sessionId: string };
  readDecisions: { sessionId: string; matchId: string | null; handId: string | null; after: number; limit: number };
  readDecision: { id: string };
  readConsole: Record<string, never>;
  recentCommands: Record<string, never>;
  readCommand: { id: string };
  saveConsole: { revision: number; body: unknown; command: ConsoleWrite | null };
  markViewerSeen: { id: string; at: string };
  reserveDelivery: { id: string; at: string };
  finishDelivery: { id: string; status: DeliveryStatus };
  cleanupOutput: { cutoff: string };
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
export type DecisionStatus = 'confirmed' | 'uncertain' | 'failed' | 'executing' | 'pending';
export interface StorageResults {
  readCommentaryContext: CommentaryContext | null;
  saveCommentary: CommentaryRecord;
  readDiscards: DiscardArchive[];
  readProjection: { projection: GameProjection; observedAt: string; recoveryRequired: boolean } | null;
  readDecisions: { key: number; scope: DecisionSnapshot['scope']; createdAt: string; activeMode: DecisionMode; status: DecisionStatus }[];
  readDecision: { snapshot: DecisionSnapshot; attempts: ActionAttempt[]; status: DecisionStatus;
    confirmations: { attempt: ActionAttempt; fact: ObservedAction; matchedBy: 'authoritative-event' | 'authoritative-sync' }[] } | null;
  readConsole: { revision: number; body: unknown };
  recentCommands: unknown[];
  readCommand: { fingerprint: string; body: unknown } | null;
  saveConsole: number;
  markViewerSeen: boolean; reserveDelivery: boolean; finishDelivery: null;
  cleanupOutput: { replays: number; messages: number; commands: number; deliveries: number };
  openSession: GameProjection; openReplaySession: GameProjection; commitReplayEvent: CommitResult;
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
