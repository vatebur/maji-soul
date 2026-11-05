import type { AuthoritativeSync, GameObservation, GameProjection, GameState, HandInitialView, Meld, OperationWindow, Seat, TileCode } from './types.ts';
import { canonical, cursorParts, digest, requireThat } from './value.ts';

export const REDUCER_VERSION = '1.0.0';
export const seats = [0, 1, 2, 3] as const;
export const baseTile = (tile: TileCode) => tile.replace('r', '');
export const known = <T>(value: T) => ({ known: true as const, value });
export const unknown = (reason: string) => ({ known: false as const, reason });
export const eventIdFor = (sessionId: string, sequence: number) => `${sessionId}:event:${sequence}`;
const localId = (kind: string, parts: unknown[]) => `${kind}-${digest(parts).slice(0, 24)}`;

export function initialProjection(sessionId: string): GameProjection {
  return { sessionId, sequence: 0, connectionEpoch: 0, room: null, matchId: null, gameMatchKey: null,
    matchOwnSeat: null, initialScores: null, gameHandKey: null, handOrdinal: 0, activeMode: 'engine', pendingMode: 'engine',
    matchStatus: 'none', handStatus: 'none', sourceCursor: null, contextEventIds: [], state: null };
}
export function doraFromIndicator(tile: TileCode): TileCode {
  const rank = Number(tile[0]), suit = tile[1]!;
  return `${suit !== 'z' ? rank % 9 + 1 : rank <= 4 ? rank % 4 + 1 : (rank - 4) % 3 + 5}${suit}` as TileCode;
}
function validateMeld(m: Meld): void {
  requireThat(m.tiles.length === (m.kind === 'chi' || m.kind === 'pon' ? 3 : 4), 'INVALID_MELD_SIZE');
  const tiles = m.tiles.map(baseTile).sort();
  if (m.kind === 'chi') {
    requireThat(tiles[0]![1] !== 'z' && tiles.every(t => t[1] === tiles[0]![1]) && Number(tiles[1]![0]) === Number(tiles[0]![0]) + 1 && Number(tiles[2]![0]) === Number(tiles[0]![0]) + 2, 'INVALID_CHI');
    requireThat(m.fromSeat === (m.actor + 3) % 4, 'INVALID_CHI_SOURCE');
  } else requireThat(new Set(tiles).size === 1, 'INVALID_MELD_TILES');
  if (m.kind === 'closed-kan') requireThat(m.fromSeat === undefined && m.calledTileIndex === undefined && m.upgradedFrom === undefined, 'INVALID_CLOSED_KAN');
  else requireThat(m.fromSeat !== undefined && m.fromSeat !== m.actor && m.calledTileIndex !== undefined && m.calledTileIndex < m.tiles.length, 'INVALID_MELD_SOURCE');
  requireThat(m.kind === 'added-kan' ? !!m.upgradedFrom : m.upgradedFrom === undefined, 'INVALID_MELD_UPGRADE');
}
export function assertView(view: HandInitialView): void {
  const own = view.players[view.ownSeat];
  requireThat(new Set(view.ownConcealed.map(t => t.instanceId)).size === view.ownConcealed.length, 'DUPLICATE_TILE_INSTANCE');
  requireThat(own.concealedCount.known && own.concealedCount.value === view.ownConcealed.length, 'OWN_COUNT_MISMATCH');
  requireThat(view.seatWind === `${(view.ownSeat - view.dealer + 4) % 4 + 1}z`, 'SEAT_WIND_MISMATCH');
  requireThat(view.doraIndicators.length > 0 && canonical(view.doraIndicators.map(doraFromIndicator)) === canonical(view.doraTiles), 'DORA_MISMATCH');
  if (view.drawnTileRef.known && view.drawnTileRef.value !== null) {
    const drawn = view.drawnTileRef.value;
    requireThat(view.ownConcealed.some(t => t.instanceId === drawn), 'DRAWN_TILE_MISSING');
    requireThat(own.concealedCount.value === 14 - 3 * own.melds.length && (!view.currentActor.known || view.currentActor.value === view.ownSeat), 'DRAWN_TILE_OUT_OF_TURN');
  }
  const counts = new Map<string, number>(), reds = new Map<string, number>();
  const add = (t: TileCode) => { const code = baseTile(t); counts.set(code, (counts.get(code) ?? 0) + 1); if (t.endsWith('r')) reds.set(t, (reds.get(t) ?? 0) + 1); };
  view.ownConcealed.forEach(t => add(t.code)); view.doraIndicators.forEach(add);
  const meldIds = new Set<string>(), riverIds = new Set<string>();
  const calledRivers: string[] = [], calledMelds: string[] = [], discardReady: Seat[] = [];
  for (const s of seats) {
    const player = view.players[s];
    requireThat(player.seat === s, 'SEAT_MISMATCH');
    requireThat(player.concealedCount.known && [13 - 3 * player.melds.length, 14 - 3 * player.melds.length].includes(player.concealedCount.value), 'CONCEALED_COUNT_INVALID');
    if (player.concealedCount.value === 14 - 3 * player.melds.length) discardReady.push(s);
    for (const r of player.river) {
      requireThat(!riverIds.has(r.eventId), 'DUPLICATE_RIVER_EVENT'); riverIds.add(r.eventId);
      if (r.calledBy === undefined) add(r.tile);
      else { requireThat(r.calledBy !== s, 'INVALID_CALLED_RIVER'); calledRivers.push(`${s}:${r.calledBy}:${r.tile}`); }
    }
    for (const m of player.melds) {
      validateMeld(m); requireThat(m.actor === s && !meldIds.has(m.id), 'MELD_OWNER_MISMATCH'); meldIds.add(m.id); m.tiles.forEach(add);
      if (m.kind !== 'closed-kan') calledMelds.push(`${m.fromSeat}:${m.actor}:${m.tiles[m.calledTileIndex!]}`);
    }
  }
  requireThat(discardReady.length <= 1 && (!view.currentActor.known || discardReady.length === 0 || discardReady[0] === view.currentActor.value), 'MULTIPLE_ACTIVE_HANDS');
  requireThat(canonical(calledRivers.sort()) === canonical(calledMelds.sort()), 'CALLED_RIVER_MELD_MISMATCH');
  requireThat([...counts.values()].every(n => n <= 4) && [...reds.values()].every(n => n <= 1), 'IMPOSSIBLE_VISIBLE_TILES');
}
function trust(state: GameState): void {
  state.trustIssues = [...state.unknownFields];
  if (!state.tilesRemaining.known) state.trustIssues.push('tilesRemaining');
  if (!state.drawnTileRef.known) state.trustIssues.push('drawnTileRef');
  state.trust = state.trustIssues.length ? 'untrusted' : 'trusted';
}
export function assertWindow(state: GameState, window: OperationWindow): void {
  requireThat(window.connectionEpoch === state.connectionEpoch && window.status === 'open' && window.candidates.length > 0, 'INVALID_WINDOW');
  const actions = new Set<string>();
  for (const c of window.candidates) {
    requireThat(c.evidenceEventIds.length > 0 && !actions.has(canonical(c.action)), 'INVALID_CANDIDATES'); actions.add(canonical(c.action));
    if (c.action.kind === 'discard' || c.action.kind === 'riichi-discard') {
      const { tile, tsumogiri } = c.action;
      requireThat(c.authority === 'executor' && state.currentActor.known && state.currentActor.value === state.ownSeat, 'INVALID_DISCARD_ACTOR');
      requireThat(state.ownConcealed.length === 14 - 3 * state.players[state.ownSeat].melds.length, 'INVALID_DISCARD_COUNT');
      requireThat(state.ownConcealed.some(t => t.instanceId === tile) && state.drawnTileRef.known && tsumogiri === (state.drawnTileRef.value === tile), 'INVALID_DISCARD_CANDIDATE');
      if (state.players[state.ownSeat].riichi === 'accepted') requireThat(tsumogiri, 'RIICHI_HAND_DISCARD');
      if (c.action.kind === 'riichi-discard') requireThat(c.action.operation.type === 7 && state.players[state.ownSeat].riichi === 'none' && state.players[state.ownSeat].score >= 1000 && state.players[state.ownSeat].melds.every(m => m.kind === 'closed-kan'), 'INVALID_RIICHI_CANDIDATE');
    } else if (c.action.kind === 'tsumo' || c.action.kind === 'ron') requireThat(c.authority === 'client-auto-win', 'INVALID_WIN_AUTHORITY');
    else {
      const action = c.action, own = state.players[state.ownSeat];
      const code = { chi: 2, pon: 3, 'closed-kan': 4, 'open-kan': 5, 'added-kan': 6 }[action.kind];
      requireThat(c.authority === 'executor' && action.operation.type === code, 'INVALID_MELD_CANDIDATE');
      const meld: Meld = { id: 'candidate', actor: state.ownSeat, kind: action.kind, tiles: action.tiles,
        ...(action.fromSeat === undefined ? {} : { fromSeat: action.fromSeat, calledTileIndex: action.calledTileIndex }),
        ...(action.upgradedFrom === undefined ? {} : { upgradedFrom: action.upgradedFrom }) };
      validateMeld(meld);
      requireThat(new Set(action.consumed).size === action.consumed.length, 'INVALID_CONSUMED_REFS');
      let consumedCodes = [...action.tiles];
      if (action.kind === 'added-kan') {
        const prior = own.melds.find(m => m.id === action.upgradedFrom);
        requireThat(prior?.kind === 'pon' && prior.fromSeat === action.fromSeat && prior.calledTileIndex === action.calledTileIndex && own.riichi === 'none', 'INVALID_KAN_UPGRADE');
        for (const code of prior.tiles) { const at = consumedCodes.indexOf(code); requireThat(at >= 0, 'KAN_TILE_MISMATCH'); consumedCodes.splice(at, 1); }
      } else if (action.kind !== 'closed-kan') {
        requireThat(!state.currentActor.known && state.latestAction?.kind === 'discard' && state.latestAction.actor === action.fromSeat && own.riichi === 'none', 'INVALID_CALL_WINDOW');
        const river = state.players[action.fromSeat!].river.at(-1);
        requireThat(river?.eventId === state.latestAction.eventId && river.calledBy === undefined && river.tile === action.tiles[action.calledTileIndex!], 'CALLED_TILE_MISMATCH');
        consumedCodes.splice(action.calledTileIndex!, 1);
      }
      if (action.kind === 'closed-kan' || action.kind === 'added-kan') requireThat(state.currentActor.known && state.currentActor.value === state.ownSeat, 'KAN_ACTOR_MISMATCH');
      const actual = action.consumed.map(id => state.ownConcealed.find(t => t.instanceId === id)?.code);
      requireThat(actual.every(Boolean) && canonical(actual.sort()) === canonical(consumedCodes.sort()), 'MELD_CONSUMED_MISMATCH');
    }
  }
}
function rekeyView(view: HandInitialView & { operationWindow?: OperationWindow }, epoch: number, handId: string): typeof view {
  const copy = structuredClone(view), refs = new Map<string, string>();
  copy.ownConcealed.forEach((t, i) => { const id = `${handId}:e${epoch}:tile:${i}`; refs.set(t.instanceId, id); t.instanceId = id; });
  if (copy.drawnTileRef.known && copy.drawnTileRef.value !== null) {
    const id = refs.get(copy.drawnTileRef.value); requireThat(id, 'DRAWN_TILE_MISSING'); copy.drawnTileRef = known(id);
  }
  if (copy.operationWindow) {
    copy.operationWindow.candidates.forEach(c => {
      if (c.action.kind === 'discard' || c.action.kind === 'riichi-discard') { const id = refs.get(c.action.tile); requireThat(id, 'CANDIDATE_TILE_MISSING'); c.action.tile = id; }
      else if (c.action.kind !== 'tsumo' && c.action.kind !== 'ron') c.action.consumed = c.action.consumed.map(ref => { const id = refs.get(ref); requireThat(id, 'CANDIDATE_TILE_MISSING'); return id; });
    });
  }
  return copy;
}
function stateFromView(projection: GameProjection, view: HandInitialView & { operationWindow?: OperationWindow }, lastDiscard?: Extract<GameObservation, { type: 'TileDiscarded' }>): GameState {
  requireThat(projection.matchId && projection.gameHandKey, 'HAND_WITHOUT_MATCH');
  assertView(view);
  const handId = localId('hand', [projection.matchId, projection.gameHandKey, projection.handOrdinal]);
  const state: GameState = { ...rekeyView(view, projection.connectionEpoch, handId),
    sessionId: projection.sessionId, matchId: projection.matchId, handId, connectionEpoch: projection.connectionEpoch,
    stateVersion: (projection.state?.stateVersion ?? 0) + 1, trust: 'syncing', trustIssues: [] };
  if (lastDiscard) {
    const fact = lastDiscard.payload, river = state.players[fact.actor].river.at(-1);
    requireThat(river && river.tile === fact.tile && river.calledBy === undefined && river.riichiDeclaration === fact.riichiDeclaration && (!fact.tsumogiri.known || river.tsumogiri === fact.tsumogiri.value), 'SYNC_ACTION_NOT_IN_VIEW');
    state.latestAction = { eventId: river.eventId, handId, actor: fact.actor, kind: 'discard', tiles: [fact.tile], tsumogiri: fact.tsumogiri, origin: 'unknown', observedAt: lastDiscard.receivedAt };
  }
  assertView(state); trust(state); if (state.operationWindow) assertWindow(state, state.operationWindow);
  return state;
}
function advanceCursor(p: GameProjection, o: GameObservation): void {
  const required = ['HandStarted', 'TileDrawn', 'TileDiscarded', 'MeldDeclared', 'HandEnded'].includes(o.type);
  requireThat(!required || o.sourceCursor, 'SOURCE_CURSOR_REQUIRED');
  if (!o.sourceCursor) return;
  const incoming = cursorParts(o.sourceCursor);
  if (p.sourceCursor) {
    const previous = cursorParts(p.sourceCursor);
    if (o.type === 'HandStarted') requireThat(previous.stream !== incoming.stream, 'HAND_STREAM_REUSED');
    else requireThat(previous.stream === incoming.stream && incoming.step === previous.step + 1, 'SOURCE_GAP');
  } else requireThat(o.type === 'HandStarted', 'SOURCE_WITHOUT_HAND');
  p.sourceCursor = o.sourceCursor;
}
export function reduceObservation(current: GameProjection, observation: GameObservation): GameProjection {
  requireThat(observation.connectionEpoch === current.connectionEpoch, 'STALE_CONNECTION');
  const p = structuredClone(current), o = observation, eventId = eventIdFor(p.sessionId, p.sequence + 1);
  advanceCursor(p, o); p.sequence++;
  if (o.type === 'RoomVerified') {
    requireThat(p.matchStatus !== 'playing' || p.room?.roomId === o.payload.room.roomId, 'ROOM_CHANGED_DURING_MATCH');
    requireThat(p.matchStatus !== 'playing' || canonical(p.room?.rules) === canonical(o.payload.room.rules), 'RULES_CHANGED_DURING_MATCH');
    p.room = structuredClone(o.payload.room);
    if (p.state) { p.state.stateVersion++; if (p.state.operationWindow) p.state.operationWindow.status = 'closed'; }
  } else if (o.type === 'MatchStarted') {
    requireThat(p.room?.roomId === o.payload.roomId && p.matchStatus !== 'playing' && p.gameMatchKey !== o.payload.gameMatchKey, 'MATCH_BOUNDARY_INVALID');
    p.matchId = localId('match', [p.sessionId, o.payload.gameMatchKey]); p.gameMatchKey = o.payload.gameMatchKey;
    p.matchOwnSeat = o.payload.ownSeat; p.initialScores = structuredClone(o.payload.initialScores);
    delete p.matchEndPending; delete p.handResult; delete p.matchResult;
    p.gameHandKey = null; p.handOrdinal = 0; p.matchStatus = 'playing'; p.handStatus = 'none'; p.sourceCursor = null; p.contextEventIds = []; p.state = null;
  } else if (o.type === 'HandStarted') {
    requireThat(p.matchStatus === 'playing' && !p.matchEndPending && p.handStatus !== 'playing' && o.payload.ordinal === p.handOrdinal + 1 && o.payload.gameHandKey !== p.gameHandKey, 'HAND_BOUNDARY_INVALID');
    requireThat(o.payload.initialView.ownSeat === p.matchOwnSeat, 'OWN_SEAT_CHANGED');
    requireThat(seats.every(s => o.payload.initialView.players[s].river.length === 0 && o.payload.initialView.players[s].melds.length === 0 && o.payload.initialView.players[s].riichi === 'none'), 'HAND_INITIAL_HISTORY_PRESENT');
    requireThat(o.payload.initialView.currentActor.known && o.payload.initialView.currentActor.value === o.payload.initialView.dealer, 'HAND_INITIAL_ACTOR_MISMATCH');
    if (p.handOrdinal === 0) requireThat(seats.every(s => o.payload.initialView.players[s].score === p.initialScores![s]), 'INITIAL_SCORE_MISMATCH');
    else requireThat(seats.every(s => o.payload.initialView.players[s].score === p.state!.players[s].score), 'HAND_SCORE_MISMATCH');
    p.gameHandKey = o.payload.gameHandKey; p.handOrdinal = o.payload.ordinal; p.activeMode = p.pendingMode; p.handStatus = 'playing'; p.contextEventIds = [];
    delete p.handResult;
    p.state = stateFromView(p, o.payload.initialView);
  } else if (o.type === 'Disconnected' && !p.state) {
    // Lobby/connection failures still belong in the durable observation stream. The actor
    // closes its control gate at ingress; there is no hand projection to mark syncing yet.
  } else {
    const s = p.state; requireThat(s && (p.matchStatus === 'playing' || o.type === 'Disconnected'), 'EVENT_WITHOUT_GAME');
    requireThat(p.handStatus === 'playing' || o.type === 'MatchEnded' || o.type === 'Disconnected', 'EVENT_AFTER_HAND');
    s.stateVersion++;
    if (o.type !== 'OperationOffered' && s.operationWindow) s.operationWindow.status = 'closed';
    switch (o.type) {
      case 'TileDrawn': {
        const player = s.players[o.payload.actor];
        requireThat(player.concealedCount.known && player.concealedCount.value === 13 - 3 * player.melds.length, 'DRAW_COUNT_INVALID');
        if (s.currentActor.known) requireThat(s.currentActor.value === o.payload.actor, 'DRAW_ACTOR_MISMATCH');
        else if (s.latestAction) requireThat(o.payload.actor === (s.latestAction.actor + 1) % 4, 'DRAW_TURN_MISMATCH');
        if (s.tilesRemaining.known && o.payload.tilesRemaining.known) requireThat(o.payload.tilesRemaining.value <= s.tilesRemaining.value, 'TILES_REMAINING_INCREASED');
        player.concealedCount = known(player.concealedCount.value + 1); s.currentActor = known(o.payload.actor); s.tilesRemaining = o.payload.tilesRemaining;
        if (o.payload.actor === s.ownSeat) {
          requireThat(o.payload.tile.known && s.drawnTileRef.known && s.drawnTileRef.value === null, 'OWN_DRAW_UNKNOWN');
          const id = `${s.handId}:e${s.connectionEpoch}:draw:${p.sequence}`; s.ownConcealed.push({ instanceId: id, code: o.payload.tile.value }); s.drawnTileRef = known(id);
        } else requireThat(!o.payload.tile.known, 'OPPONENT_HIDDEN_TILE');
        break;
      }
      case 'TileDiscarded': {
        const { actor, tile, tsumogiri, riichiDeclaration } = o.payload, player = s.players[actor];
        requireThat(s.currentActor.known && s.currentActor.value === actor, 'DISCARD_ACTOR_MISMATCH');
        requireThat(player.concealedCount.known && player.concealedCount.value === 14 - 3 * player.melds.length, 'DISCARD_COUNT_INVALID');
        if (actor === s.ownSeat) {
          requireThat(tsumogiri.known && s.drawnTileRef.known, 'OWN_DISCARD_UNKNOWN');
          const drawn = s.drawnTileRef.value;
          const at = s.ownConcealed.findIndex(t => t.code === tile && (tsumogiri.value ? t.instanceId === drawn : t.instanceId !== drawn));
          requireThat(at >= 0, 'DISCARD_TILE_MISSING'); s.ownConcealed.splice(at, 1); s.drawnTileRef = known(null);
        }
        player.concealedCount = known(player.concealedCount.value - 1);
        player.river.push({ tile, tsumogiri: tsumogiri.known ? tsumogiri.value : null, riichiDeclaration, eventId });
        if (riichiDeclaration) { requireThat(player.riichi !== 'accepted', 'RIICHI_ALREADY_ACCEPTED'); player.riichi = 'declared'; }
        s.latestAction = { eventId, handId: s.handId, actor, kind: 'discard', tiles: [tile], tsumogiri, origin: 'unknown', observedAt: o.receivedAt };
        s.currentActor = unknown('BETWEEN_ACTIONS'); break;
      }
      case 'MeldDeclared': {
        const m = structuredClone(o.payload.meld), player = s.players[m.actor]; validateMeld(m);
        requireThat(player.concealedCount.known, 'CONCEALED_COUNT_UNKNOWN');
        const selfKan = m.kind === 'closed-kan' || m.kind === 'added-kan';
        requireThat(player.concealedCount.value === (selfKan ? 14 : 13) - 3 * player.melds.length, 'MELD_COUNT_INVALID');
        if (selfKan) requireThat(s.currentActor.known && s.currentActor.value === m.actor, 'KAN_ACTOR_MISMATCH');
        else requireThat(!s.currentActor.known && s.latestAction?.actor === m.fromSeat, 'MELD_NOT_LATEST_DISCARD');
        let consumedCodes = [...m.tiles];
        if (m.kind === 'added-kan') {
          const previous = player.melds.find(v => v.id === m.upgradedFrom);
          requireThat(previous?.kind === 'pon' && previous.fromSeat === m.fromSeat && previous.calledTileIndex === m.calledTileIndex, 'INVALID_KAN_UPGRADE');
          for (const code of previous.tiles) { const at = consumedCodes.indexOf(code); requireThat(at >= 0, 'KAN_TILE_MISMATCH'); consumedCodes.splice(at, 1); }
          player.melds.splice(player.melds.indexOf(previous), 1);
        } else if (m.kind !== 'closed-kan') {
          const river = s.players[m.fromSeat!].river, called = river.at(-1);
          requireThat(called && called.eventId === s.latestAction?.eventId && called.calledBy === undefined && called.tile === m.tiles[m.calledTileIndex!], 'CALLED_TILE_MISMATCH');
          called.calledBy = m.actor; consumedCodes.splice(m.calledTileIndex!, 1);
        }
        if (m.actor === s.ownSeat) {
          const ids = o.payload.consumed;
          requireThat(new Set(ids).size === ids.length && ids.length === consumedCodes.length, 'INVALID_CONSUMED_REFS');
          const tiles = ids.map(id => s.ownConcealed.find(t => t.instanceId === id)?.code);
          requireThat(tiles.every(Boolean) && canonical(tiles.sort()) === canonical(consumedCodes.sort()), 'MELD_CONSUMED_MISMATCH');
          s.ownConcealed = s.ownConcealed.filter(t => !ids.includes(t.instanceId)); s.drawnTileRef = known(null);
        } else requireThat(o.payload.consumed.length === 0, 'OPPONENT_TILE_REFS');
        player.concealedCount = known(player.concealedCount.value - consumedCodes.length);
        player.melds.push(m); s.currentActor = known(m.actor); break;
      }
      case 'RiichiDeclared': requireThat(s.players[o.payload.actor].riichi !== 'accepted', 'RIICHI_ALREADY_ACCEPTED'); s.players[o.payload.actor].riichi = 'declared'; break;
      case 'RiichiAccepted':
        requireThat(s.players[o.payload.actor].riichi !== 'none', 'RIICHI_NOT_DECLARED');
        s.players[o.payload.actor].riichi = 'accepted'; seats.forEach(seat => { s.players[seat].score = o.payload.scores[seat]; }); s.riichiSticks = o.payload.riichiSticks; break;
      case 'DoraRevealed':
        requireThat(s.doraIndicators.every((tile, index) => o.payload.indicators[index] === tile), 'DORA_HISTORY_CHANGED');
        s.doraIndicators = [...o.payload.indicators]; s.doraTiles = [...o.payload.doraTiles]; break;
      case 'OperationOffered': requireThat(s.operationWindow?.id !== o.payload.window.id, 'WINDOW_ID_REUSED'); assertWindow(s, o.payload.window); s.operationWindow = structuredClone(o.payload.window); break;
      case 'OperationClosed': requireThat(s.operationWindow?.id === o.payload.windowId, 'UNKNOWN_WINDOW'); s.operationWindow.status = 'closed'; break;
      case 'HandEnded':
        seats.forEach(seat => { s.players[seat].score = o.payload.scores[seat]; }); p.handStatus = 'finished';
        p.handResult = structuredClone(o.payload); if (o.payload.matchEnded) p.matchEndPending = true;
        s.currentActor = unknown('HAND_ENDED'); break;
      case 'MatchEnded':
        requireThat(p.handStatus === 'finished', 'MATCH_WITH_ACTIVE_HAND'); seats.forEach(seat => { s.players[seat].score = o.payload.scores[seat]; });
        p.matchStatus = 'finished'; p.matchResult = structuredClone(o.payload); delete p.matchEndPending; break;
      case 'Disconnected': s.trust = 'syncing'; s.trustIssues = ['DISCONNECTED']; break;
    }
    assertView(s);
    if (o.type !== 'Disconnected') {
      trust(s);
      if (current.state?.trust !== 'trusted') {
        s.trust = current.state!.trust;
        s.trustIssues = [...new Set([...current.state!.trustIssues, ...s.trustIssues])];
      }
    }
  }
  p.contextEventIds = [...p.contextEventIds, eventId].slice(-32);
  return p;
}
function assertSyncEvidence(sync: AuthoritativeSync): void {
  const current = cursorParts(sync.sourceCursor), historyKeys = new Set<string>(), discards = new Map<string, string>();
  const historyDiscards = sync.handHistory.filter(o => o.type === 'TileDiscarded');
  const agreesWithRiver = (o: Extract<GameObservation, { type: 'TileDiscarded' }>, r: GameState['players'][Seat]['river'][number]) =>
    o.payload.tile === r.tile && (o.payload.tsumogiri.known ? o.payload.tsumogiri.value === r.tsumogiri : r.tsumogiri === null) && o.payload.riichiDeclaration === r.riichiDeclaration;
  let previousStep: number | undefined;
  for (const o of sync.handHistory) {
    requireThat(!['RoomVerified', 'MatchStarted', 'MatchEnded', 'Disconnected'].includes(o.type), 'INVALID_HAND_HISTORY');
    requireThat(!historyKeys.has(o.sourceDedupKey), 'SYNC_DUPLICATE_HISTORY'); historyKeys.add(o.sourceDedupKey);
    if (['HandStarted', 'TileDrawn', 'TileDiscarded', 'MeldDeclared', 'HandEnded'].includes(o.type)) requireThat(o.sourceCursor, 'SOURCE_CURSOR_REQUIRED');
    if (o.sourceCursor) {
      const cursor = cursorParts(o.sourceCursor);
      requireThat(cursor.stream === current.stream && cursor.step <= current.step, 'SYNC_EVIDENCE_CURSOR_MISMATCH');
      if (previousStep !== undefined) requireThat(cursor.step === previousStep + 1, 'SYNC_HISTORY_GAP');
      previousStep = cursor.step;
      if (o.type === 'TileDiscarded') discards.set(o.sourceCursor, canonical(o.payload));
    }
  }
  if (sync.historyCoverage === 'none') requireThat(sync.handHistory.length === 0, 'SYNC_HISTORY_COVERAGE_MISMATCH');
  if (sync.historyCoverage === 'complete-hand') {
    requireThat(sync.handHistory[0]?.type === 'HandStarted' && previousStep === current.step, 'SYNC_HISTORY_INCOMPLETE');
    for (const seat of seats) {
      const observed = historyDiscards.filter(o => o.payload.actor === seat), river = sync.currentView!.players[seat].river;
      requireThat(observed.length === river.length && observed.every((o, i) => agreesWithRiver(o, river[i]!)), 'SYNC_HISTORY_RIVER_MISMATCH');
    }
  }
  const handEnd = sync.handHistory.find(o => o.type === 'HandEnded');
  if (sync.terminal) {
    requireThat(sync.historyCoverage === 'complete-hand' && handEnd?.type === 'HandEnded' &&
      handEnd.sourceCursor === sync.sourceCursor && canonical(handEnd.payload) === canonical(sync.terminal.hand), 'SYNC_TERMINAL_HISTORY_REQUIRED');
    requireThat(!sync.currentView!.operationWindow, 'SYNC_TERMINAL_WINDOW');
    const scores = sync.terminal.match?.scores ?? sync.terminal.hand.scores;
    requireThat(seats.every(s => sync.currentView!.players[s].score === scores[s]), 'SYNC_TERMINAL_SCORES_MISMATCH');
  } else requireThat(!handEnd, 'SYNC_TERMINAL_STATE_REQUIRED');
  for (const o of sync.observedActions) {
    requireThat((o.type === 'TileDiscarded' || o.type === 'MeldDeclared') && o.sourceCursor, 'INVALID_SYNC_ACTION');
    const cursor = cursorParts(o.sourceCursor);
    requireThat(cursor.stream === current.stream && cursor.step <= current.step, 'SYNC_EVIDENCE_CURSOR_MISMATCH');
    if (o.type === 'MeldDeclared') {
      const recorded = sync.handHistory.find(h => h.type === 'MeldDeclared' && h.sourceCursor === o.sourceCursor);
      if (sync.historyCoverage === 'complete-hand') requireThat(recorded && canonical(recorded.payload) === canonical(o.payload), 'SYNC_ACTION_NOT_IN_HISTORY');
      else requireThat(sync.currentView!.players[o.payload.meld.actor].melds.some(m => canonical(m) === canonical(o.payload.meld)), 'SYNC_ACTION_NOT_IN_VIEW');
      continue;
    }
    const recorded = discards.get(o.sourceCursor), fingerprint = canonical(o.payload);
    requireThat(recorded === undefined || recorded === fingerprint, 'SYNC_ACTION_CONFLICT'); discards.set(o.sourceCursor, fingerprint);
    if (sync.historyCoverage === 'complete-hand') requireThat(historyDiscards.some(h => h.sourceCursor === o.sourceCursor && canonical(h.payload) === fingerprint), 'SYNC_ACTION_NOT_IN_HISTORY');
    else requireThat(sync.currentView!.players[o.payload.actor].river.some(r => r.eventId === o.sourceDedupKey && agreesWithRiver(o, r)), 'SYNC_ACTION_NOT_IN_VIEW');
  }
}
export function reduceSync(current: GameProjection, sync: AuthoritativeSync): GameProjection {
  requireThat(sync.coverage === 'complete-current-state' && sync.currentView && sync.missingFields.length === 0, 'SYNC_INCOMPLETE');
  requireThat(sync.connectionEpoch > current.connectionEpoch && (!current.room || current.room.roomId === sync.room.roomId), 'SYNC_SCOPE_MISMATCH');
  const p = structuredClone(current), sameMatch = current.gameMatchKey === sync.gameMatchKey, sameHand = sameMatch && current.gameHandKey === sync.gameHandKey;
  requireThat(!current.gameMatchKey || sameMatch, 'SYNC_DIFFERENT_MATCH');
  requireThat(sameHand ? sync.handOrdinal === current.handOrdinal : sync.handOrdinal > current.handOrdinal, 'SYNC_HAND_MISMATCH');
  requireThat(!sameHand || current.handStatus !== 'finished' || !!sync.terminal, 'SYNC_HAND_ALREADY_FINISHED');
  requireThat(current.matchStatus !== 'finished' || !!sync.terminal?.match, 'SYNC_MATCH_ALREADY_FINISHED');
  requireThat(!current.matchEndPending || !!sync.terminal && (!!sync.terminal.hand.matchEnded || !!sync.terminal.match), 'SYNC_MATCH_END_RETRACTED');
  if (sameHand && current.handResult && sync.terminal) {
    // A later is_end marker may add terminal certainty; settlement itself cannot change.
    const { matchEnded: _beforeEnd, ...beforeResult } = current.handResult;
    const { matchEnded: _afterEnd, ...afterResult } = sync.terminal.hand;
    requireThat(canonical(beforeResult) === canonical(afterResult), 'SYNC_HAND_RESULT_CONFLICT');
  }
  if (current.matchResult) requireThat(canonical(current.matchResult) === canonical(sync.terminal?.match), 'SYNC_MATCH_RESULT_CONFLICT');
  if (current.sourceCursor) {
    const before = cursorParts(current.sourceCursor), after = cursorParts(sync.sourceCursor);
    requireThat(sameHand ? before.stream === after.stream && after.step >= before.step : before.stream !== after.stream, 'SYNC_CURSOR_MISMATCH');
  }
  if (current.room) requireThat(canonical(current.room.rules) === canonical(sync.room.rules), 'SYNC_RULES_MISMATCH');
  assertSyncEvidence(sync);
  p.connectionEpoch = sync.connectionEpoch; p.room = structuredClone(sync.room); p.gameMatchKey = sync.gameMatchKey;
  p.matchId = localId('match', [p.sessionId, sync.gameMatchKey]); p.matchOwnSeat = sync.currentView.ownSeat;
  if (sameHand) requireThat(sync.currentView.ownSeat === current.state?.ownSeat, 'SYNC_SEAT_MISMATCH');
  p.gameHandKey = sync.gameHandKey; p.handOrdinal = sync.handOrdinal;
  p.matchStatus = sync.terminal?.match ? 'finished' : 'playing'; p.handStatus = sync.terminal ? 'finished' : 'playing';
  delete p.matchEndPending; delete p.handResult; delete p.matchResult;
  if (sync.terminal) {
    p.handResult = structuredClone(sync.terminal.hand);
    if (sync.terminal.match) p.matchResult = structuredClone(sync.terminal.match);
    else if (sync.terminal.hand.matchEnded) p.matchEndPending = true;
  }
  if (!sameHand) { p.activeMode = p.pendingMode; p.contextEventIds = []; }
  const latest = sync.historyCoverage === 'complete-hand' ? sync.handHistory.filter(o => o.sourceCursor).at(-1) : undefined;
  p.sourceCursor = sync.sourceCursor; p.state = stateFromView(p, sync.currentView, latest?.type === 'TileDiscarded' && latest.sourceCursor === sync.sourceCursor ? latest : undefined); requireThat(p.state.trust === 'trusted', 'SYNC_UNKNOWN_STATE');
  p.sequence++; p.contextEventIds = [...p.contextEventIds, eventIdFor(p.sessionId, p.sequence)].slice(-32);
  return p;
}
