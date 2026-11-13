export interface AutomationIncident {
  event: 'automation.incident';
  errorCode: string;
  recoveryCount: number;
  status: 'recovering' | 'faulted';
  time: string;
}

const fields = ['event', 'errorCode', 'recoveryCount', 'status', 'time'];
const safeCode = /^[A-Z][A-Z0-9_]{0,95}$/;
const maxLine = 512;

/** The complete log schema. Raw errors, stack traces, paths and page data are
 * never fields of an incident, including when parsing a child process stream. */
export function parseAutomationIncident(value: unknown): AutomationIncident | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== fields.length || !fields.every(key => Object.hasOwn(entry, key)) ||
      entry.event !== 'automation.incident' || typeof entry.errorCode !== 'string' || !safeCode.test(entry.errorCode) ||
      !Number.isSafeInteger(entry.recoveryCount) || (entry.recoveryCount as number) < 0 ||
      !['recovering', 'faulted'].includes(entry.status as string) ||
      typeof entry.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.time) ||
      !Number.isFinite(Date.parse(entry.time)) || new Date(entry.time).toISOString() !== entry.time) return null;
  return { event: 'automation.incident', errorCode: entry.errorCode, recoveryCount: entry.recoveryCount as number,
    status: entry.status as AutomationIncident['status'], time: entry.time };
}

export function automationIncident(errorCode: string, recoveryCount: number, status: AutomationIncident['status'], time = new Date().toISOString()): AutomationIncident {
  return { event: 'automation.incident', errorCode: safeCode.test(errorCode) ? errorCode : 'AUTOMATION_FAILED', recoveryCount, status, time };
}

export const writeAutomationIncident = (incident: AutomationIncident) => {
  const safe = parseAutomationIncident(incident);
  if (safe) process.stderr.write(JSON.stringify(safe) + '\n');
};

/** Bounded line parser for an untrusted child stderr stream. Only complete,
 * whitelisted incidents are forwarded; every other byte is discarded. */
export class AutomationIncidentLog {
  #partial = '';
  #discarding = false;
  readonly #seen = new Set<string>();
  readonly #write: (line: string) => void;
  constructor(write: (line: string) => void = line => { process.stderr.write(line); }) { this.#write = write; }

  emit(value: unknown) {
    const incident = parseAutomationIncident(value);
    if (!incident) return;
    const key = `${incident.errorCode}/${incident.recoveryCount}/${incident.time}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    if (this.#seen.size > 64) this.#seen.delete(this.#seen.values().next().value!);
    try { this.#write(JSON.stringify(incident) + '\n'); } catch { /* Logging never controls gameplay. */ }
  }

  consume(chunk: Uint8Array | string) {
    const parts = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')).split('\n');
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (!this.#discarding) {
        if (this.#partial.length + part.length > maxLine) { this.#partial = ''; this.#discarding = true; }
        else this.#partial += part;
      }
      if (index < parts.length - 1) {
        if (!this.#discarding) {
          try { this.emit(JSON.parse(this.#partial)); } catch { /* Raw stderr is never forwarded. */ }
        }
        this.#partial = ''; this.#discarding = false;
      }
    }
  }

  finish() { this.#partial = ''; this.#discarding = false; }
}
