import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpeechPort } from '../../application/live/speech.ts';
import { requireThat } from '../../domain/game/value.ts';
import { runAudioProcess } from './macos-speech.ts';

const exec = promisify(execFile);
const maxAudioBytes = 8 * 1024 * 1024;
export function fishSpeechConfig(env: NodeJS.ProcessEnv) {
  const apiKey = env.FISH_API_KEY?.trim() ?? '', voiceId = env.FISH_REFERENCE_ID?.trim() ?? '';
  const model = env.FISH_TTS_MODEL ?? env.FISH_MODEL ?? 's2.1-pro-free';
  requireThat(apiKey.length > 0 && !/[\r\n]/.test(apiKey), 'FISH_API_KEY_NOT_CONFIGURED');
  requireThat(/^[a-f\d]{32}$/i.test(voiceId), 'FISH_VOICE_NOT_CONFIGURED');
  requireThat(['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3'].includes(model), 'INVALID_FISH_MODEL');
  return { apiKey, voiceId, model };
}

export function fishSpeech(directory: string, config: ReturnType<typeof fishSpeechConfig>, fetcher = fetch): SpeechPort {
  return {
    async synthesize(text, voiceId, signal) {
      signal.throwIfAborted();
      requireThat(voiceId === config.voiceId, 'VOICE_UNAVAILABLE');
      // Bracket cues are model instructions. Keep ordinary narration free of emotion/style directives.
      const plainText = text.replace(/\[[^\]]*\]/g, '').trim();
      requireThat(plainText.length > 0 && plainText.length <= 4096, 'INVALID_SPEECH_TEXT');
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let body: ReadableStream<Uint8Array> | null = null;
      let artifact: string | undefined;
      try {
        const response = await fetcher('https://api.fish.audio/v1/tts', {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', model: config.model },
          body: JSON.stringify({ text: plainText, reference_id: voiceId, format: 'mp3', sample_rate: 44100, mp3_bitrate: 128,
            prosody: { speed: 1, volume: 0, normalize_loudness: true }, temperature: 0.7, top_p: 0.7, latency: 'normal' }),
        });
        body = response.body;
        requireThat(response.ok, `FISH_HTTP_${response.status}`);
        requireThat(/^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') ?? ''), 'INVALID_FISH_AUDIO');
        requireThat(Number(response.headers.get('content-length') ?? 0) <= maxAudioBytes, 'FISH_AUDIO_TOO_LARGE');
        requireThat(response.body, 'EMPTY_FISH_AUDIO');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          requestSignal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          requireThat(bytes <= maxAudioBytes, 'FISH_AUDIO_TOO_LARGE');
          chunks.push(chunk.value);
        }
        requireThat(bytes > 0, 'EMPTY_FISH_AUDIO');
        requestSignal.throwIfAborted();
        await mkdir(directory, { mode: 0o700, recursive: true });
        artifact = join(directory, `${randomUUID()}.mp3`);
        await writeFile(artifact, Buffer.concat(chunks), { mode: 0o600, flag: 'wx', signal: requestSignal });
        const { stdout } = await exec('/usr/bin/afinfo', [artifact], { signal: requestSignal, timeout: 3000 });
        requireThat(/^audio bytes: [1-9]\d*$/m.test(stdout), 'INVALID_FISH_AUDIO');
        requestSignal.throwIfAborted();
        return artifact;
      } catch {
        if (artifact) await rm(artifact, { force: true });
        // Provider errors and fetch exceptions can contain credentials or response content.
        throw Error(signal.aborted ? 'SPEECH_CANCELLED' : requestSignal.aborted ? 'FISH_TIMEOUT' : 'FISH_SYNTHESIS_FAILED');
      } finally {
        if (reader) await reader.cancel().catch(() => {});
        else await body?.cancel().catch(() => {});
      }
    },
    play: (artifact, signal) => runAudioProcess('/usr/bin/afplay', [artifact], signal, 60_000),
    release: artifact => rm(artifact, { force: true }),
  };
}
