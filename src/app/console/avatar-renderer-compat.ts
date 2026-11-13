/**
 * Compatibility boundary for the pinned Soullink 0.1.0-beta.1 PIXI adapter.
 * It does not expose mask configuration itself, so unwrap its loaded model once
 * and use Cubism's own supported mask APIs. Never patch dependency code.
 */
interface CubismModelMasks {
  getDrawableCount(): number;
  getDrawableMasks(): ArrayLike<ArrayLike<number>>;
  getDrawableMaskCounts(): ArrayLike<number>;
}
interface CubismMaskRenderer {
  getRenderTextureCount(): number;
  useHighPrecisionMask(enabled: boolean): void;
  isUsingHighPrecisionMask(): boolean;
  setClippingMaskBufferSize(size: number): void;
  getClippingMaskBufferSize(): number;
}
export function configureAvatarMasks(adapter: unknown) {
  const model = (adapter as { model?: { internalModel?: { coreModel?: CubismModelMasks; renderer?: CubismMaskRenderer } } } | null)?.model?.internalModel;
  const core = model?.coreModel, renderer = model?.renderer;
  if (!core || !renderer || typeof core.getDrawableCount !== 'function' || typeof core.getDrawableMasks !== 'function' ||
      typeof core.getDrawableMaskCounts !== 'function' || typeof renderer.getRenderTextureCount !== 'function' ||
      typeof renderer.useHighPrecisionMask !== 'function' || typeof renderer.isUsingHighPrecisionMask !== 'function' ||
      typeof renderer.setClippingMaskBufferSize !== 'function' || typeof renderer.getClippingMaskBufferSize !== 'function') {
    throw Error('AVATAR_MASK_CONFIGURATION_UNSUPPORTED');
  }
  const masks = core.getDrawableMasks(), counts = core.getDrawableMaskCounts(), groups = new Set<string>();
  for (let i = 0; i < core.getDrawableCount(); i++) {
    const count = counts[i] ?? 0;
    if (!count) continue;
    const ids = masks[i];
    if (!ids || ids.length < count) throw Error('AVATAR_MASK_DATA_INVALID');
    groups.add(Array.from(ids).slice(0, count).sort((a, b) => a - b).join(','));
  }
  const textureCount = renderer.getRenderTextureCount();
  // Cubism's shared atlas accepts 36 groups in one texture or 32 per multi-atlas texture.
  const capacity = textureCount <= 1 ? 36 : 32 * textureCount;
  if (groups.size > capacity) {
    renderer.useHighPrecisionMask(true);
    renderer.setClippingMaskBufferSize(512);
    if (!renderer.isUsingHighPrecisionMask() || renderer.getClippingMaskBufferSize() !== 512) {
      throw Error('AVATAR_MASK_CONFIGURATION_FAILED');
    }
  }
  return { maskGroups: groups.size, highPrecision: renderer.isUsingHighPrecisionMask(), maskSize: renderer.getClippingMaskBufferSize() };
}
