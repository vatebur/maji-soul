import { execFileSync } from 'node:child_process';
import { MAX_LIVE_OBSERVATION_MS } from './live-observation.ts';

/** Use ego's documented Node environment; input is passed through stdin, never a shell. */
export function runEgoCommand(command: 'live-install' | 'live-reconnect' | 'live-sync' | 'live-once' | 'live-observe', space: string, label: string, optionsPath?: string): string {
  if (!/^\d+$/.test(space) || !/^p\d+$/.test(label) || (!['live-install', 'live-reconnect'].includes(command) && !optionsPath)) throw Error('INVALID_CLI_ARGUMENTS');
  const installUrl = new URL('../adapters/majsoul/install.ts', import.meta.url).href;
  const liveUrl = new URL('./live-broker.ts', import.meta.url).href;
  const script = `const task = await taskSpace(${Number(space)});
const page = task.page(${JSON.stringify(label)});
${['live-install', 'live-reconnect'].includes(command)
    ? `const {installLiveBridge} = await import(${JSON.stringify(installUrl)}); console.log(JSON.stringify(await installLiveBridge(page,${command === 'live-reconnect'}),null,2));`
    : `const fs = await import('node:fs/promises');
const {acceptLiveViaNode} = await import(${JSON.stringify(liveUrl)});
const options = JSON.parse(await fs.readFile(${JSON.stringify(optionsPath)},'utf8'));
options.discardOnce = ${command === 'live-once'};
${command === 'live-observe' ? 'if (options.observeMs === undefined) options.observeMs = 30000;' : 'options.observeMs = 0;'}
console.log(JSON.stringify(await acceptLiveViaNode(page,options,${JSON.stringify(process.execPath)}),null,2));`}`;
  return execFileSync('ego-browser', ['nodejs'], { input: script, encoding: 'utf8', maxBuffer: 1024 * 1024,
    timeout: command === 'live-observe' ? MAX_LIVE_OBSERVATION_MS+60_000 : 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
}
