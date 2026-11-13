import type { TtsClient } from '@soullink-emotion/runtime-core';
import { requireThat } from '../../domain/game/value.ts';
import { SPOKEN_MOODS } from '../../application/live/spoken-text.ts';

const maxAudioBytes = 8 * 1024 * 1024;

export interface FishVoiceConfig { apiKey: string; voiceId: string; model: string }

export function fishSpeechConfig(env: NodeJS.ProcessEnv): FishVoiceConfig {
  const apiKey = env.FISH_API_KEY?.trim() ?? '', voiceId = env.FISH_REFERENCE_ID?.trim() ?? '';
  const model = env.FISH_TTS_MODEL ?? env.FISH_MODEL ?? 's2.1-pro-free';
  requireThat(apiKey.length > 0 && !/[\r\n]/.test(apiKey), 'FISH_API_KEY_NOT_CONFIGURED');
  requireThat(/^[a-f\d]{32}$/i.test(voiceId), 'FISH_VOICE_NOT_CONFIGURED');
  requireThat(['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3'].includes(model), 'INVALID_FISH_MODEL');
  return { apiKey, voiceId, model };
}

/** Fish cloud provider for Soullink's TtsClient (called VoiceModelClient in newer upstream source). */
export function createSoullinkFishVoice(
  config: FishVoiceConfig,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = new AbortController().signal,
): TtsClient {
  return {
    async synthesize(text, _context) {
      signal.throwIfAborted();
      // Fish S2/Drama accept inline cues; retain only the narrator's known mood labels.
      const speechText = text.replace(/\[([^\]]*)\]/g, (cue, mood: string) =>
        SPOKEN_MOODS.some(known => known === mood) ? cue : '').trim();
      requireThat(speechText.replace(/\[[^\]]*\]/g, '').trim().length > 0 && speechText.length <= 4096, 'INVALID_SPEECH_TEXT');
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let body: ReadableStream<Uint8Array> | null = null;
      try {
        const response = await fetcher('https://api.fish.audio/v1/tts', {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', model: config.model },
          body: JSON.stringify({ text: speechText, reference_id: config.voiceId, format: 'mp3', sample_rate: 44100, mp3_bitrate: 128,
            prosody: { speed: 1, volume: 0, normalize_loudness: true }, temperature: 0.7, top_p: 0.7, latency: 'normal' }),
        });
        body = response.body;
        requireThat(response.ok, `FISH_HTTP_${response.status}`);
        requireThat(/^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') ?? ''), 'INVALID_FISH_AUDIO');
        requireThat(Number(response.headers.get('content-length') ?? 0) <= maxAudioBytes, 'FISH_AUDIO_TOO_LARGE');
        requireThat(body, 'EMPTY_FISH_AUDIO');
        reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          requestSignal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          requireThat(length <= maxAudioBytes, 'FISH_AUDIO_TOO_LARGE');
          chunks.push(chunk.value);
        }
        requireThat(length > 0, 'EMPTY_FISH_AUDIO');
        requestSignal.throwIfAborted();
        const audio = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
        return { bytes: audio.buffer };
      } catch {
        // Provider errors and fetch exceptions can contain credentials or response content.
        throw Error(signal.aborted ? 'SPEECH_CANCELLED' : requestSignal.aborted ? 'FISH_TIMEOUT' : 'FISH_SYNTHESIS_FAILED');
      } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else await body?.cancel().catch(() => {});
      }
    },
  };
}
