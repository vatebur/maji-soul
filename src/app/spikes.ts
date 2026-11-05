import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { modelConfig } from '../schemas/config.ts';
import { probeCompletion } from '../adapters/llm/chat-completions.ts';
import { storageSpike } from '../adapters/storage/spike.ts';
import type { Evidence } from '../observability/evidence.ts';

const exec = promisify(execFile);
export async function spike(name: string, play: boolean): Promise<Evidence> {
  const base = { schemaVersion: 1 as const, probe: name, observedAt: new Date().toISOString() };
  if (name === 'storage') return { ...base, evidenceType: 'local-integration', status: 'passed',
    details: storageSpike('data/validation/storage-spike.sqlite') };
  if (name === 'model') {
    const config = modelConfig(process.env);
    const run = async () => {
      const start = performance.now();
      try { await probeCompletion(config); return { ok: true, durationMs: Math.round(performance.now() - start) }; }
      catch (err) { const code = err instanceof Error ? err.message : ''; return { ok: false,
        durationMs: Math.round(performance.now() - start), error: /^(MODEL_HTTP_\d+|INVALID_MODEL_\w+|MODEL_RESPONSE_TOO_LARGE)$/.test(code) ? code : 'MODEL_REQUEST_FAILED' }; }
    };
    const sequential = await run();
    const concurrent = await Promise.all([run(), run()]);
    const cancellation = new AbortController(); cancellation.abort();
    let abortVerified = false;
    try { await probeCompletion(config, cancellation.signal); } catch { abortVerified = true; }
    const success = sequential.ok && concurrent.every(r => r.ok) && abortVerified;
    return { ...base, evidenceType: 'service-integration', status: success ? 'passed' : 'blocked', details: {
      model: config.model, responseFormat: config.responseFormat, timeoutMs: config.timeoutMs,
      sequential, concurrent, abortVerified, remoteCapacityReleasedOnCancel: 'unknown',
      scope: 'one sequential and one simultaneous pair; not a capacity guarantee' } };
  }
  if (name === 'speech') {
    if (process.platform !== 'darwin') throw new Error('MACOS_REQUIRED');
    await mkdir('data/audio', { recursive: true });
    const stem = `data/audio/spike-${randomUUID()}`;
    const voice = process.env.MAJI_TTS_VOICE ?? 'Tingting';
    const voices = (await exec('/usr/bin/say', ['-v', '?'])).stdout;
    if (!voices.split('\n').some(line => line.startsWith(voice) && line.includes('zh_CN'))) throw new Error('CHINESE_VOICE_NOT_INSTALLED');
    const start = performance.now();
    await exec('/usr/bin/say', ['-v', voice, '-o', `${stem}.aiff`, '雀魂技术验证，语音播放结束。'], { timeout: 30000 });
    await exec('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', `${stem}.aiff`, `${stem}.wav`], { timeout: 10000 });
    const bytes = await readFile(`${stem}.wav`);
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('INVALID_WAVE');
    const synthesisMs = Math.round(performance.now() - start);
    const format = (await exec('/usr/bin/afinfo', [`${stem}.wav`])).stdout;
    let cancellationVerified = false;
    if (play) {
      await exec('/usr/bin/afplay', [`${stem}.wav`], { timeout: 30000 });
      const playback = spawn('/usr/bin/afplay', [`${stem}.wav`], { stdio: 'ignore' });
      const closed = once(playback, 'close');
      await once(playback, 'spawn');
      playback.kill('SIGTERM');
      const [, signal] = await closed;
      cancellationVerified = signal === 'SIGTERM';
      if (!cancellationVerified) throw new Error('PLAYBACK_CANCEL_NOT_CONFIRMED');
    }
    return { ...base, evidenceType: 'local-integration', status: play ? 'passed' : 'partial', details: {
      voice, synthesisMs, format, sha256: createHash('sha256').update(bytes).digest('hex'), artifact: `${stem}.wav`,
      playback: play ? 'afplay-exited-zero' : 'not-requested', cancellationVerified, obsCaptured: false,
      limitation: 'playback process completion does not prove physical output or OBS recording' } };
  }
  throw new Error('UNKNOWN_SPIKE');
}
