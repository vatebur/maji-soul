import { requireThat } from '../../domain/game/value.ts';
import { array, boolean, integer, object, oneOf, string } from '../../schemas/game.ts';
import type { DecisionMode } from '../../domain/game/types.ts';

export type ModerationRule = { id: string; match: 'literal'; pattern: string } &
  ({ action: 'drop' } | { action: 'replace'; replacement: string });
export interface LiveConfig {
  run: { defaultMode: DecisionMode };
  persona: { name: string; style: string; catchphrases: string[]; teasingIntensity: 'mild' | 'normal' | 'strong' };
  moderation: { rules: ModerationRule[] };
  interaction: { roomId: string | null; globalIntervalMs: number; viewerCooldownMs: number; replyMaxChars: number; dryRun: boolean };
  speech: { provider: 'fish'; voiceId: string };
  models: { decisionProfile: string; commentaryProfile: string; commentaryIntervalMs: number };
  output: { theme: 'dark' | 'light'; showScores: boolean };
  retention: { days: number };
}

export function defaultConfig(voiceId: string): LiveConfig {
  return {
    run: { defaultMode: 'engine' },
    persona: { name: '麻将搭子', style: '', catchphrases: [], teasingIntensity: 'mild' },
    moderation: { rules: [] },
    interaction: { roomId: null, globalIntervalMs: 5000, viewerCooldownMs: 30_000, replyMaxChars: 20, dryRun: true },
    speech: { provider: 'fish', voiceId },
    models: { decisionProfile: 'disabled', commentaryProfile: 'disabled', commentaryIntervalMs: 15_000 },
    output: { theme: 'dark', showScores: true },
    retention: { days: 7 },
  };
}
const text = (value: unknown, max: number) => { if (value !== '') string(value, max); };
export function patchConfig(current: LiveConfig, input: unknown, voices: string[]) {
  const groups = object(input, [], Object.keys(current));
  requireThat(Object.keys(groups).length > 0, 'INVALID_CONFIG');
  const next = structuredClone(current);
  for (const key of Object.keys(groups) as (keyof LiveConfig)[]) {
    const patch = object(groups[key], [], Object.keys(current[key]));
    requireThat(Object.keys(patch).length > 0, 'INVALID_CONFIG');
    Object.assign(next[key], patch);
  }
  const { run, persona, moderation, interaction, speech, models, output, retention } = next;
  oneOf(run.defaultMode, ['engine', 'llm']);
  string(persona.name, 50); text(persona.style, 2000); array(persona.catchphrases, x => string(x, 100), 20);
  oneOf(persona.teasingIntensity, ['mild','normal','strong']);
  const ids = new Set<string>();
  array(moderation.rules, input => {
    const rule = object(input, ['id','match','pattern','action'], ['replacement']);
    string(rule.id, 128); string(rule.pattern, 256); oneOf(rule.match, ['literal']); oneOf(rule.action, ['drop','replace']);
    requireThat(!ids.has(rule.id) && !!normalizeText(rule.pattern), 'INVALID_MODERATION_RULE');
    ids.add(rule.id);
    if (rule.action === 'replace') text(rule.replacement, 256);
    else requireThat(rule.replacement === undefined, 'INVALID_MODERATION_RULE');
  }, 500);
  if (interaction.roomId !== null) {
    string(interaction.roomId, 20); requireThat(/^[1-9][0-9]*$/.test(interaction.roomId), 'INVALID_ROOM_ID');
  }
  integer(interaction.globalIntervalMs, 1000, 60_000); integer(interaction.viewerCooldownMs, 0, 600_000);
  integer(interaction.replyMaxChars, 1, 100); boolean(interaction.dryRun);
  oneOf(speech.provider, ['fish']); string(speech.voiceId, 128);
  if (groups.speech) requireThat(voices.includes(speech.voiceId), 'VOICE_UNAVAILABLE');
  oneOf(models.decisionProfile, ['disabled']); oneOf(models.commentaryProfile, ['disabled', 'local']);
  integer(models.commentaryIntervalMs, 1000, 300_000);
  oneOf(output.theme, ['dark', 'light']); boolean(output.showScores); integer(retention.days, 1, 365);
  return { next, groups };
}

export const normalizeText = (text: string) => text.normalize('NFKC').replace(/[\p{Cf}\p{Cc}]/gu, '').trim();
export function moderate(input: string, rules: ModerationRule[], limit = 1000): string | null {
  let text = normalizeText(input);
  const patterns = rules.map(rule => ({ rule, pattern: normalizeText(rule.pattern) })).filter(entry => entry.pattern);
  if (patterns.some(({ rule, pattern }) => rule.action === 'drop' && text.includes(pattern))) return null;
  for (const { rule, pattern } of patterns) {
    if (rule.action === 'replace') text = text.replaceAll(pattern, () => normalizeText(rule.replacement));
    if (text.length > 4096) return null;
  }
  text = [...text.trim()].slice(0, limit).join('');
  // Reject newly introduced matches, including matches spanning a replacement.
  return text && !patterns.some(({ pattern }) => text.includes(pattern)) ? text : null;
}
