import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpeechPort } from '../../application/live/speech.ts';
import { requireThat } from '../../domain/game/value.ts';
import { systemAudio, type SystemAudio } from './system-audio.ts';
import { createSoullinkFishVoice, type FishVoiceConfig } from './soullink-fish-voice.ts';

export { fishSpeechConfig } from './soullink-fish-voice.ts';

export function fishSpeech(directory: string, config: FishVoiceConfig, fetcher = fetch, audio: SystemAudio = systemAudio()): SpeechPort {
  return {
    async synthesize(text, voiceId, signal) {
      signal.throwIfAborted();
      requireThat(voiceId === config.voiceId, 'VOICE_UNAVAILABLE');
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let artifact: string | undefined;
      try {
        const result = await createSoullinkFishVoice(config, fetcher, requestSignal).synthesize(text, {});
        requireThat(result.bytes, 'EMPTY_FISH_AUDIO');
        requestSignal.throwIfAborted();
        await mkdir(directory, { mode: 0o700, recursive: true });
        artifact = join(directory, `${randomUUID()}.mp3`);
        await writeFile(artifact, new Uint8Array(result.bytes), { mode: 0o600, flag: 'wx', signal: requestSignal });
        await audio.validate(artifact, requestSignal);
        requestSignal.throwIfAborted();
        return artifact;
      } catch {
        if (artifact) await rm(artifact, { force: true });
        // Provider errors and fetch exceptions can contain credentials or response content.
        throw Error(signal.aborted ? 'SPEECH_CANCELLED' : requestSignal.aborted ? 'FISH_TIMEOUT' : 'FISH_SYNTHESIS_FAILED');
      }
    },
    play: (artifact, signal) => audio.play(artifact, signal),
    release: artifact => rm(artifact, { force: true }),
  };
}
