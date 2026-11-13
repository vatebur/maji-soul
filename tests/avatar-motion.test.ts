import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProfile } from '@soullink-emotion/engine';
import { AvatarMotionController } from '../src/app/console/avatar-motion.ts';
import type { AvatarCommand, AvatarResetReason } from '../src/app/console/avatar-playback.ts';

const actual = {
  HeadX: { min: -8, max: 8, default: 0 }, HeadY: { min: -20, max: 20, default: 0 },
  HeadZ: { min: -15, max: 15, default: 0 }, BodyX: { min: -10, max: 10, default: 0 },
  BodyZ: { min: -10, max: 10, default: 0 }, GazeX: { min: -1, max: 1, default: 0 },
  EyeL: { min: 0, max: 1, default: 1 }, EyeR: { min: 0, max: 1, default: 1 },
  Mouth: { min: 0, max: 1, default: 0 }, Breath: { min: 0, max: 1, default: 0 },
};
const profile: ModelProfile = {
  modelId: 'motion-test', displayName: 'Motion Test', version: '1.0.0', schemaVersion: 2,
  modelPath: '/test.model3.json',
  parameterMap: {
    headX: { target: 'HeadX', min: -12, max: 12, scale: 12 },
    headY: { target: 'HeadY', min: -10, max: 10, scale: 10 },
    headZ: { target: 'HeadZ', min: -10, max: 10, scale: 10 },
    bodyX: { target: 'BodyX', min: -6, max: 6, scale: 6 },
    bodyZ: { target: 'BodyZ', min: -6, max: 6, scale: 6 },
    gazeX: { target: 'GazeX', min: -.8, max: .8, scale: .8 },
    eyeOpen: { targets: ['EyeL', 'EyeR'], min: 0, max: 1 },
    eyeBlinkL: { target: 'EyeL', min: 0, max: 1, mode: 'subtract' },
    eyeBlinkR: { target: 'EyeR', min: 0, max: 1, mode: 'subtract' },
    mouthOpen: { target: 'Mouth', min: 0, max: 1, scale: 8 },
    breath: { target: 'Breath', min: 0, max: 1 },
  },
  neutralParams: Object.fromEntries(Object.entries(actual).map(([id, meta]) => [id, meta.default])),
  idleConfig: { headX: [-.2, .2], headY: [-.1, .1], headZ: [-.15, .15], bodyX: [-.12, .12] },
  nativeAnimations: { expressions: [{ name: 'smile', file: 'smile.exp3.json', params: ['EyeL'] }] },
  expressionMap: { happy: 'smile' },
};
const command = (parameterPlan: AvatarCommand['parameterPlan'] = []): AvatarCommand => ({
  speechId: 'test-speech', playbackEpoch: 1, phase: 'play', audioUrl: '/api/avatar/audio/test',
  text: '这手可以继续观察。', moods: ['开心'], parameterPlan,
});
function controller(t: TestContext, seed = 101) {
  t.mock.method(console, 'info', () => {});
  return new AvatarMotionController(profile, actual, {
    getLevel: () => .2, getPeak: () => .3, isAvailable: () => true, reset() {},
  }, seed);
}

test('avatar motion keeps varying the reaction seed after natural endings and cancellations', t => {
  for (const reason of ['ended', 'cancelled'] as const) {
    const motion = controller(t), seeds = new Set<number | null>();
    for (let index = 0; index < 5; index++) {
      const time = index * 4;
      motion.start(command(), time, 2, time);
      const snapshot = motion.update(time, time);
      assert.equal(snapshot.state, 'SPEAKING');
      assert.ok(snapshot.seed);
      seeds.add(snapshot.seed);
      motion.stop(time + 2, time + 2, reason);
      assert.equal(motion.update(time + 2, time + 2).state, 'IDLE');
    }
    assert.equal(seeds.size, 5, `${reason} must not replay the same reaction seed`);
  }
});

test('avatar idle animation advances while the audio context stays suspended', t => {
  const motion = controller(t), heads: number[] = [], breaths: number[] = [];
  for (let frame = 0; frame <= 600; frame++) {
    const snapshot = motion.update(0, frame / 60);
    assert.equal(snapshot.state, 'IDLE');
    assert.equal(snapshot.live2dParams.Mouth, 0);
    heads.push(snapshot.live2dParams.HeadX!);
    breaths.push(snapshot.live2dParams.Breath!);
  }
  assert.ok(Math.max(...heads) - Math.min(...heads) > .2, 'idle head movement must be visible');
  assert.ok(Math.max(...breaths) - Math.min(...breaths) > .2, 'breathing must not wait for audio unlock');
});

test('avatar speech freezes on the audio clock even when the visual clock passes the clip duration', t => {
  const motion = controller(t);
  motion.update(4, 100);
  motion.start(command([{ time: 0, duration: 2, parameters: { HeadX: 6 } }]), 4, 2, 100);
  let before = motion.update(4, 100);
  for (let frame = 1; frame <= 30; frame++) before = motion.update(4 + frame / 60, 100 + frame / 60);
  for (let frame = 1; frame <= 20; frame++) {
    const frozen = motion.update(4.5, 110 + frame);
    assert.equal(frozen.state, 'SPEAKING');
    assert.deepEqual(frozen.live2dParams, before.live2dParams);
  }
  assert.notDeepEqual(motion.update(4.6, 131).live2dParams, before.live2dParams);
});

test('avatar clock switches preserve the same motion with unrelated audio and visual clock origins', t => {
  const first = controller(t), shifted = controller(t);
  for (let frame = 0; frame <= 120; frame++) {
    const elapsed = frame / 60;
    const a = first.update(0, elapsed), b = shifted.update(50, 10_000 + elapsed);
    for (const [id, value] of Object.entries(a.live2dParams)) {
      assert.ok(Math.abs(value - b.live2dParams[id]!) < 1e-8, `${id} must ignore absolute clock origin`);
    }
  }
  first.start(command(), 0, 3, 2);
  shifted.start(command(), 50, 3, 10_002);
  // The audio completion callback owns the boundary, before the next rendered frame.
  for (let frame = 1; frame < 180; frame++) {
    const elapsed = frame / 60;
    const a = first.update(elapsed, 2 + elapsed);
    const b = shifted.update(50 + elapsed, 10_002 + elapsed * 10);
    for (const [id, value] of Object.entries(a.live2dParams)) {
      assert.ok(Math.abs(value - b.live2dParams[id]!) < 1e-8,
        `${id} must follow elapsed audio time at frame ${frame}: ${value} / ${b.live2dParams[id]}`);
    }
    assert.equal(a.state, b.state);
  }
  first.stop(3, 5, 'ended');
  shifted.stop(53, 10_032, 'ended');
  for (let frame = 1; frame <= 120; frame++) {
    const elapsed = frame / 60;
    const a = first.update(3, 5 + elapsed), b = shifted.update(53, 10_032 + elapsed);
    for (const [id, value] of Object.entries(a.live2dParams)) {
      assert.ok(Math.abs(value - b.live2dParams[id]!) < 1e-8, `${id} must resume the continuous idle clock`);
    }
    assert.equal(a.state, 'IDLE');
    assert.equal(b.state, 'IDLE');
  }
});

test('avatar all stop outcomes immediately close the mouth and release native expressions', t => {
  for (const reason of ['ended', 'cancelled', 'failed'] satisfies AvatarResetReason[]) {
    const motion = controller(t);
    motion.start(command(), 0, 2, 0);
    let snapshot = motion.update(0, 0);
    for (let frame = 1; frame <= 30; frame++) snapshot = motion.update(frame / 60, frame / 60);
    assert.ok(snapshot.live2dParams.Mouth! > .01, 'synthetic audio must produce an open mouth before stop');
    assert.equal(snapshot.nativeAnimation?.expression, 'smile');
    const time = reason === 'ended' ? 2 : .5;
    motion.stop(time, time, reason);
    snapshot = motion.update(time, time);
    assert.equal(snapshot.live2dParams.Mouth, 0, `${reason} cannot wait for parameter smoothing`);
    assert.equal(snapshot.nativeAnimation, null);
    assert.equal(snapshot.state, 'IDLE');
    assert.equal(motion.update(time, time + .1).live2dParams.Mouth, 0);
  }
});

test('avatar cloud poses cannot override blink, breath or audio mouth channels', t => {
  const baseline = controller(t), attemptedOverride = controller(t);
  baseline.start(command(), 0, 12, 0);
  attemptedOverride.start(command([{ time: 0, duration: .1,
    parameters: { EyeL: 0, EyeR: 0, Breath: 1, Mouth: 1 } }]), 0, 12, 0);
  let eyeMin = Infinity, eyeMax = -Infinity, breathMin = Infinity, breathMax = -Infinity;
  for (let frame = 0; frame <= 660; frame++) {
    const time = frame / 60;
    const a = baseline.update(time, time), b = attemptedOverride.update(time, time);
    for (const id of ['EyeL', 'EyeR', 'Breath', 'Mouth']) assert.equal(b.live2dParams[id], a.live2dParams[id]);
    eyeMin = Math.min(eyeMin, b.live2dParams.EyeL!); eyeMax = Math.max(eyeMax, b.live2dParams.EyeL!);
    breathMin = Math.min(breathMin, b.live2dParams.Breath!); breathMax = Math.max(breathMax, b.live2dParams.Breath!);
  }
  assert.ok(eyeMax - eyeMin > .2, 'speech must retain autonomous blinks');
  assert.ok(breathMax - breathMin > .2, 'speech must retain continuous breathing');
});

test('avatar adds motion to a held cloud pose and clamps it to both model and profile limits', t => {
  const motion = controller(t), held: number[] = [];
  motion.start(command([{ time: 0, duration: .1, parameters: { HeadX: 4, HeadY: 40 } }]), 0, 8, 0);
  for (let frame = 0; frame <= 420; frame++) {
    const time = frame / 60, snapshot = motion.update(time, time), params = snapshot.live2dParams;
    assert.ok(params.HeadX! >= -8 && params.HeadX! <= 8, 'actual model range narrows the profile');
    assert.ok(params.HeadY! >= -10 && params.HeadY! <= 10, 'profile range narrows the actual model');
    if (time >= 2) held.push(params.HeadX!);
  }
  assert.ok(Math.max(...held) - Math.min(...held) > .5, 'a settled cloud pose must keep subtle motion');
  assert.ok(held.every(value => Math.abs(value - 4) < 1), 'micro motion must preserve the cloud pose intent');
});
