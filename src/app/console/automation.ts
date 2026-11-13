import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { LiveAcceptanceOptions } from '../live.ts';
import { recoveryDelayMs, requiresOperator } from './automation-monitor.ts';
import { AutomationIncidentLog, automationIncident } from './automation-incidents.ts';

export interface AutomationView {
  available: boolean; enabled: boolean; status: 'creating' | 'recruiting' | 'recovering' | 'idle' | 'starting' | 'playing' | 'waiting' | 'stopping' | 'stopped' | 'faulted';
  completedMatches: number; sessionId: string | null; errorCode?: string;
  roomId?: string | null; recruitUntil?: string | null;
  recoveryCount?: number; lastErrorCode?: string | null; lastErrorAt?: string | null; nextRetryAt?: string | null;
  heartbeatAt?: string; lastProgressAt?: string;
}
export interface AutomationPort {
  readonly view: AutomationView;
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}
export class LiveAutomation implements AutomationPort {
  #view: AutomationView = { available: true, enabled: false, status: 'idle', completedMatches: 0, sessionId: null };
  #directory: string | undefined;
  #running: Promise<void> | undefined;
  #cancellation = new AbortController();
  #child: ChildProcess | undefined;
  #stopping = false;
  readonly #incidents: AutomationIncidentLog;
  readonly space: string;
  readonly label: string;
  readonly options: LiveAcceptanceOptions;
  readonly browserEndpoint: string | undefined;
  constructor(space: string, label: string, options: LiveAcceptanceOptions, browserEndpoint?: string, incidentOutput?: (line: string) => void) {
    this.space = space; this.label = label; this.options = options; this.browserEndpoint = browserEndpoint;
    this.#incidents = new AutomationIncidentLog(incidentOutput);
    if (!/^\d+$/.test(space) || !/^p\d+$/.test(label)) throw Error('INVALID_CLI_ARGUMENTS');
  }
  get view() { return structuredClone(this.#view); }
  async start() {
    if (this.#running) return;
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
    this.#directory = await mkdtemp(join(tmpdir(), 'maji-automation-'));
    await writeFile(join(this.#directory, 'control.json'), JSON.stringify({ enabled: true }));
    this.#stopping = false; this.#cancellation = new AbortController();
    this.#view = { available: true, enabled: true, status: 'starting', completedMatches: 0, sessionId: null, recoveryCount: 0 };
    this.#running = this.#supervise().catch(() => {
      this.#terminate('SIGKILL');
      this.#view = { ...this.#view, enabled: false, status: 'faulted', errorCode: 'AUTOMATION_SUPERVISOR_FAILED',
        recoveryCount: (this.#view.recoveryCount ?? 0) + 1,
        lastErrorCode: 'AUTOMATION_SUPERVISOR_FAILED', lastErrorAt: new Date().toISOString() };
      this.#incidents.emit(automationIncident('AUTOMATION_SUPERVISOR_FAILED', this.#view.recoveryCount!, 'faulted', this.#view.lastErrorAt!));
    }).finally(() => { this.#running = undefined; this.#child = undefined; this.#stopping = false; });
  }
  #terminate(signal: NodeJS.Signals) {
    if (!this.#child?.pid) return;
    try { process.kill(-this.#child.pid, signal); }
    catch { this.#child.kill(signal); }
  }
  async #supervise() {
    const directory = this.#directory!, signal = this.#cancellation.signal;
    let failures = 0;
    while (!signal.aborted) {
      const options = { ...this.options, outputDirectory: resolve(this.options.outputDirectory), databasePath: resolve(this.options.databasePath ?? 'data/live/state.sqlite') };
      const script = `const {automationErrorCode} = await import(${JSON.stringify(new URL('./automation-monitor.ts', import.meta.url).href)});
try {
const spaces = await listTaskSpaces();
const ownership = spaces.find(space => space.id === ${Number(this.space)})?.ownership;
if (ownership === "agentDelegatedToUser" || ownership === "user") throw Error("BROWSER_CONTROL_WITH_USER");
const task = await taskSpace(${Number(this.space)});\nconst tabs = await task.tabs();\nconst games = tabs.filter(tab => tab.url.startsWith("https://game.maj-soul.com/"));\nconst selected = games.find(tab => tab.label === ${JSON.stringify(this.label)}) ?? (games.length === 1 ? games[0] : null);\nif (!selected) throw Error("GAME_PAGE_AMBIGUOUS");\nconst page = selected.label ? task.page(selected.label) : await task.adopt(selected.page);\nconst {runAutomation} = await import(${JSON.stringify(new URL('./automation-loop.ts', import.meta.url).href)});\nawait runAutomation(page, ${JSON.stringify(process.execPath)}, ${JSON.stringify(options)}, ${JSON.stringify(directory)});`;
      await rm(join(directory, 'status.json'), { force: true });
      const child = this.browserEndpoint
        ? spawn(process.execPath, [fileURLToPath(new URL('./automation-chromium.ts', import.meta.url))], { detached: true, stdio: ['pipe', 'ignore', 'pipe'] })
        : spawn('ego-browser', ['nodejs'], { detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
      this.#child = child;
      child.stderr.on('data', chunk => this.#incidents.consume(chunk));
      const launchedAt = Date.now();
      let phase = '', progress = '', phaseAt = launchedAt;
      let dead = false, failureCode = 'AUTOMATION_WORKER_FAILED', kill: NodeJS.Timeout | undefined;
      const terminate = () => { if (dead) return; dead = true; this.#terminate('SIGTERM'); kill = setTimeout(() => this.#terminate('SIGKILL'), 3_000); };
      const watch = setInterval(() => {
        void this.refresh().then(() => {
          if (phase !== this.#view.status || progress !== (this.#view.lastProgressAt ?? '')) {
            phase = this.#view.status; progress = this.#view.lastProgressAt ?? ''; phaseAt = Date.now();
          }
          const phaseDeadline = phase === 'recruiting' && this.#view.recruitUntil
            ? Date.parse(this.#view.recruitUntil) + 180_000 : phaseAt + (['playing', 'recovering'].includes(phase) ? 180_000 : 120_000);
          if (Date.now() > phaseDeadline) { failureCode = 'AUTOMATION_FLOW_STALLED'; terminate(); }
          if (Date.now() - Math.max(launchedAt, Date.parse(this.#view.heartbeatAt ?? '') || 0) > 30_000) {
            failureCode = 'AUTOMATION_HEARTBEAT_TIMEOUT'; terminate();
          }
        }).catch(() => { failureCode = 'AUTOMATION_STATUS_FAILED'; terminate(); });
      }, 2_000);
      const exited = new Promise<void>(done => { child.once('close', () => done()); });
      child.once('error', () => { failureCode = 'AUTOMATION_WORKER_UNAVAILABLE'; });
      child.stdin.on('error', () => {});
      if (this.browserEndpoint) child.stdin.end(JSON.stringify({ endpoint: this.browserEndpoint, runtime: process.execPath, options, directory }));
      else child.stdin.end(script + `\n} catch (error) {\nconst fs = await import('node:fs/promises');\nawait fs.writeFile(${JSON.stringify(join(directory, 'status.json'))}, JSON.stringify({available:true,enabled:false,status:'faulted',completedMatches:0,sessionId:null,errorCode:automationErrorCode(error)}));\n}`);
      const stopDeadline = () => { kill = setTimeout(terminate, 15_000); };
      signal.addEventListener('abort', stopDeadline, { once: true });
      if (signal.aborted) stopDeadline();
      await exited;
      this.#incidents.finish();
      clearInterval(watch); clearTimeout(kill); signal.removeEventListener('abort', stopDeadline);
      // Reap descendants in the isolated group even when the launcher exited first.
      this.#terminate('SIGKILL');
      await this.refresh().catch(() => {}); this.#child = undefined;
      if (signal.aborted) break;
      const reportedFailure = !dead && this.#view.status === 'faulted' ? this.#view.errorCode : undefined;
      const reportedAt = reportedFailure ? this.#view.lastErrorAt : undefined;
      if (reportedFailure && reportedAt) this.#incidents.emit(automationIncident(reportedFailure,
        this.#view.recoveryCount ?? 0, 'faulted', reportedAt));
      if (reportedFailure && requiresOperator(reportedFailure)) {
        if (!reportedAt) {
          this.#view = { ...this.#view, recoveryCount: (this.#view.recoveryCount ?? 0) + 1,
            lastErrorCode: reportedFailure, lastErrorAt: new Date().toISOString() };
          this.#incidents.emit(automationIncident(reportedFailure, this.#view.recoveryCount!, 'faulted', this.#view.lastErrorAt!));
        }
        return;
      }
      failures = Date.now() - launchedAt > 60_000 ? 1 : failures + 1;
      const waitMs = recoveryDelayMs(failures);
      this.#view = { ...this.#view, enabled: true, status: 'recovering', sessionId: null, recruitUntil: null,
        recoveryCount: (this.#view.recoveryCount ?? 0) + 1, lastErrorCode: reportedFailure ?? failureCode,
        lastErrorAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + waitMs).toISOString() };
      if (!reportedAt) this.#incidents.emit(automationIncident(this.#view.lastErrorCode!, this.#view.recoveryCount!, 'recovering', this.#view.lastErrorAt!));
      await writeFile(join(directory, 'recovery.json'), JSON.stringify(this.#view));
      await delay(waitMs, undefined, { signal }).catch(() => {});
    }
    this.#view = { ...this.#view, enabled: false, status: 'stopped', sessionId: null, nextRetryAt: null, recruitUntil: null };
  }
  async refresh() {
    if (!this.#directory || !this.#child) return;
    const child = this.#child;
    try {
      const next: AutomationView = JSON.parse(await readFile(join(this.#directory, 'status.json'), 'utf8'));
      if (child !== this.#child) return;
      this.#view = { ...next, completedMatches: Math.max(this.#view.completedMatches, next.completedMatches),
        recoveryCount: Math.max(this.#view.recoveryCount ?? 0, next.recoveryCount ?? 0) };
      if (this.#stopping) this.#view = { ...this.#view, enabled: false, status: 'stopping' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async stop() {
    if (!this.#running || !this.#directory || this.#stopping) return;
    this.#stopping = true;
    this.#view = { ...this.#view, enabled: false, status: 'stopping' };
    const file = join(this.#directory, 'control.json');
    await writeFile(file + '.tmp', JSON.stringify({ enabled: false }));
    await rename(file + '.tmp', file);
    this.#cancellation.abort();
  }
  async close() {
    await this.stop(); await this.#running;
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
  }
}
