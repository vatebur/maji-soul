import type { ActionSpec, GameState, LegalAction, Meld, OperationSelection, TileCode } from '../../domain/game/types.ts';
import { digest, requireThat } from '../../domain/game/value.ts';

export interface OfferedOperation { type: number; combination?: string[]; change_tiles?: string[]; change_tile_states?: number[]; gap_type?: number }
export interface OfferedOperations { seat: number; operation_list: OfferedOperation[] }
export interface OperationRequest { method: '.lq.FastTest.inputOperation' | '.lq.FastTest.inputChiPengGang'; params: Record<string, string | number | boolean> }
/** Self-contained rules are serialized into the Page; Node and the final send use one implementation. */
export function createOperationRules(identify?: (value: unknown) => string) {
  function requireThat(condition: unknown, code: string): asserts condition { if (!condition) throw Error(code); }
  function canonical(value: unknown): string {
    if (value === null || ['boolean','string'].includes(typeof value)) return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
    throw Error('NON_JSON_VALUE');
  }
  const baseTile = (tile: TileCode) => tile.replace('r','');
  const digest = identify ?? ((value: unknown) => {
    let hash = 0x6c62272e07bb014262b821756295c58dn;
    for (const character of canonical(value)) hash = BigInt.asUintN(128,(hash ^ BigInt(character.charCodeAt(0))) * 0x1000000000000000000013bn);
    return hash.toString(16).padStart(32,'0');
  });
  const tileCode = (value: string): TileCode => {
    requireThat(/^(?:[0-9][mps]|[1-7]z)$/.test(value), 'INVALID_PROTOCOL_COMBINATION');
    return (value[0] === '0' ? `5${value[1]}r` : value) as TileCode;
  };
  const protocolTile = (value: TileCode) => value.endsWith('r') ? `0${value[1]}` : value;
  const parts = (value: string) => { requireThat(typeof value === 'string' && value.length <= 64, 'INVALID_PROTOCOL_COMBINATION'); return value.split('|').map(tileCode); };
  const sameTiles = (a: TileCode[], b: TileCode[]) => canonical([...a].sort()) === canonical([...b].sort());
  /** Hand order survives sync rekeying and gives identical copies one stable binding. */
  function consume(state: GameState, codes: TileCode[]): string[] {
    const available = [...state.ownConcealed];
    return codes.map(code => {
      const at = available.findIndex(t => t.code === code); requireThat(at >= 0, 'COMBINATION_TILE_MISSING');
      return available.splice(at, 1)[0]!.instanceId;
    });
  }
  function legalOperationActions(state: GameState, offered: OfferedOperations, windowId: string, evidenceId: string): LegalAction[] {
    requireThat(offered.seat === state.ownSeat && Array.isArray(offered.operation_list) && offered.operation_list.length > 0 && offered.operation_list.length <= 16, 'INVALID_OPERATION_LIST');
    const operations = offered.operation_list;
    requireThat(new Set(operations.map(o => o.type)).size === operations.length, 'DUPLICATE_OPERATION_TYPE');
    for (const op of operations) {
      requireThat([1,2,3,4,5,6,7,8,9].includes(op.type), 'UNSUPPORTED_OPERATION');
      requireThat((op.change_tiles === undefined || Array.isArray(op.change_tiles) && op.change_tiles.length === 0) &&
        (op.change_tile_states === undefined || Array.isArray(op.change_tile_states) && op.change_tile_states.length === 0) && (op.gap_type ?? 0) === 0, 'UNVERIFIED_OPERATION_RESTRICTIONS');
      requireThat(op.combination === undefined || Array.isArray(op.combination) && op.combination.length <= 64 && op.combination.every(c => typeof c === 'string'), 'INVALID_PROTOCOL_COMBINATION');
      // Riichi sends tile + moqie, not a combination index. The current client
      // can repeat an allowed tile; retain its first slot as the exact witness.
      // Index-addressed calls/kans (and unverified discard duplicates) stay strict.
      if (op.type !== 7) requireThat(new Set(op.combination ?? []).size === (op.combination?.length ?? 0), 'AMBIGUOUS_COMBINATION_INDEX');
    }
    const make = (action: ActionSpec, authority: LegalAction['authority'] = 'executor'): LegalAction => ({
      id: `action-${digest([windowId, action]).slice(0, 24)}`, action, authority, label: action.kind, evidenceEventIds: [evidenceId],
    });
    const wins = operations.filter(op => op.type === 8 || op.type === 9);
    if (wins.length) return wins.map(op => make({ kind: op.type === 8 ? 'tsumo' : 'ron' }, 'client-auto-win'));
    const actions: LegalAction[] = [], own = state.players[state.ownSeat], selfTurn = state.currentActor.known && state.currentActor.value === state.ownSeat;
    for (const op of operations) {
      if (op.type === 1 || op.type === 7) {
        requireThat(selfTurn && state.ownConcealed.length === 14 - 3 * own.melds.length && state.drawnTileRef.known, 'INVALID_DISCARD_ACTOR');
        const listed = (op.combination ?? []).map(c => { const p = parts(c); requireThat(p.length === 1, 'INVALID_PROTOCOL_COMBINATION'); return p[0]!; });
        if (op.type === 7) requireThat(own.riichi === 'none' && own.melds.every(m => m.kind === 'closed-kan') && own.score >= 1000 && listed.length > 0, 'INVALID_RIICHI_CANDIDATE');
        // Discard combinations are kuikae prohibitions; reach combinations are permitted discards.
        for (const tile of state.ownConcealed) {
          const tsumogiri = tile.instanceId === (state.drawnTileRef.known ? state.drawnTileRef.value : null);
          if (own.riichi === 'accepted' && !tsumogiri) continue;
          if (op.type === 1) {
            if (!listed.some(c => baseTile(c) === baseTile(tile.code))) actions.push(make({ kind: 'discard', tile: tile.instanceId, tsumogiri }));
          } else {
            const index = listed.indexOf(tile.code);
            if (index >= 0) actions.push(make({ kind: 'riichi-discard', tile: tile.instanceId, tsumogiri, operation: { type: 7, index, combination: op.combination![index]! } }));
          }
        }
        continue;
      }
      requireThat((op.combination?.length ?? 0) > 0, 'OPERATION_COMBINATION_REQUIRED');
      for (const [index, combination] of op.combination!.entries()) {
        const codes = parts(combination), operation: OperationSelection = { type: op.type, index, combination };
        if ([2,3,5].includes(op.type)) {
          const latest = state.latestAction;
          requireThat(!state.currentActor.known && latest?.kind === 'discard' && latest.actor !== state.ownSeat && own.riichi === 'none', 'INVALID_CALL_WINDOW');
          const river = state.players[latest.actor].river.at(-1);
          requireThat(river?.eventId === latest.eventId && river.calledBy === undefined && codes.length === (op.type === 5 ? 3 : 2), 'INVALID_CALL_COMBINATION');
          const tiles = [...codes, river.tile], kind = op.type === 2 ? 'chi' : op.type === 3 ? 'pon' : 'open-kan';
          if (kind === 'chi') {
            const sorted = tiles.map(baseTile).sort();
            requireThat(latest.actor === (state.ownSeat + 3) % 4 && sorted[0]![1] !== 'z' && sorted.every(c => c[1] === sorted[0]![1]) && Number(sorted[1]![0]) === Number(sorted[0]![0]) + 1 && Number(sorted[2]![0]) === Number(sorted[0]![0]) + 2, 'INVALID_CHI');
          } else requireThat(tiles.every(c => baseTile(c) === baseTile(tiles[0]!)), 'INVALID_MELD_TILES');
          actions.push(make({ kind, consumed: consume(state, codes), tiles, fromSeat: latest.actor, calledTileIndex: tiles.length - 1, operation }));
        } else if (op.type === 4) {
        requireThat(selfTurn && state.ownConcealed.length === 14 - 3 * own.melds.length && codes.length === 4 && codes.every(c => baseTile(c) === baseTile(codes[0]!)), 'INVALID_CLOSED_KAN');
          actions.push(make({ kind: 'closed-kan', consumed: consume(state, codes), tiles: codes, operation }));
        } else {
        requireThat(op.type === 6 && selfTurn && state.ownConcealed.length === 14 - 3 * own.melds.length && codes.length === 3 && codes.every(c => baseTile(c) === baseTile(codes[0]!)) && own.riichi === 'none', 'INVALID_ADDED_KAN');
          const pons = own.melds.filter(m => m.kind === 'pon' && sameTiles(m.tiles, codes));
          requireThat(pons.length === 1, 'AMBIGUOUS_KAN_UPGRADE');
          const pon = pons[0]!, remaining = state.ownConcealed.filter(t => baseTile(t.code) === baseTile(codes[0]!));
          requireThat(remaining.length === 1, 'AMBIGUOUS_KAN_TILE');
          actions.push(make({ kind: 'added-kan', consumed: [remaining[0]!.instanceId], tiles: [...pon.tiles, remaining[0]!.code], fromSeat: pon.fromSeat!, calledTileIndex: pon.calledTileIndex!, upgradedFrom: pon.id, operation }));
        }
      }
    }
    requireThat(actions.length > 0 && actions.length <= 64, 'NO_LEGAL_CANDIDATES');
    const semantics = actions.map(({ action }) => 'consumed' in action
      ? canonical([action.kind, [...action.consumed].sort(), [...action.tiles].sort(), action.fromSeat ?? null, action.calledTileIndex === undefined ? null : action.tiles[action.calledTileIndex], action.upgradedFrom ?? null])
      : canonical(action));
    requireThat(new Set(semantics).size === semantics.length, 'AMBIGUOUS_COMBINATION_INDEX');
    return actions;
  }
  /** Re-derive from the current authoritative offer. A caller cannot supply its own index. */
  function mapActionToRequest(action: ActionSpec, state: GameState, offered: OfferedOperations): OperationRequest {
    requireThat(action.kind !== 'tsumo' && action.kind !== 'ron', 'CLIENT_AUTO_WIN_WINDOW');
    const candidates = legalOperationActions(state, offered, 'mapping-check', 'mapping-evidence');
    requireThat(candidates.some(c => canonical(c.action) === canonical(action)), 'ACTION_NOT_LEGAL');
    if (action.kind === 'discard' || action.kind === 'riichi-discard') {
      const physical = state.ownConcealed.find(t => t.instanceId === action.tile)!;
      return { method: '.lq.FastTest.inputOperation', params: { type: action.kind === 'discard' ? 1 : 7, tile: protocolTile(physical.code), moqie: action.tsumogiri, timeuse: 0 } };
    }
    return { method: ['chi','pon','open-kan'].includes(action.kind) ? '.lq.FastTest.inputChiPengGang' : '.lq.FastTest.inputOperation',
      params: { type: action.operation.type, index: action.operation.index, timeuse: 0 } };
  }
  return {legalOperationActions,mapActionToRequest,protocolTile};
}
export const {legalOperationActions,mapActionToRequest,protocolTile} = createOperationRules(digest);
export function expectedActionFor(action: ActionSpec, state: GameState) {
  if (action.kind === 'discard' || action.kind === 'riichi-discard') {
    const tile = state.ownConcealed.find(t => t.instanceId === action.tile); requireThat(tile, 'ACTION_NOT_LEGAL');
    return { kind: 'discard' as const, tile: tile.code, tsumogiri: action.tsumogiri, riichiDeclaration: action.kind === 'riichi-discard' };
  }
  requireThat(action.kind !== 'tsumo' && action.kind !== 'ron', 'CLIENT_AUTO_WIN_WINDOW');
  const meld: Omit<Meld, 'id' | 'actor'> = { kind: action.kind, tiles: [...action.tiles],
    ...(action.fromSeat === undefined ? {} : { fromSeat: action.fromSeat, calledTileIndex: action.calledTileIndex! }),
    ...(action.upgradedFrom === undefined ? {} : { upgradedFrom: action.upgradedFrom }) };
  return { kind: 'meld' as const, meld };
}
