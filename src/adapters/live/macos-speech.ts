import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpeechPort } from '../../application/live/speech.ts';

const exec = promisify(execFile);
export async function installedChineseVoices() {
  if (process.platform !== 'darwin') return [];
  const { stdout } = await exec('/usr/bin/say', ['-v', '?'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  const voices = new Map<string, { id: string; label: string; language: string; installed: boolean }>();
  for (const line of stdout.split('\n')) {
    const entry = /^(.*?)\s+(zh_[A-Z]+|yue_[A-Z]+)\s+#/.exec(line);
    if (!entry) continue;
    const label = entry[1]!.trim();
    // Newer macOS versions localize labels; say accepts the name before the language annotation.
    const id = label.replace(/ \(.*\)$/, '');
    if (!voices.has(id)) voices.set(id, { id, label, language: entry[2]!, installed: true });
  }
  return [...voices.values()];
}

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
    child.on('error', () => {}); // close follows exit or spawn failure.
    child.once('close', code => {
      clearTimeout(deadline); clearTimeout(force);
      signal.removeEventListener('abort', stop);
      if (code === 0 && !cancelled) resolve();
      else reject(Error('SPEECH_PROCESS_FAILED'));
    });
  });
}

export function macSpeech(directory: string, voices: ReadonlySet<string>): SpeechPort {
  return {
    async synthesize(text, voiceId, signal) {
      if (!voices.has(voiceId)) throw Error('VOICE_UNAVAILABLE');
      await mkdir(directory, { mode: 0o700, recursive: true });
      const path = join(directory, `${randomUUID()}.aiff`), input = path + '.txt';
      try {
        await writeFile(input, text.replaceAll('[[', '［［') + '\n', { mode: 0o600, flag: 'wx' });
        await runAudioProcess('/usr/bin/say', ['-v', voiceId, '-o', path, '-f', input], signal, 20_000);
        await chmod(path, 0o600);
        const { stdout } = await exec('/usr/bin/afinfo', [path], { signal, timeout: 3000 });
        if (!/^audio bytes: [1-9]\d*$/m.test(stdout)) throw Error('EMPTY_AUDIO_ARTIFACT');
        return path;
      } catch (error) { await rm(path, { force: true }); throw error; }
      finally { await rm(input, { force: true }); }
    },
    play: (artifact, signal) => runAudioProcess('/usr/bin/afplay', [artifact], signal, 60_000),
    release: artifact => rm(artifact, { force: true }),
  };
}
