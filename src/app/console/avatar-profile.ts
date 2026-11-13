import type { ModelProfile } from '@soullink-emotion/engine';

/** These channels belong to live audio and the continuous blink/breath controllers. */
export function autonomousParameterIds(profile: ModelProfile) {
  return new Set(['mouthOpen', 'eyeOpen', 'eyeBlinkL', 'eyeBlinkR', 'breath'].flatMap(key => {
    const rule = profile.parameterMap[key as keyof ModelProfile['parameterMap']];
    return [...(rule?.target ? [rule.target] : []), ...(rule?.targets ?? [])];
  }));
}

export function motionParameters(profile: ModelProfile, all: Record<string, { min: number; max: number; default: number; name?: string }>) {
  // Only calibrated expression/body channels are delegated; clothing, visibility and physics stay fixed.
  const selected: typeof all = {}, invalid = new Set<string>();
  for (const rule of [...Object.values(profile.parameterMap), ...Object.values(profile.customParams ?? {})]) {
    if (!rule) continue;
    for (const id of [...(rule.target ? [rule.target] : []), ...(rule.targets ?? [])]) {
      const actual = all[id];
      if (!actual || invalid.has(id)) continue;
      const min = Math.max(actual.min, selected[id]?.min ?? actual.min, rule.min ?? actual.min);
      const max = Math.min(actual.max, selected[id]?.max ?? actual.max, rule.max ?? actual.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) { invalid.add(id); delete selected[id]; continue; }
      selected[id] = { min, max, default: Math.min(max, Math.max(min, actual.default)),
        ...(typeof actual.name === 'string' ? { name: actual.name } : {}) };
    }
  }
  for (const id of autonomousParameterIds(profile)) delete selected[id];
  return selected;
}
