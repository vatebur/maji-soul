import '@pixi/unsafe-eval';
import { loadModelProfile, type ModelProfile } from '@soullink-emotion/engine';
import { Live2DRenderer, createScriptTagCubismLoader } from '@soullink-emotion/live2d-pixi';
import { AvatarAudioPlayback, commandKey, leaseDeadline, type AvatarCommand, type AvatarPlaybackStatus } from './avatar-playback.ts';
import { motionParameters } from './avatar-profile.ts';
import { configureAvatarMasks } from './avatar-renderer-compat.ts';
import { AvatarMotionController } from './avatar-motion.ts';

type Config = { enabled: boolean; modelConfigured: boolean; modelUrl: string | null; profileUrl: string | null; coreUrl: string | null; characterName: string };
type Lease = { leaseId: string; leaseMs: number; serverNow: number; expiresAt: number };
type Poll = Lease & { command: AvatarCommand | null };
const host = document.querySelector<HTMLElement>('#avatar')!;
const statusNode = document.querySelector<HTMLElement>('#status')!;
const detailNode = document.querySelector<HTMLElement>('#detail')!;
const audioButton = document.querySelector<HTMLButtonElement>('#resume-audio')!;
const query = new URLSearchParams(location.search);
const preview = query.get('preview') === '1';
const debug = query.get('debug') === '1';
document.querySelector<HTMLElement>('#diagnostics')!.hidden = !debug;
const rendererId = crypto.randomUUID();
let motion: AvatarMotionController | undefined;
let renderer: Live2DRenderer | undefined;
let audio: AvatarAudioPlayback | undefined;
let activeProfile: ModelProfile | undefined;
let lease: Lease | null = null;
let deadline = 0;
let closed = false;
let currentCommand: AvatarCommand | null = null;
let preparingKey: string | null = null;
let playingKey: string | null = null;
let frame = 0;

function status(state: string, title: string, detail: string) {
  host.dataset.state = state;
  statusNode.textContent = title;
  detailNode.textContent = detail;
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1800), cache: 'no-store' });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string | { code?: string } } | null;
    const code = typeof result?.error === 'string' ? result.error : result?.error?.code;
    throw Error(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : `AVATAR_HTTP_${response.status}`);
  }
  return response.json() as Promise<T>;
}
function identity() { return lease ? { rendererId, leaseId: lease.leaseId } : null; }
async function ack(command: AvatarCommand, outcome: AvatarPlaybackStatus | 'ready', durationSec?: number) {
  const owner = identity();
  if (!owner) return;
  try {
    await request('/api/avatar/ack', { ...owner, speechId: command.speechId, playbackEpoch: command.playbackEpoch,
      status: outcome, ...(durationSec === undefined ? {} : { durationSec }) });
  } catch (error) {
    // A completed/cancelled utterance may already be replaced; its receipt cannot revoke a newer one.
    if (identity()?.leaseId !== owner.leaseId || error instanceof Error && error.message === 'AVATAR_PLAYBACK_EXPIRED') return;
    throw error;
  }
}
function refreshLease(value: Lease, sent: number) {
  if (!value.leaseId || !Number.isFinite(value.leaseMs) || !Number.isFinite(value.serverNow) || !Number.isFinite(value.expiresAt)) throw Error('AVATAR_INVALID_LEASE');
  lease = value;
  deadline = leaseDeadline(value, sent, performance.now());
  audio?.setLeaseDeadline(deadline);
  if (deadline <= performance.now()) throw Error('AVATAR_LEASE_EXPIRED');
}
function release() {
  const owner = identity();
  audio?.stop();
  lease = null;
  currentCommand = null;
  preparingKey = playingKey = null;
  if (owner) void fetch('/api/avatar/release', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(owner), keepalive: true }).catch(() => {});
}
function failed(error: unknown) {
  const message = error instanceof Error ? error.message : 'AVATAR_UNAVAILABLE';
  release();
  if (message === 'AVATAR_ALREADY_CLAIMED') status('standby', '另一个角色页面正在播放', '此页待命。只保留一个正式 OBS 角色源，检查时使用 preview=1。');
  else if (message === 'AVATAR_AUDIO_BLOCKED') { audioButton.hidden = false; status('audio-blocked', '需要启用声音', '在 OBS 的「交互」窗口点击启用声音，或在浏览器中点击按钮。'); }
  else status('disconnected', '角色连接已暂停', '声音和口型已停止，正在重新连接。');
}
function updateCommand(command: AvatarCommand | null) {
  currentCommand = command;
  if (!command) { if (audio?.key !== null) audio?.stop(); preparingKey = playingKey = null; return; }
  const key = commandKey(command);
  if (command.phase === 'stop') {
    const reported = audio?.stop();
    preparingKey = playingKey = null;
    if (!reported) void ack(command, 'cancelled').catch(failed);
    return;
  }
  if (audio?.hasFinished(command)) return;
  if (command.phase === 'prepare' && preparingKey !== key) {
    preparingKey = key;
    const owner = identity();
    void audio!.prepare(command).then(duration => {
      if (currentCommand && commandKey(currentCommand) === key && lease?.leaseId === owner?.leaseId) return ack(command, 'ready', duration);
    }).catch(error => {
      if (currentCommand && commandKey(currentCommand) === key && lease && lease.leaseId === owner?.leaseId) {
        void ack(command, 'failed').catch(() => {});
        failed(error);
      }
    });
  }
  if (command.phase === 'play' && playingKey !== key) {
    playingKey = key;
    const owner = identity();
    void audio!.play(command).catch(error => {
      if (!currentCommand || commandKey(currentCommand) !== key || !lease || lease.leaseId !== owner?.leaseId) return;
      void ack(command, 'failed').catch(() => {}); failed(error);
    });
  }
}
function draw() {
  if (closed) return;
  frame = requestAnimationFrame(draw);
  if (!motion || !renderer || !audio) return;
  const now = audio.context.currentTime;
  audio.sample();
  const snapshot = motion.update(now, performance.now() / 1000);
  renderer.setParameters(snapshot.live2dParams);
  // The profile maps supported semantic expressions; arbitrary model motions are not replayed.
  renderer.applyNativeAnimation(snapshot.nativeAnimation);
  if (debug) {
    const mouth = activeProfile?.parameterMap.mouthOpen, head = activeProfile?.parameterMap.headX;
    host.dataset.audioRms = audio.audioLevelAnalyzer.getLevel().toFixed(4);
    host.dataset.mouthOpen = (snapshot.live2dParams[mouth?.target ?? mouth?.targets?.[0] ?? ''] ?? 0).toFixed(4);
    host.dataset.headX = (snapshot.live2dParams[head?.target ?? head?.targets?.[0] ?? ''] ?? 0).toFixed(4);
    host.dataset.planFrames = String(currentCommand?.parameterPlan.length ?? 0);
    host.dataset.motionState = snapshot.state;
    host.dataset.motionSeed = String(snapshot.seed ?? '');
    host.dataset.motionVariant = snapshot.runtimeExpression?.variant ?? '';
    host.dataset.bodyZ = (snapshot.live2dParams[activeProfile?.parameterMap.bodyZ?.target ?? ''] ?? 0).toFixed(4);
  }
}
async function run(parameters: Record<string, { min: number; max: number; default: number; name?: string }>) {
  while (!closed) {
    try {
      if (!lease) {
        const sent = performance.now();
        refreshLease(await request<Lease>('/api/avatar/claim', { rendererId, parameters }), sent);
        status('ready', '角色已连接', '等待当前项目的口播。');
      }
      const sent = performance.now(), owner = identity();
      const value = await request<Poll>('/api/avatar/poll', owner);
      if (closed || !lease || owner?.leaseId !== lease.leaseId) continue;
      refreshLease(value, sent);
      updateCommand(value.command);
    } catch (error) { if (!closed) failed(error); }
    await new Promise(resolve => setTimeout(resolve, lease ? 500 : 1800));
  }
}
async function boot() {
  const config = await request<Config>('/api/avatar/config');
  if (!config.enabled) { status('disabled', '角色输出尚未启用', '启用 MAJI_AVATAR_ENABLED 后重新打开此页面。'); return; }
  if (!config.modelConfigured || !config.modelUrl || !config.profileUrl || !config.coreUrl) {
    status('missing-model', '尚未配置 Live2D 模型', '需要模型、Soullink Profile 和 Cubism Core。配置后刷新页面。'); return;
  }
  status('loading-model', '正在加载角色', config.characterName);
  const { profile } = await loadModelProfile(config.profileUrl);
  activeProfile = profile;
  renderer = new Live2DRenderer(host, { cubismLoader: createScriptTagCubismLoader(config.coreUrl) });
  const parameters = await renderer.load(config.modelUrl);
  const masks = configureAvatarMasks(renderer);
  if (debug) {
    host.dataset.maskGroups = String(masks.maskGroups);
    host.dataset.highPrecisionMasks = String(masks.highPrecision);
    host.dataset.maskSize = String(masks.maskSize);
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  audioButton.hidden = context.state === 'running';
  audio = new AvatarAudioPlayback({ context,
    fetchAudio: async (url, signal) => {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin || !target.pathname.startsWith('/api/avatar/audio/')) throw Error('AVATAR_INVALID_AUDIO_URL');
      const response = await fetch(target, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store' });
      if (!response.ok) throw Error('AVATAR_AUDIO_UNAVAILABLE');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 8 * 1024 * 1024) throw Error('AVATAR_AUDIO_TOO_LARGE');
      return bytes;
    },
    onStart: (command, when, duration) => {
      motion!.start(command, when, duration, performance.now() / 1000);
      status('speaking', '正在口播', command.text);
    },
    onReset: (time, reason) => {
      const visualTime = performance.now() / 1000;
      motion?.stop(time, visualTime, reason);
      if (motion && renderer) {
        renderer.setParameters(motion.update(time, visualTime).live2dParams);
        renderer.applyNativeAnimation(null);
      }
    },
    onStatus: (command, outcome) => {
      if (outcome !== 'started' && lease) status('ready', '角色已连接', '等待下一句口播。');
      void ack(command, outcome).catch(failed);
    },
  });
  motion = new AvatarMotionController(profile, parameters, audio.audioLevelAnalyzer);
  draw();
  audioButton.addEventListener('click', () => { void context.resume().then(() => { audioButton.hidden = true; }); });
  context.addEventListener('statechange', () => {
    audioButton.hidden = context.state === 'running';
    if (context.state !== 'running' && audio?.playing) audio.stop('failed');
  });
  if (preview) { status('preview', '角色预览', '此页不播放声音，也不占用正式播放端。'); void context.resume(); return; }
  void context.resume().catch(() => {});
  void run(motionParameters(profile, parameters));
}
const watchdog = setInterval(() => {
  if (lease && performance.now() >= deadline) failed(Error('AVATAR_LEASE_EXPIRED'));
}, 100);
window.addEventListener('pagehide', () => {
  closed = true;
  clearInterval(watchdog);
  cancelAnimationFrame(frame);
  release();
  audio?.close();
  renderer?.destroy();
});
void boot().catch(error => {
  console.error('Avatar initialization failed:', error instanceof Error ? error.message : 'unknown');
  status('load-failed', '角色加载失败', '请检查模型、Profile 和 Cubism Core 配置后刷新。');
});
