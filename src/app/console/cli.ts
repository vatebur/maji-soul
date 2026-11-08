import { readFile } from 'node:fs/promises';
import { LiveAutomation } from './automation.ts';
import { LiveRelay } from './relay.ts';
import { validateRoom, string } from '../../schemas/game.ts';
import { validateObservationDuration } from '../live-observation.ts';
import type { LiveAcceptanceOptions } from '../live.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StorageClient } from '../../adapters/storage/client.ts';
import { biliRelay, simulatedBili } from '../../adapters/live/bili-relay.ts';
import { BilibiliDirect } from '../../adapters/live/bilibili.ts';
import { loadBiliAuth } from '../../adapters/live/bilibili-api.ts';
import { fishSpeech, fishSpeechConfig } from '../../adapters/live/fish-speech.ts';
import { commentaryProvider } from '../../adapters/llm/commentary.ts';
import { modelConfig } from '../../schemas/config.ts';
import { requireThat } from '../../domain/game/value.ts';
import { loadReplay } from '../replay.ts';
import { ConsoleRuntime, type ConsoleSource } from './runtime.ts';
import { createConsoleServer } from './server.ts';

export async function runConsole(args: string[], env = process.env) {
  const replayPaths: string[] = [], switches = new Set<string>();
  let liveOptionsPath: string | undefined, space: string | undefined, page: string | undefined;
  let dbPath: string | undefined, follow: string | undefined, port = 17361, tickMs = 750;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    requireThat(arg === '--replay' || !switches.has(arg), 'INVALID_CLI_ARGUMENTS');
    switches.add(arg);
    if (arg === '--audio' || arg === '--demo-chat' || arg === '--commentary' || arg === '--bili-direct') continue;
    const value = args[++i];
    requireThat(value && !value.startsWith('--'), 'INVALID_CLI_ARGUMENTS');
    if (arg === '--live-options') liveOptionsPath = value;
    else if (arg === '--space') space = value;
    else if (arg === '--page') page = value;
    else if (arg === '--replay') replayPaths.push(value);
    else if (arg === '--follow') follow = value;
    else if (arg === '--db') dbPath = value;
    else if (arg === '--port' && /^\d{1,5}$/.test(value) && Number(value) <= 65535) port = Number(value);
    else if (arg === '--tick-ms' && /^\d{2,5}$/.test(value) && Number(value) >= 50 && Number(value) <= 60_000) tickMs = Number(value);
    else throw Error('INVALID_CLI_ARGUMENTS');
  }
  requireThat(replayPaths.length <= 12 && !(follow && replayPaths.length) && (!follow || dbPath), 'INVALID_CLI_ARGUMENTS');
  requireThat(!switches.has('--bili-direct') || !!(follow || liveOptionsPath) && !switches.has('--demo-chat'), 'BILI_DIRECT_REQUIRES_FOLLOW');
  requireThat(!liveOptionsPath && !space && !page || !!liveOptionsPath && !!space && !!page && !replayPaths.length, 'LIVE_CONSOLE_OPTIONS_REQUIRED');
  const liveOptions: LiveAcceptanceOptions | undefined = liveOptionsPath ? JSON.parse(await readFile(resolve(liveOptionsPath), 'utf8')) : undefined;
  if (liveOptions) {
    validateRoom(liveOptions.room);
    string(liveOptions.outputDirectory, 4096);
    string(liveOptions.sourceVersion, 128);
    validateObservationDuration(liveOptions.observeMs);
    dbPath ??= liveOptions.databasePath ?? 'data/live/state.sqlite';
    requireThat(!liveOptions.databasePath || resolve(liveOptions.databasePath) === resolve(dbPath!), 'LIVE_DATABASE_MISMATCH');
    liveOptions.databasePath = resolve(dbPath!);
  }
  const automation = liveOptions ? new LiveAutomation(space!, page!, liveOptions) : undefined;
  const videoRelay = liveOptions ? new LiveRelay(space!, page!) : undefined;
  const source: ConsoleSource = follow || automation ? { kind: 'follow', sessionId: follow ?? 'live-console-idle' } : { kind: 'replay',
    fixtures: await Promise.all((replayPaths.length ? replayPaths : ['tests/fixtures/phase1-discard']).map(loadReplay)) };
  if (source.kind === 'replay') {
    const starts = source.fixtures.map(f => f.events.find(o => o.type === 'MatchStarted'));
    requireThat(starts.every(start => start && start.payload.roomId === starts[0]?.payload.roomId), 'REPLAY_ROOM_MISMATCH');
  }
  const databasePath = resolve(dbPath ?? 'data/console/state.sqlite');
  if (follow) requireThat(existsSync(databasePath), 'LEDGER_NOT_FOUND');
  const store = new StorageClient(databasePath);
  let runtime: ConsoleRuntime | undefined, server: ReturnType<typeof createConsoleServer> | undefined;
  const audioRoot = resolve('data/console/audio');
  const audioDirectory = join(audioRoot, `${process.pid}-${randomUUID()}`);
  const shutdown = Promise.withResolvers<void>();
  const stop = () => shutdown.resolve();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const audio = switches.has('--audio');
    const fish = audio ? fishSpeechConfig(env) : undefined;
    const voiceId = fish?.voiceId ?? (env.FISH_REFERENCE_ID?.trim() || 'faccba1a8ac54016bcfc02761285e67f');
    const voices = voiceId ? [{ id: voiceId, label: 'Fish 中文音色', language: 'zh-CN', installed: !!fish }] : [];
    if (audio) {
      await mkdir(audioRoot, { mode: 0o700, recursive: true });
      for (const entry of await readdir(audioRoot, { withFileTypes: true })) {
        const pid = /^(\d+)-[\da-f-]{36}$/.exec(entry.name)?.[1];
        if (!pid || !entry.isDirectory()) continue;
        try { process.kill(Number(pid), 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        const dir = join(audioRoot, entry.name);
        if (Date.now() - (await stat(dir)).mtimeMs >= 7 * 86_400_000) await rm(dir, { recursive: true, force: true });
      }
    }
    const speech = fish ? fishSpeech(audioDirectory, fish) : undefined;
    const demo = switches.has('--demo-chat'), { MAJI_BILI_RELAY_URL: relay, MAJI_BILI_RELAY_TOKEN: token } = env;
    const direct = switches.has('--bili-direct');
    requireThat(demo || direct || Boolean(relay) === Boolean(token), 'INVALID_BILI_RELAY');
    requireThat(!direct || !!env.MAJI_BILI_COOKIE_FILE, 'BILI_COOKIE_NOT_CONFIGURED');
    const bili = direct ? new BilibiliDirect(await loadBiliAuth(env.MAJI_BILI_COOKIE_FILE!)) :
      demo ? simulatedBili(['刚才打了什么牌？', '上一手为什么这样打？']) : source.kind === 'follow' && relay && token ? biliRelay(relay, token) : undefined;
    if (follow) requireThat(await store.readProjection(follow), 'SESSION_NOT_FOUND');
    const modelConfigured = ['MAJI_AI_BASE_URL','MAJI_AI_MODEL','MAJI_AI_API_KEY'].every(key => !!env[key]);
    requireThat(!switches.has('--commentary') || modelConfigured, 'MODEL_NOT_CONFIGURED');
    const commentary = modelConfigured ? commentaryProvider(modelConfig(env)) : undefined;
    runtime = await ConsoleRuntime.open({ store, source, voices, voiceId, ...(automation ? { automation } : {}), ...(videoRelay ? { relay: videoRelay } : {}), ...(speech ? { speech } : {}),
      ...(bili ? { bili } : {}), ...(commentary ? { commentary } : {}) });
    if ((switches.has('--commentary') || audio && modelConfigured) && runtime.config.models.commentaryProfile !== 'local') {
      await runtime.command('config.patch', { commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: runtime.sessionId,
        expectedRevision: runtime.configRevision, changes: { models: { commentaryProfile: 'local' } } });
    }
    if (demo && !runtime.config.interaction.roomId) {
      await runtime.command('config.patch', { commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: runtime.sessionId,
        expectedRevision: runtime.configRevision, changes: { interaction: { roomId: '1', dryRun: true } } });
    }
    server = createConsoleServer(runtime, port);
    const urls = await server.listen();
    console.log(JSON.stringify({ ...urls, source: source.kind, databasePath, audio, automationEnabled: false }, null, 2));
    while (true) {
      await runtime.tick();
      const elapsed = new Promise<'tick'>(resolve => { const timer = setTimeout(() => resolve('tick'), tickMs); timer.unref(); });
      if (await Promise.race([shutdown.promise, elapsed]) !== 'tick') break;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await server?.close(); }
    finally {
      try { await runtime?.close(); }
      finally { await store.close(); await rm(audioDirectory, { recursive: true, force: true }); }
    }
  }
}
