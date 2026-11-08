import type { DecisionSnapshot, ObservedAction } from '../../domain/game/types.ts';
import { canonical, digest, requireThat } from '../../domain/game/value.ts';
import { array, object, string } from '../../schemas/game.ts';
import { discardText, tileName } from './explanation.ts';

export interface EvidenceTemplate {
  templateKey: string;
  evidenceIds: string[];
  text: string;
}
export interface CommentaryContext {
  archiveId: string;
  contextHash: string;
  observedAction: ObservedAction;
  decision: DecisionSnapshot | null;
  templates: EvidenceTemplate[];
  limitations: { code: string; text: string }[];
}
export interface CommentarySelection {
  claims: { templateKey: string; evidenceIds: string[] }[];
  personaText?: string;
  limitations: string[];
}
export interface CommentaryRecord {
  source: 'llm';
  decisionId: string | null;
  contextHash: string;
  factText: string;
  personaText: string;
  evidenceIds: string[];
  limitations: string[];
  claims: CommentarySelection['claims'];
  createdAt: string;
  configRevision: number;
  profileId: 'local';
}

/** All numerical/tile claims are rendered from the original confirmed scope. */
export function commentaryContext(archiveId: string, fact: ObservedAction, snapshot: DecisionSnapshot | null): CommentaryContext {
  requireThat(fact.kind === 'discard' && fact.tiles.length === 1, 'COMMENTARY_REQUIRES_DISCARD');
  if (snapshot) requireThat(snapshot.state.ownSeat === fact.actor, 'COMMENTARY_SCOPE_MISMATCH');
  const context: CommentaryContext = {
    archiveId, contextHash: digest([1, fact, snapshot]), observedAction: fact, decision: snapshot,
    templates: [{ templateKey: 'observed-discard', evidenceIds: [fact.eventId], text: discardText(fact) }],
    limitations: [{ code: 'strategy-unavailable', text: '现有证据无法确认选择这张牌的策略原因。' }],
  };
  if (!snapshot) {
    context.limitations = [{ code: 'decision-unavailable', text: '这次弃牌没有关联的已确认程序决策。' }, ...context.limitations];
    return context;
  }
  const own = snapshot.state.players[snapshot.state.ownSeat], actions = snapshot.legalActions;
  const ids = [snapshot.id, fact.eventId];
  if (own.riichi === 'accepted' && actions.length > 0 &&
      actions.every(a => a.action.kind === 'discard' && a.action.tsumogiri)) {
    context.templates.push({ templateKey: 'riichi-forced-discard', evidenceIds: ids,
      text: '当时已经立直，客户端提供的合法弃牌只有摸切。' });
    context.limitations = [];
  } else if (actions.length === 1) {
    context.templates.push({ templateKey: 'only-legal-action', evidenceIds: ids, text: '当时客户端只提供这一个合法动作。' });
    context.limitations = [];
  }
  const tile = fact.tiles[0]!;
  if (/^5[mps]$/.test(tile) && snapshot.state.ownConcealed.some(t => t.code === `${tile}r`)) {
    context.templates.push({ templateKey: 'red-five-retained', evidenceIds: ids,
      text: `打出普通${tileName(tile)}后，手里仍保留${tileName(`${tile}r` as '5mr' | '5pr' | '5sr')}。` });
  }
  const riichiCount = Object.values(snapshot.state.players).filter(p => p.seat !== fact.actor && p.riichi === 'accepted').length;
  if (riichiCount) context.templates.push({ templateKey: 'opponents-in-riichi', evidenceIds: [snapshot.id],
    text: `当时已有${riichiCount}家对手立直。` });
  context.templates.push({ templateKey: 'own-score', evidenceIds: [snapshot.id], text: `这次决策时己方为${own.score}点。` });
  return context;
}

/** A real evidence ID cannot authorize arbitrary model-written factual prose. */
export function validateCommentary(value: unknown, context: CommentaryContext, personaChoices: string[]): CommentarySelection {
  const result = object(value, ['claims', 'limitations'], ['personaText']);
  const keys = new Set<string>();
  array(result.claims, value => {
    const claim = object(value, ['templateKey', 'evidenceIds']);
    string(claim.templateKey, 80);
    array(claim.evidenceIds, id => string(id, 160), 4);
    const template = context.templates.find(t => t.templateKey === claim.templateKey);
    requireThat(template && !keys.has(claim.templateKey) &&
      canonical([...claim.evidenceIds].sort()) === canonical([...template.evidenceIds].sort()), 'INVALID_COMMENTARY_EVIDENCE');
    keys.add(claim.templateKey);
  }, 3);
  requireThat(keys.has('observed-discard'), 'COMMENTARY_DISCARD_REQUIRED');
  array(result.limitations, code => string(code, 80), 3);
  requireThat(canonical([...result.limitations].sort()) === canonical(context.limitations.map(l => l.code).sort()), 'INVALID_COMMENTARY_LIMITATIONS');
  if (result.personaText !== undefined) requireThat(typeof result.personaText === 'string' &&
    (result.personaText === '' || personaChoices.includes(result.personaText)), 'INVALID_COMMENTARY_PERSONA');
  return result as unknown as CommentarySelection;
}

export function renderCommentary(context: CommentaryContext, selection: CommentarySelection) {
  // Preserve the observed action first even when the model orders its claims differently.
  const selected = new Set(selection.claims.map(claim => claim.templateKey));
  const templates = context.templates.filter(t => selected.has(t.templateKey));
  return {
    factText: templates.map(t => t.text).join(''), personaText: selection.personaText ?? '',
    evidenceIds: [...new Set(templates.flatMap(t => t.evidenceIds))],
    limitations: context.limitations.map(l => l.text),
  };
}
