import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LiveAcceptanceOptions } from '../live.ts';

export interface AutomationView {
  available: boolean; enabled: boolean; status: 'idle' | 'starting' | 'playing' | 'waiting' | 'stopping' | 'stopped' | 'faulted';
  completedMatches: number; sessionId: string | null; errorCode?: string;
}
export interface AutomationPort {
  readonly view: AutomationView;
  start(limits: { maxMatches: number; maxDurationMs: number }): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}
export class LiveAutomation implements AutomationPort {
  #view: AutomationView = { available: true, enabled: false, status: 'idle', completedMatches: 0, sessionId: null };
  #directory: string | undefined;
  #running: Promise<void> | undefined;
  #stopping = false;
  readonly space: string;
  readonly label: string;
  readonly options: LiveAcceptanceOptions;
  constructor(space: string, label: string, options: LiveAcceptanceOptions) {
    this.space = space; this.label = label; this.options = options;
    if (!/^\d+$/.test(space) || !/^p\d+$/.test(label)) throw Error('INVALID_CLI_ARGUMENTS');
  }
  get view() { return structuredClone(this.#view); }
  async start(limits: { maxMatches: number; maxDurationMs: number }) {
    if (this.#running) return;
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
    this.#directory = await mkdtemp(join(tmpdir(), 'maji-automation-'));
    const directory = this.#directory;
    await writeFile(join(directory, 'control.json'), JSON.stringify({ enabled: true }));
    this.#stopping = false;
    this.#view = { available: true, enabled: true, status: 'starting', completedMatches: 0, sessionId: null };
    const script = `const spaces = await listTaskSpaces();\nconst ownership = spaces.find(space => space.id === ${Number(this.space)})?.ownership;\nconst task = ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(${Number(this.space)}) : ownership === "user" ? await claimTaskSpace(${Number(this.space)}) : await taskSpace(${Number(this.space)});\nconst tabs = await task.tabs();\nconst games = tabs.filter(tab => tab.url.startsWith("https://game.maj-soul.com/"));\nconst selected = games.find(tab => tab.label === ${JSON.stringify(this.label)}) ?? (games.length === 1 ? games[0] : null);\nif (!selected) throw Error("GAME_PAGE_AMBIGUOUS");\nconst page = selected.label ? task.page(selected.label) : await task.adopt(selected.page);\nconst {runAutomation} = await import(${JSON.stringify(new URL('./automation-ego.ts', import.meta.url).href)});\nawait runAutomation(page, ${JSON.stringify(process.execPath)}, ${JSON.stringify({ ...this.options, outputDirectory: resolve(this.options.outputDirectory), databasePath: resolve(this.options.databasePath ?? 'data/live/state.sqlite') })}, ${JSON.stringify(directory)}, ${JSON.stringify(limits)});`;
    const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdin.end(`try {\n${script}\n} catch (error) {\nconst fs = await import('node:fs/promises');\nconst message = error instanceof Error ? error.message : '';\nconst errorCode = /control of this task space is with the user|browser commands are paused/i.test(message) ? 'BROWSER_CONTROL_WITH_USER' : /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'AUTOMATION_START_FAILED';\nawait fs.writeFile(${JSON.stringify(join(directory, 'status.json'))}, JSON.stringify({available:true,enabled:false,status:'faulted',completedMatches:0,sessionId:null,errorCode}));\n}`);
    this.#running = new Promise<void>(resolveDone => {
      let failed = false;
      child.once('error', () => { failed = true; });
      child.once('close', code => {
        void this.refresh().catch(() => { failed = true; }).finally(() => {
          if (failed || this.#view.status !== 'faulted' && (code !== 0 || this.#view.enabled)) this.#view = { ...this.#view, enabled: false, status: 'faulted', errorCode: 'AUTOMATION_WORKER_FAILED' };
          this.#stopping = false;
          this.#running = undefined;
          resolveDone();
        });
      });
    });
  }
  async refresh() {
    if (!this.#directory) return;
    try {
      this.#view = JSON.parse(await readFile(join(this.#directory, 'status.json'), 'utf8'));
      if (this.#stopping && this.#view.enabled) this.#view = { ...this.#view, enabled: false, status: 'stopping' };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async stop() {
    if (!this.#running || !this.#directory) return;
    this.#stopping = true;
    this.#view = { ...this.#view, enabled: false, status: 'stopping' };
    const file = join(this.#directory, 'control.json');
    await writeFile(file + '.tmp', JSON.stringify({ enabled: false }));
    await rename(file + '.tmp', file);
    // The worker pauses the browser and drains any submitted action before exiting.
  }
  async close() {
    await this.stop();
    await this.#running;
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
  }
}
