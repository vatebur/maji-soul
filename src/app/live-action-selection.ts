import type { DecisionSnapshot, GameProjection, Meld, TileCode } from '../domain/game/types.ts';
import { cursorParts, requireThat } from '../domain/game/value.ts';
import { tile } from '../schemas/game.ts';

type Scope = { gameMatchKey: string; gameHandKey: string; step: number };
export type LiveActionSelection = Scope & (
  { kind: Meld['kind']; index: number; combination: string } |
  { kind: 'riichi-discard'; concealedIndex: number; tile: TileCode; tsumogiri: boolean }
);

export function validateLiveActionSelection(value: unknown): asserts value is LiveActionSelection {
  requireThat(value && typeof value==='object' && !Array.isArray(value), 'INVALID_LIVE_ACTION_SELECTION');
  const s=value as Record<string,unknown>;
  const keys=['gameMatchKey','gameHandKey','step','kind',...(s.kind==='riichi-discard' ?
    ['concealedIndex','tile','tsumogiri'] : ['index','combination'])];
  const nonnegative=(n:unknown,max:number)=>typeof n==='number' && Number.isSafeInteger(n) && n>=0 && n<=max;
  requireThat(Object.keys(s).length===keys.length && keys.every(key=>Object.hasOwn(s,key)) &&
    typeof s.gameMatchKey==='string' && /^game-[0-9a-f]{32}$/.test(s.gameMatchKey) &&
    typeof s.gameHandKey==='string' && /^hand-[0-9a-f]{32}$/.test(s.gameHandKey) &&
    nonnegative(s.step,999_999_999), 'INVALID_LIVE_ACTION_SELECTION');
  if (s.kind==='riichi-discard') {
    requireThat(nonnegative(s.concealedIndex,13) && typeof s.tsumogiri==='boolean', 'INVALID_LIVE_ACTION_SELECTION');
    tile(s.tile);
  } else {
    requireThat(['chi','pon','open-kan','closed-kan','added-kan'].includes(s.kind as string) &&
      nonnegative(s.index,63) && typeof s.combination==='string' && s.combination.length>0 &&
      s.combination.length<=64, 'INVALID_LIVE_ACTION_SELECTION');
  }
}

export function requireLiveActionScope(p: GameProjection, s: LiveActionSelection) {
  requireThat(p.gameMatchKey===s.gameMatchKey && p.gameHandKey===s.gameHandKey && p.sourceCursor &&
    cursorParts(p.sourceCursor).step===s.step, 'LIVE_ACTION_SCOPE_CHANGED');
}

export function selectLiveAction(snapshot: DecisionSnapshot, s: LiveActionSelection) {
  requireThat(cursorParts(snapshot.sourceCursor).step===s.step, 'LIVE_ACTION_SCOPE_CHANGED');
  const legal=snapshot.legalActions.filter(({authority,action})=>{
    if (authority!=='executor' || action.kind!==s.kind) return false;
    if (s.kind==='riichi-discard' && action.kind==='riichi-discard') {
      const physical=snapshot.state.ownConcealed[s.concealedIndex];
      return physical?.code===s.tile && action.tile===physical.instanceId && action.tsumogiri===s.tsumogiri;
    }
    return 'index' in s && 'operation' in action && action.operation.index===s.index &&
      action.operation.combination===s.combination;
  });
  requireThat(legal.length===1, 'LIVE_ACTION_CANDIDATE_NOT_UNIQUE');
  return legal[0]!;
}
