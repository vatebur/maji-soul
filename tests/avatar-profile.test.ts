import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProfile } from '@soullink-emotion/engine';
import { motionParameters } from '../src/app/console/avatar-profile.ts';

const profile = (fields: Partial<ModelProfile>): ModelProfile => ({ modelId: 'test-avatar', displayName: 'Test Avatar',
  version: '1.0.0', modelPath: '/model3.json', parameterMap: {}, idleConfig: {}, ...fields });
const actual = {
  ParamAngleX: { min: -30, max: 30, default: 0, name: 'Head X' },
  ParamMouthOpenY: { min: 0, max: 1.5, default: 0 },
  LArm: { min: -1, max: 1, default: 0 },
  Clothes1: { min: 0, max: 1, default: 0 },
};

test('avatar planner only receives calibrated expression and custom gesture channels within narrowed bounds', () => {
  const result = motionParameters(profile({ parameterMap: {
    headX: { target: 'ParamAngleX', min: -20, max: 20 },
    mouthOpen: { target: 'ParamMouthOpenY', min: 0, max: 1 },
  }, customParams: { arm: { target: 'LArm', min: -.25, max: .25 } } }), actual);
  assert.deepEqual(result, {
    ParamAngleX: { min: -20, max: 20, default: 0, name: 'Head X' },
    LArm: { min: -.25, max: .25, default: 0 },
  });
  assert.equal(Object.hasOwn(result, 'Clothes1'), false);
  assert.equal(Object.hasOwn(result, 'ParamMouthOpenY'), false);
});

test('avatar renderer group metadata is excluded from the strict claim parameter contract', () => {
  const result = motionParameters(profile({ parameterMap: { headX: { target: 'ParamAngleX', min: -20, max: 20 } } }),
    { ...actual, ParamAngleX: { ...actual.ParamAngleX, ...{ groupId: 'head-group', groupName: '头部' } } });
  assert.deepEqual(result.ParamAngleX, { min: -20, max: 20, default: 0, name: 'Head X' });
  assert.equal(Object.hasOwn(result.ParamAngleX!, 'groupId'), false);
});

test('avatar planner intersects shared targets and cannot enlarge the model physical range', () => {
  const result = motionParameters(profile({ parameterMap: {
    headX: { target: 'ParamAngleX', min: -50, max: 50 },
    headY: { target: 'ParamAngleX', min: -10, max: 15 },
  } }), actual);
  assert.deepEqual(result.ParamAngleX, { min: -10, max: 15, default: 0, name: 'Head X' });
});

test('avatar planner rejects inconsistent ranges and removes all mouth targets even if custom mapping lists them', () => {
  const result = motionParameters(profile({ parameterMap: {
    headX: { target: 'ParamAngleX', min: -20, max: -10 },
    headY: { target: 'ParamAngleX', min: 10, max: 20 },
    mouthOpen: { targets: ['ParamMouthOpenY'] },
  }, customParams: { mouth: { target: 'ParamMouthOpenY' }, missing: { target: 'does-not-exist' } } }), actual);
  assert.deepEqual(result, {});
});

test('cloud poses cannot take over eye blinks or breathing through shared custom channels', () => {
  const result = motionParameters(profile({ parameterMap: {
    headX: { target: 'ParamAngleX', min: -20, max: 20 },
    eyeOpen: { targets: ['eyeL', 'eyeR'] }, eyeBlinkL: { target: 'eyeL' },
    breath: { target: 'breath' },
  }, customParams: { eyes: { target: 'eyeL' }, breathing: { target: 'breath' } } }),
  { ...actual, eyeL: { min: 0, max: 1, default: 1 }, eyeR: { min: 0, max: 1, default: 1 }, breath: { min: 0, max: 1, default: 0 } });
  assert.deepEqual(Object.keys(result), ['ParamAngleX']);
});
