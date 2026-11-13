import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runAudioProcess, systemAudio, validAudioProbe } from '../src/adapters/live/system-audio.ts';

test('audio validation requires a real audio stream with a finite positive duration', () => {
  const good = { streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }], format: { duration: '1.25' } };
  assert.equal(validAudioProbe(good), true);
  for (const value of [null, {}, { ...good, streams: [] }, { ...good, format: {} },
    { ...good, format: { duration: 'Infinity' } }, { ...good, format: { duration: '0' } },
    { ...good, streams: [{ ...good.streams[0], codec_type: 'video' }] },
    { ...good, streams: [{ ...good.streams[0], sample_rate: '0' }] },
    { ...good, streams: [{ ...good.streams[0], channels: 0 }] }]) assert.equal(validAudioProbe(value), false);
});

test('system audio validates the saved speech fixture on macOS and Debian',
  { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
    const audio = systemAudio(), signal = new AbortController().signal;
    await audio.validate(fileURLToPath(new URL('./fixtures/fish-speech.mp3', import.meta.url)), signal);
    await assert.rejects(audio.validate(fileURLToPath(import.meta.url), signal));
  });

test('audio process cancellation kills playback and does not report success', async () => {
  const controller = new AbortController();
  const playing = runAudioProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], controller.signal, 60_000);
  controller.abort();
  await assert.rejects(playing, /SPEECH_PROCESS_FAILED/);
});

test('audio process deadlines stop a hanging player', async () => {
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    new AbortController().signal, 30), /SPEECH_PROCESS_FAILED/);
});

test('unsupported audio platforms fail explicitly', async () => {
  await assert.rejects(systemAudio('win32').play('/tmp/audio.mp3', new AbortController().signal), /AUDIO_PLATFORM_UNSUPPORTED/);
});
