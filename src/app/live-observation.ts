export const MAX_LIVE_OBSERVATION_MS = 1_800_000;

/** Validate before creating an acceptance directory or starting a child process. */
export function validateObservationDuration(observeMs: unknown): number {
  const duration = observeMs === undefined ? 0 : observeMs;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0 || duration > MAX_LIVE_OBSERVATION_MS)
    throw Error('INVALID_OBSERVATION_DURATION');
  return duration;
}
