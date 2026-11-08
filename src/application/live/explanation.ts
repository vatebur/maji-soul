import type { CommentaryRecord } from './commentary-contract.ts';
import type { ObservedAction, TileCode } from '../../domain/game/types.ts';

export interface DiscardArchive {
  id: string;
  eventId: string;
  sessionId: string;
  matchId: string;
  handId: string;
  fact: ObservedAction;
  recovered: boolean;
  factText: string;
  decisionId: string | null;
  commentary: CommentaryRecord | null;
}

export function tileName(tile: TileCode): string {
  if (tile.endsWith('z')) return '东南西北白发中'[Number(tile[0]) - 1]!;
  return (tile.endsWith('r') ? '赤' : '') + '一二三四五六七八九'[Number(tile[0]) - 1] +
    ({ m: '万', p: '筒', s: '索' } as const)[tile[1] as 'm' | 'p' | 's'];
}

export function discardText(fact: ObservedAction): string {
  const method = fact.tsumogiri.known ? fact.tsumogiri.value ? '摸切' : '手切' : '打出';
  return `${fact.riichiDeclaration ? '宣布立直，' : ''}${method}${tileName(fact.tiles[0]!)}。`;
}

export function locateHistoricalDiscard(question: string, archive: DiscardArchive[]): DiscardArchive | string | null {
  // Only answer an identifiable discard. Arbitrary viewer text never becomes an instruction.
  if (!/弃|切|打|牌|立直|上一手|上上手|刚才/.test(question)) return null;
  const names = new Set(question.match(/赤?[一二三四五六七八九][万筒索]|[东南西北白发中](?=牌|风|[？?。！!]|$)/g) ?? []);
  const codes = new Set(question.toLowerCase().match(/(?:[1-9][mps]r?|[1-7]z)(?![a-z0-9])/g) ?? []);
  const matches = (entry: DiscardArchive) => names.has(tileName(entry.fact.tiles[0]!)) || codes.has(entry.fact.tiles[0]!);
  const mentioned = names.size + codes.size > 0;
  const offset = /上上手|倒数第二/.test(question) ? 1 : /上一手|刚才|这[手张]/.test(question) ? 0 : null;
  const candidates = offset === null ? mentioned ? archive.filter(matches) : [] :
    archive.slice(offset, offset + 1).filter(entry => !mentioned || matches(entry));
  if (candidates.length > 1) return '这张牌打过多次，请说明是哪一手。';
  const entry = candidates[0];
  if (!entry) return '请指明要回顾的弃牌。';
  return entry;
}

export function historicalAnswer(question: string, archive: DiscardArchive[]): string | null {
  const found = locateHistoricalDiscard(question, archive);
  if (typeof found === 'string' || found === null) return found;
  return `回顾：${found.factText}现有证据无法确认当时的牌理。`;
}
