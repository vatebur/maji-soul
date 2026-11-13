export type Seat = 0 | 1 | 2 | 3;
export type TileCode = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${'m' | 'p' | 's'}`
  | `${1 | 2 | 3 | 4 | 5 | 6 | 7}z` | '5mr' | '5pr' | '5sr';
export type Knowledge<T> = { known: true; value: T } | { known: false; reason: string };
export type Scores = Record<Seat, number>;
export type DecisionMode = 'engine' | 'llm';
export interface TileInstance { instanceId: string; code: TileCode }
export interface Meld {
  id: string; actor: Seat; kind: 'chi' | 'pon' | 'open-kan' | 'closed-kan' | 'added-kan';
  tiles: TileCode[]; fromSeat?: Seat; calledTileIndex?: number; upgradedFrom?: string;
}
export interface PlayerView {
  seat: Seat; score: number;
  river: { tile: TileCode; tsumogiri: boolean | null; riichiDeclaration: boolean; calledBy?: Seat; eventId: string }[];
  melds: Meld[]; riichi: 'none' | 'declared' | 'accepted'; concealedCount: Knowledge<number>;
}
export interface HandInitialView {
  ownSeat: Seat; players: Record<Seat, PlayerView>; ownConcealed: TileInstance[];
  drawnTileRef: Knowledge<string | null>; dealer: Seat; roundWind: TileCode; seatWind: TileCode;
  handNumber: number; honba: number; riichiSticks: number;
  doraIndicators: TileCode[]; doraTiles: TileCode[];
  tilesRemaining: Knowledge<number>; currentActor: Knowledge<Seat>; unknownFields: string[];
}
export interface OperationSelection { type: number; index: number; combination: string }
export type ActionSpec = { kind: 'discard'; tile: string; tsumogiri: boolean }
  | { kind: 'riichi-discard'; tile: string; tsumogiri: boolean; operation: OperationSelection }
  | { kind: Meld['kind']; consumed: string[]; tiles: TileCode[]; operation: OperationSelection;
      fromSeat?: Seat; calledTileIndex?: number; upgradedFrom?: string }
  | { kind: 'pass' } | { kind: 'tsumo' } | { kind: 'ron' };
export interface LegalAction {
  id: string; action: ActionSpec; authority: 'executor' | 'client-auto-win'; label: string; evidenceEventIds: string[];
}
export interface OperationWindow {
  id: string; connectionEpoch: number; openedAt: string;
  deadline: Knowledge<{ at: string; sourceEventId: string; uncertaintyMs: number }>;
  candidates: LegalAction[]; status: 'open' | 'claimed' | 'submitted' | 'closed' | 'uncertain';
}
export interface ObservedAction {
  eventId: string; handId: string; actor: Seat; kind: 'discard' | 'meld'; tiles: TileCode[];
  tsumogiri: Knowledge<boolean>; origin: 'unknown'; observedAt: string;
  riichiDeclaration?: boolean; meld?: Meld;
}
export interface GameState extends HandInitialView {
  sessionId: string; matchId: string; handId: string; connectionEpoch: number; stateVersion: number;
  trust: 'trusted' | 'syncing' | 'untrusted'; trustIssues: string[];
  latestAction?: ObservedAction; operationWindow?: OperationWindow;
}
export type RoomTimeSetting = '300+0' | '60+0' | '5+20';
export interface FriendRoom {
  roomId: string;
  rules: { players: 4; length: 'east' | 'south'; displayTimeSetting: RoomTimeSetting; computerSeats: 0 | 1 | 2 | 3;
    verifiedOptions: Record<string, string | number | boolean>; protocolVersion: string };
  autoWin: 'verified-on' | 'verified-off' | 'unknown';
}
export interface ObservationBase {
  schemaVersion: 1; observationId: string; connectionEpoch: number;
  source: 'majsoul-network' | 'majsoul-sync'; sourceCursor?: string; sourceDedupKey: string;
  receivedAt: string;
}
export type ObservationPayloads = {
  RoomVerified: { room: FriendRoom; verifiedAt: string; evidenceIds: string[] };
  MatchStarted: { roomId: string; ownSeat: Seat; initialScores: Scores; gameMatchKey: string };
  HandStarted: { ordinal: number; initialView: HandInitialView; gameHandKey: string };
  TileDrawn: { actor: Seat; tile: Knowledge<TileCode>; tilesRemaining: Knowledge<number> };
  TileDiscarded: { actor: Seat; tile: TileCode; tsumogiri: Knowledge<boolean>; riichiDeclaration: boolean };
  MeldDeclared: { meld: Meld; consumed: string[] };
  RiichiDeclared: { actor: Seat };
  RiichiAccepted: { actor: Seat; scores: Scores; riichiSticks: number };
  DoraRevealed: { indicators: TileCode[]; doraTiles: TileCode[] };
  OperationOffered: { window: OperationWindow };
  OperationClosed: { windowId: string; reason: 'completed' | 'superseded' | 'expired' | 'hand-ended' };
  HandEnded: { scores: Scores; reason: 'win' | 'draw' | 'abortive-draw'; winners: Seat[]; resultLabel: string; matchEnded?: true };
  MatchEnded: { scores: Scores; ranks: Scores };
  Disconnected: { code: string; recoverable: boolean };
};
export type GameObservation = { [K in keyof ObservationPayloads]: ObservationBase & { type: K; payload: ObservationPayloads[K] } }[keyof ObservationPayloads];
export interface GameProjection {
  sessionId: string; sequence: number; connectionEpoch: number;
  room: FriendRoom | null; matchId: string | null; gameMatchKey: string | null;
  matchOwnSeat: Seat | null; initialScores: Scores | null;
  gameHandKey: string | null; handOrdinal: number; activeMode: DecisionMode; pendingMode: DecisionMode;
  matchStatus: 'none' | 'playing' | 'finished'; handStatus: 'none' | 'playing' | 'finished';
  /** A terminal protocol marker closes play while final standings are still unavailable. */
  matchEndPending?: true;
  handResult?: ObservationPayloads['HandEnded'];
  matchResult?: ObservationPayloads['MatchEnded'];
  sourceCursor: string | null; contextEventIds: string[]; state: GameState | null;
}
export interface AuthoritativeSync {
  syncId: string; connectionEpoch: number; receivedAt: string;
  coverage: 'complete-current-state' | 'partial'; room: FriendRoom;
  gameMatchKey: string; gameHandKey: string; handOrdinal: number;
  currentView?: HandInitialView & { operationWindow?: OperationWindow };
  missingFields: string[]; historyCoverage: 'complete-hand' | 'partial' | 'none';
  handHistory: GameObservation[]; observedActions: GameObservation[]; sourceCursor: string;
  /** Only complete hand history can establish terminal state during recovery. */
  terminal?: { hand: ObservationPayloads['HandEnded']; match?: ObservationPayloads['MatchEnded'] };
}
export interface DecisionSnapshot {
  schemaVersion: 1; id: string; scope: { sessionId: string; matchId: string; handId: string; decisionId: string };
  windowId: string; stateVersion: number; connectionEpoch: number; controlEpoch: number;
  createdAt: string; actionDeadline: string; activeMode: DecisionMode; state: GameState;
  legalActions: LegalAction[]; unknownFields: string[]; contextEventIds: string[]; sourceCursor: string;
}
export interface ExecutionFence {
  processInstanceId: string; sessionId: string; matchId: string; handId: string; decisionId: string;
  windowId: string; stateVersion: number; connectionEpoch: number; controlEpoch: number;
}
export interface FencedActionCommand {
  attemptId: string; actionId: string; fence: ExecutionFence; permitId: string; expiresAt: string;
}
export interface CallReceipt {
  callId: string; delivery: 'not-sent' | 'sent' | 'accepted' | 'rejected' | 'unknown'; observedAt: string;
}
export type AttemptStatus = 'prepared' | 'dispatching' | 'awaiting-confirmation' | 'confirmed' | 'rejected' | 'uncertain' | 'not-dispatched' | 'simulated';
export type ExecutionMode = 'dry-run' | 'contract-test' | 'live';
export interface ActionAttempt {
  id: string; decisionId: string; sessionId: string; matchId: string; handId: string;
  gameMatchKey: string; gameHandKey: string; windowId: string; actionId: string;
  stateVersion: number; connectionEpoch: number; controlEpoch: number; processInstanceId: string;
  executionMode: ExecutionMode; status: AttemptStatus; preparedAt: string;
  actor: Seat; tile: TileCode | null; tsumogiri: boolean; expectedCursor: string;
  /** Missing only on legacy ordinary-discard rows. Never infer a meld from tile alone. */
  actionSpec?: ActionSpec;
  expectedAction?: { kind: 'discard'; tile: TileCode; tsumogiri: boolean; riichiDeclaration: boolean }
    | { kind: 'meld'; meld: Omit<Meld, 'id' | 'actor'> } | { kind: 'pass' };
  receipt?: CallReceipt; confirmationEventId?: string;
}
