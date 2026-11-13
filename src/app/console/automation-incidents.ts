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

/** Only the rejected clock numbers cross the worker log boundary; arbitrary
 * page properties, errors and protocol payloads remain excluded. */
export function parseCountdownSampleRejection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry=value as Record<string,unknown>;
  const keys=['event','code','pageEpoch','generation','step','passedWaitingTime','fixedMs','addMs',
    'displayedRemainingMs','displayedBankMs','requestedMonoMs','receivedMonoMs','displaySampledMonoMs'];
  if(Object.keys(entry).length!==keys.length || !keys.every(key=>Object.hasOwn(entry,key)) ||
    entry.event!=='countdown.sample-rejected' || !['COUNTDOWN_PROTOCOL_MISMATCH','COUNTDOWN_BANK_MISMATCH'].includes(entry.code as string))return null;
  const number=(key:string,max=Number.MAX_SAFE_INTEGER)=>typeof entry[key]==='number' && Number.isFinite(entry[key]) &&
    (entry[key] as number)>=0 && (entry[key] as number)<=max;
  const integer=(key:string,max=Number.MAX_SAFE_INTEGER)=>number(key,max) && Number.isSafeInteger(entry[key]);
  if(!integer('pageEpoch') || entry.pageEpoch===0 || !integer('step',999_999_999) || entry.step===0 ||
    !(entry.generation===null || integer('generation')) || !integer('passedWaitingTime',1200) ||
    !integer('fixedMs',600000) || entry.fixedMs===0 || !integer('addMs',20000) || !integer('displayedRemainingMs',600000) ||
    !(entry.displayedBankMs===null || integer('displayedBankMs',20000)) ||
    !['requestedMonoMs','receivedMonoMs','displaySampledMonoMs'].every(key=>number(key)))return null;
  return {event:'countdown.sample-rejected' as const,code:entry.code as string,
    pageEpoch:entry.pageEpoch as number,generation:entry.generation as number|null,step:entry.step as number,
    passedWaitingTime:entry.passedWaitingTime as number,fixedMs:entry.fixedMs as number,addMs:entry.addMs as number,
    displayedRemainingMs:entry.displayedRemainingMs as number,displayedBankMs:entry.displayedBankMs as number|null,
    requestedMonoMs:entry.requestedMonoMs as number,receivedMonoMs:entry.receivedMonoMs as number,
    displaySampledMonoMs:entry.displaySampledMonoMs as number};
}

/** Opt-in performance evidence has a fixed numeric schema, never raw child
 * messages. In particular addMs records the current wire bank without guessing
 * it from a derived deadline or the time elapsed on the host. */
export function parseAutomaticTimingSample(value:unknown) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const entry=value as Record<string,unknown>;
  const keys=['event','step','fixedMs','addMs','passedWaitingTime','syncRttMs','wireToCaptureStartMs','collectionMs','sampleIndex'];
  if(Object.keys(entry).length!==keys.length || !keys.every(key=>Object.hasOwn(entry,key)) || entry.event!=='timing.automatic-sample')return null;
  const number=(key:string,max:number,integer=false)=>typeof entry[key]==='number' && Number.isFinite(entry[key]) &&
    (entry[key] as number)>=0 && (entry[key] as number)<=max && (!integer || Number.isSafeInteger(entry[key]));
  if(!number('step',999_999_999,true) || entry.step===0 || !number('fixedMs',600000,true) || entry.fixedMs===0 ||
    !number('addMs',20000,true) || !number('passedWaitingTime',1200,true) || !number('syncRttMs',30000) ||
    !number('wireToCaptureStartMs',30000) || !number('collectionMs',120000) || !number('sampleIndex',1,true))return null;
  return {event:'timing.automatic-sample' as const,step:entry.step as number,fixedMs:entry.fixedMs as number,
    addMs:entry.addMs as number,passedWaitingTime:entry.passedWaitingTime as number,syncRttMs:entry.syncRttMs as number,
    wireToCaptureStartMs:entry.wireToCaptureStartMs as number,collectionMs:entry.collectionMs as number,sampleIndex:entry.sampleIndex as number};
}

export function parseAutoWinEnsureTiming(value:unknown) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const entry=value as Record<string,unknown>;
  const keys=['event','phase','succeeded','totalMs','ackAgeMs','changedFields','captureMode','captures'];
  const phases=['scope','native-restore','recovery-table','toggle','toggle-readback','final-scope','ack','complete'];
  const scopes=['pageEpoch','sourceStream','gameUuid','handSha256','generation','lastStep','nativeRestoreRevision','controlEpoch','paused'];
  if(Object.keys(entry).length!==keys.length || !keys.every(key=>Object.hasOwn(entry,key)) ||
    entry.event!=='timing.auto-win-ensure' || !phases.includes(entry.phase as string) || typeof entry.succeeded!=='boolean' ||
    typeof entry.totalMs!=='number' || !Number.isFinite(entry.totalMs) || entry.totalMs<0 || entry.totalMs>60000 ||
    !(entry.ackAgeMs===null || typeof entry.ackAgeMs==='number' && Number.isFinite(entry.ackAgeMs) && Math.abs(entry.ackAgeMs)<=120000) ||
    !Array.isArray(entry.changedFields) || entry.changedFields.length>9 || new Set(entry.changedFields).size!==entry.changedFields.length ||
    !entry.changedFields.every(key=>typeof key==='string' && scopes.includes(key)) ||
    !['none','full','region'].includes(entry.captureMode as string) || !Number.isSafeInteger(entry.captures) ||
    (entry.captures as number)<0 || (entry.captures as number)>256)return null;
  return {event:'timing.auto-win-ensure' as const,phase:entry.phase as string,succeeded:entry.succeeded,
    totalMs:entry.totalMs,ackAgeMs:entry.ackAgeMs as number|null,changedFields:[...entry.changedFields] as string[],
    captureMode:entry.captureMode as string,captures:entry.captures as number};
}

/** Bounded line parser for an untrusted child stderr stream. Only complete,
 * whitelisted incidents and numeric clock diagnostics are forwarded. */
export class AutomationIncidentLog {
  #partial = '';
  #discarding = false;
  readonly #seen = new Set<string>();
  readonly #write: (line: string) => void;
  constructor(write: (line: string) => void = line => { process.stderr.write(line); }) { this.#write = write; }

  emit(value: unknown) {
    const incident = parseAutomationIncident(value) ?? parseCountdownSampleRejection(value) ??
      (process.env.MAJI_TIMING_TRACE==='1' ? parseAutomaticTimingSample(value) ?? parseAutoWinEnsureTiming(value) : null);
    if (!incident) return;
    const key = incident.event==='automation.incident' ? `${incident.errorCode}/${incident.recoveryCount}/${incident.time}` : JSON.stringify(incident);
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
