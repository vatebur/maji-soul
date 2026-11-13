import { execFileSync } from 'node:child_process';
import { runConsole } from './app/console/cli.ts';
import { checkBili } from './app/bili-check.ts';
import { spike } from './app/spikes.ts';
import { saveEvidence } from './observability/evidence.ts';
import { inspectDatabase, replay } from './app/replay.ts';
import { runEgoCommand, type EgoLiveCommand } from './app/ego-cli.ts';

const [command, probe, ...options] = process.argv.slice(2);
try {
  if (command === 'doctor') {
    let vfox: string | null = null;
    try { vfox = execFileSync('vfox', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* optional runtime manager */ }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      sqliteDriver: 'node:sqlite', runnerProtocol: 1, automationEnabled: false,
      modelConfigured: ['MAJI_AI_BASE_URL', 'MAJI_AI_MODEL', 'MAJI_AI_API_KEY'].every(k => !!process.env[k]),
      vfox }, null, 2));
  } else if (command === 'console') {
    await runConsole(process.argv.slice(3));
  } else if (command === 'bili-check' && probe && (options.length === 0 || options.length === 2 && options[0] === '--seconds')) {
    const evidence = await checkBili(probe, options[1] === undefined ? 30 : Number(options[1]));
    const evidencePath = await saveEvidence(evidence);
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
    if (evidence.status === 'blocked') process.exitCode = 2;
  } else if (command === 'spike' && probe) {
    const evidence = await spike(probe, options.includes('--play'));
    const path = await saveEvidence(evidence);
    console.log(JSON.stringify({ ...evidence, evidencePath: path }, null, 2));
    if (evidence.status === 'blocked') process.exitCode = 2;
  } else if (['live-install', 'live-reconnect', 'live-sync', 'live-once', 'live-observe', 'live-action-once', 'live-akagi'].includes(command ?? '') && probe &&
    (['live-install', 'live-reconnect'].includes(command ?? '') ?
      options.length===1 || options.length===2 && ['--phase2', '--akagi'].includes(options[1]!) : options.length===2)) {
    const result = runEgoCommand(command as EgoLiveCommand, probe, options[0]!, options[1]);
    process.stdout.write(result);
    if (result.includes('"status": "blocked"')) process.exitCode = 2;
  } else if ((command === 'replay' || command === 'dry-run') && probe) {
    const parsed: { outputDirectory?: string; dryRunCandidate?: number } = {};
    if (command === 'dry-run') parsed.dryRunCandidate = 0;
    for (let i = 0; i < options.length; i += 2) {
      const key = options[i], value = options[i + 1];
      if (!value) throw new Error('INVALID_CLI_ARGUMENTS');
      if (key === '--out') parsed.outputDirectory = value;
      else if (key === '--candidate' && command === 'dry-run' && /^\d{1,2}$/.test(value)) parsed.dryRunCandidate = Number(value);
      else throw new Error('INVALID_CLI_ARGUMENTS');
    }
    console.log(JSON.stringify(await replay(probe, parsed), null, 2));
  } else if (command === 'inspect' && probe && options.length === 1) {
    console.log(JSON.stringify(await inspectDatabase(probe, options[0]!), null, 2));
  } else {
    console.log('maji-soul\n  doctor\n  console [--replay <fixture-directory> ... | --follow <session-id> --db <database>] [--live-options <options-json> (--space <space-id> --page <page-label> | --browser-endpoint <loopback-url>)] [--auto-start] [--audio] [--avatar] [--demo-chat] [--commentary] [--bili-direct] [--port <port>] [--relay-port <port>] [--tick-ms <ms>]\n  bili-check <room-id> [--seconds <1-300>]\n  spike storage|model|speech [--play]\n  replay <fixture-directory> [--out <new-directory>]\n  dry-run <fixture-directory> [--candidate <index>] [--out <new-directory>]\n  inspect <database> <session-id>\n  live-install <active-ego-space-id> <page-label> [--phase2|--akagi]\n  live-reconnect <active-ego-space-id> <page-label> [--phase2|--akagi]\n  live-sync <active-ego-space-id> <page-label> <absolute-options-json>\n  live-once <active-ego-space-id> <page-label> <absolute-options-json>\n  live-observe <active-ego-space-id> <page-label> <absolute-options-json>\n  live-action-once <active-ego-space-id> <page-label> <absolute-options-json>\n  live-akagi <active-ego-space-id> <page-label> <absolute-options-json>\n实场自动读回倒计时与和牌开关；Akagi 连续出牌需要显式启用。');
    if (command && command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  // Never print provider/network error details or environment values.
  const code = error instanceof Error ? error.message : '';
  console.error(/^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'PROBE_FAILED');
  process.exitCode = 1;
}
