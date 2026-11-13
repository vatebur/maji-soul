import { SoullinkRuntime, motionStylePresets, type AudioLevelAnalyzer, type ModelProfile,
  type RuntimeSnapshot } from '@soullink-emotion/engine';
import type { AvatarCommand, AvatarResetReason } from './avatar-playback.ts';
import { motionParameters, autonomousParameterIds } from './avatar-profile.ts';

type Parameters = Record<string, { min: number; max: number; default: number; name?: string }>;
const moodEmotion: Record<string, string> = { 开心: 'happy', 得意: 'happy', 惊讶: 'surprised', 犹豫: 'confused',
  纠结: 'confused', 难受: 'sad', 紧张: 'anxiety', 放松: 'calm', 无奈: 'concerned', 好奇: 'curious', 期待: 'excited', 平静: 'calm' };

/** Keep idle history between utterances, while speech stays on the actual audio clock. */
export class AvatarMotionController {
  #runtime: SoullinkRuntime;
  #profile: ModelProfile;
  #parameters: Parameters;
  #motionParameters: Parameters;
  #analyser: AudioLevelAnalyzer;
  #time = 0;
  #lastRender = 0;
  #audioTime = 0;
  #visualTime: number | undefined;
  #sequence = 0;
  #seed: number;
  #speech: { start: number; duration: number; phase: number } | null = null;

  constructor(profile: ModelProfile, parameters: Parameters, analyser: AudioLevelAnalyzer, seed?: number) {
    this.#profile = profile;
    this.#parameters = parameters;
    this.#motionParameters = motionParameters(profile, parameters);
    this.#analyser = analyser;
    this.#runtime = new SoullinkRuntime({ profile, audioLevelAnalyzer: analyser,
      motionStyle: { ...motionStylePresets.lively, idleActionGain: 1.3, speechAccentGain: 1.2,
        ...(seed === undefined ? {} : { seed }) } });
    this.#runtime.setProactiveRepeatEnabled(false);
    this.#seed = this.#runtime.getMotionStyle().seed;
  }

  #advance(audioTime: number, visualTime: number) {
    if (this.#visualTime !== undefined) {
      // AudioContext can remain suspended until the first click. Idle still needs a clock.
      this.#time += Math.max(0, this.#speech ? audioTime - this.#audioTime : visualTime - this.#visualTime);
    }
    this.#audioTime = audioTime;
    this.#visualTime = visualTime;
    return this.#time;
  }

  #nextSeed() {
    return (this.#seed + Math.imul(++this.#sequence, 0x9e3779b1)) >>> 0 || 1;
  }

  start(command: AvatarCommand, audioTime: number, duration: number, visualTime: number) {
    const time = this.#advance(audioTime, visualTime), seed = this.#nextSeed();
    this.#speech = { start: time, duration, phase: (seed % 6283) / 1000 };
    this.#runtime.triggerIntent({ emotion: moodEmotion[command.moods[0] ?? '平静'] ?? 'calm', intensity: .6,
      contextTags: ['narration'], sourceMessage: command.text }, time, { seed });
    const autonomous = autonomousParameterIds(this.#profile);
    const plan = command.parameterPlan.map(beat => ({ ...beat,
      parameters: Object.fromEntries(Object.entries(beat.parameters).filter(([id]) => !autonomous.has(id))) }));
    this.#runtime.startSpeechMotion(plan, time, duration);
    this.#runtime.setVoicePlaybackActive(true);
  }

  stop(audioTime: number, visualTime: number, reason: AvatarResetReason) {
    if (!this.#speech) return;
    this.#advance(audioTime, visualTime);
    // A natural end can be a fraction of a sample early; let the SDK enter IDLE now.
    if (reason === 'ended') this.#time = Math.max(this.#time, this.#speech.start + Math.max(.4, this.#speech.duration));
    this.#speech = null;
    this.#runtime.setVoicePlaybackActive(false);
    this.#runtime.clearSpeechMotion();
    this.#runtime.applyVADTarget({ valence: 0, arousal: 0, dominance: 0 }, 1);
    if (reason !== 'ended') {
      this.#runtime.reset(this.#time);
      this.#runtime.setMotionStyle({ seed: this.#nextSeed() });
    }
    // Natural completion preserves random sequence, idle action history and smooth recovery.
    this.#runtime.update(this.#time, 0);
  }

  update(audioTime: number, visualTime: number): RuntimeSnapshot {
    const time = this.#advance(audioTime, visualTime);
    const snapshot = this.#runtime.update(time, Math.min(.1, Math.max(0, time - this.#lastRender)));
    this.#lastRender = time;
    const params = { ...snapshot.live2dParams };
    if (this.#speech) this.#speechDetail(params, time);
    else {
      // SDK parameter smoothing must never keep the mouth open after stop/expiry.
      const mouth = this.#profile.parameterMap.mouthOpen;
      for (const id of [...(mouth?.target ? [mouth.target] : []), ...(mouth?.targets ?? [])]) {
        params[id] = this.#profile.neutralParams?.[id] ?? this.#parameters[id]?.default ?? 0;
      }
    }
    return { ...snapshot, live2dParams: params, nativeAnimation: this.#speech ? snapshot.nativeAnimation : null };
  }

  #speechDetail(params: Record<string, number>, time: number) {
    const speech = this.#speech!;
    const elapsed = Math.max(0, time - speech.start);
    const envelope = Math.min(1, elapsed / .35, Math.max(0, speech.duration - elapsed) / .4);
    const phase = speech.phase;
    // Small independent rhythms keep sparse cloud poses alive without replacing their intent.
    const level = Math.min(1, Math.max(0, this.#analyser.getLevel()) * 4);
    const detail = {
      headX: .045 * Math.sin(elapsed * 1.7 + phase),
      headY: .025 * Math.sin(elapsed * 2.3 + phase * .7) - .035 * level,
      headZ: .04 * Math.sin(elapsed * 1.3 + phase * 1.4),
      bodyX: .025 * Math.sin(elapsed * 1.1 + phase + .5),
      bodyZ: .025 * Math.sin(elapsed * .9 + phase * 1.4 + .8),
      gazeX: .025 * Math.sin(elapsed * 1.9 + phase),
    };
    for (const [key, amount] of Object.entries(detail)) {
      const rule = this.#profile.parameterMap[key as keyof typeof detail];
      for (const id of [...(rule?.target ? [rule.target] : []), ...(rule?.targets ?? [])]) {
        const meta = this.#motionParameters[id];
        if (!meta) continue;
        const value = (params[id] ?? meta.default) + (meta.max - meta.min) * amount * envelope;
        params[id] = Math.min(meta.max, Math.max(meta.min, value));
      }
    }
  }
}
