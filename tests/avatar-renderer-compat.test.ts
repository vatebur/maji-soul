import assert from 'node:assert/strict';
import test from 'node:test';
import { configureAvatarMasks } from '../src/app/console/avatar-renderer-compat.ts';

function adapter(masks: number[][], textures = 1) {
  const calls: unknown[] = [];
  let high = false, size = 256;
  return { calls, model: { internalModel: {
    coreModel: { getDrawableCount: () => masks.length, getDrawableMasks: () => masks, getDrawableMaskCounts: () => masks.map(ids => ids.length) },
    renderer: {
      getRenderTextureCount: () => textures,
      useHighPrecisionMask: (value: boolean) => { calls.push(['precision', value]); high = value; },
      isUsingHighPrecisionMask: () => high,
      setClippingMaskBufferSize: (value: number) => { calls.push(['size', value]); size = value; },
      getClippingMaskBufferSize: () => size,
    },
  } } };
}
test('models exceeding Cubism single-atlas capacity use independent high precision masks', () => {
  const model = adapter(Array.from({ length: 49 }, (_, i) => [i]));
  assert.deepEqual(configureAvatarMasks(model), { maskGroups: 49, highPrecision: true, maskSize: 512 });
  assert.deepEqual(model.calls, [['precision', true], ['size', 512]]);
});
test('shared masks are deduplicated without upgrading models that fit their atlas', () => {
  const model = adapter([[1, 2], [2, 1], [], ...Array.from({ length: 35 }, (_, i) => [i + 3])]);
  assert.deepEqual(configureAvatarMasks(model), { maskGroups: 36, highPrecision: false, maskSize: 256 });
  assert.deepEqual(model.calls, []);
});
test('existing multiple mask textures retain the efficient atlas path', () => {
  const model = adapter(Array.from({ length: 49 }, (_, i) => [i]), 2);
  assert.equal(configureAvatarMasks(model).highPrecision, false);
  assert.deepEqual(model.calls, []);
});
test('incompatible renderer versions fail explicitly instead of showing broken masks', () => {
  assert.throws(() => configureAvatarMasks({}), /AVATAR_MASK_CONFIGURATION_UNSUPPORTED/);
});
