import { createHash } from 'node:crypto';

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('NON_JSON_VALUE');
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node && typeof node === 'object') { Object.values(node).forEach(freeze); Object.freeze(node); }
  };
  freeze(copy); return copy;
}
export function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
// Cursor v1 is scoped to a verified source stream (one hand), never a local receive counter.
export function cursorParts(cursor: string): { stream: string; step: number } {
  const match = /^([a-zA-Z0-9_.-]{1,128}):([0-9]{1,9})$/.exec(cursor);
  requireThat(match, 'INVALID_SOURCE_CURSOR');
  return { stream: match[1]!, step: Number(match[2]) };
}
export const nextCursor = (cursor: string) => { const { stream, step } = cursorParts(cursor); return `${stream}:${step + 1}`; };
export function observationFingerprint<T extends { observationId: string; receivedAt: string }>(observation: T): string {
  const { observationId: _id, receivedAt: _time, ...semantic } = observation;
  return digest(semantic);
}
