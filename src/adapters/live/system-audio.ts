import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Audio processes are shared by macOS speech and the Linux/Fish output path. */
export function runAudioProcess(program: string, args: string[], signal: AbortSignal, maxMs: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore' });
    let force: NodeJS.Timeout | undefined, cancelled = false;
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 750);
    };
    const deadline = setTimeout(stop, maxMs);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('error', () => {}); // close follows exit or spawn failure.
    child.once('close', code => {
      clearTimeout(deadline); clearTimeout(force);
      signal.removeEventListener('abort', stop);
      if (code === 0 && !cancelled) resolve();
      else reject(Error('SPEECH_PROCESS_FAILED'));
    });
  });
}

export interface SystemAudio {
  validate(artifact: string, signal: AbortSignal): Promise<void>;
  play(artifact: string, signal: AbortSignal): Promise<void>;
}

export function validAudioProbe(value: unknown): boolean {
  const probe = value as { streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }[];
    format?: { duration?: string } } | null;
  if (!probe || !Array.isArray(probe.streams)) return false;
  const stream = probe.streams[0], duration = Number(probe.format?.duration);
  return !!stream && stream.codec_type === 'audio' && typeof stream.codec_name === 'string' && stream.codec_name !== 'unknown' &&
    Number(stream.sample_rate) > 0 && Number.isSafeInteger(stream.channels) && stream.channels! > 0 &&
    Number.isFinite(duration) && duration > 0;
}

/** Linux uses FFmpeg against the service's PulseAudio sink; no display is needed. */
export function systemAudio(platform = process.platform): SystemAudio {
  return {
    async validate(artifact, signal) {
      if (platform === 'darwin') {
        const { stdout } = await exec('/usr/bin/afinfo', [artifact], { signal, timeout: 3000 });
        if (!/^audio bytes: [1-9]\d*$/m.test(stdout)) throw Error('INVALID_AUDIO_ARTIFACT');
      } else if (platform === 'linux') {
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
          'stream=codec_type,codec_name,sample_rate,channels:format=duration', '-of', 'json', artifact],
        { signal, timeout: 3000, maxBuffer: 64 * 1024 });
        if (!validAudioProbe(JSON.parse(stdout))) throw Error('INVALID_AUDIO_ARTIFACT');
      } else throw Error('AUDIO_PLATFORM_UNSUPPORTED');
    },
    async play(artifact, signal) {
      if (platform === 'darwin') await runAudioProcess('/usr/bin/afplay', [artifact], signal, 60_000);
      else if (platform === 'linux') await runAudioProcess('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', artifact], signal, 60_000);
      else throw Error('AUDIO_PLATFORM_UNSUPPORTED');
    },
  };
}
