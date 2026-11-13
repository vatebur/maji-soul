import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AvatarError } from '../../adapters/live/avatar-output.ts';

export interface AvatarAssets {
  config: { enabled: boolean; modelConfigured: boolean; modelUrl: string | null; profileUrl: string | null;
    coreUrl: string | null; characterName: string };
  read(path: string): Promise<{ bytes: Buffer; mime: string } | null>;
}
const mime: Record<string, string> = { '.json': 'application/json', '.moc3': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.js': 'text/javascript' };

/** Serve only the model's explicit runtime references, never a directory or arbitrary path. */
export async function loadAvatarAssets(env: NodeJS.ProcessEnv, enabled: boolean): Promise<AvatarAssets> {
  const modelPath = env.MAJI_AVATAR_MODEL?.trim(), profilePath = env.MAJI_AVATAR_PROFILE?.trim(), corePath = env.MAJI_AVATAR_CORE?.trim();
  const characterName = env.MAJI_AVATAR_NAME?.trim().slice(0, 80) || '雀魂主播';
  const files = new Map<string, { file: string; mime: string }>();
  const config: AvatarAssets['config'] = { enabled, modelConfigured: false, modelUrl: null, profileUrl: null, coreUrl: null, characterName };
  if (modelPath || profilePath || corePath) {
    if (!modelPath || !profilePath || !corePath) throw Error('AVATAR_MODEL_PROFILE_CORE_REQUIRED');
    const model = await realpath(resolve(modelPath)), root = await realpath(dirname(model));
    const document = JSON.parse(await readFile(model, 'utf8'));
    if (!document || document.Version !== 3 || !document.FileReferences || typeof document.FileReferences.Moc !== 'string')
      throw Error('INVALID_AVATAR_MODEL');
    const encode = (value: string) => value.split('/').map(encodeURIComponent).join('/');
    const modelUrl = '/avatar-assets/model/' + encode(basename(model));
    files.set(decodeURIComponent(modelUrl), { file: model, mime: 'application/json' });
    const references = document.FileReferences;
    const paths: unknown[] = [references.Moc, references.Physics, references.Pose, references.UserData, references.DisplayInfo,
      ...(Array.isArray(references.Textures) ? references.Textures : []),
      ...(Array.isArray(references.Expressions) ? references.Expressions.map((v: { File?: unknown }) => v?.File) : []),
      ...Object.values(references.Motions ?? {}).flatMap(group => Array.isArray(group) ? group.flatMap(v => [v?.File, v?.Sound]) : [])];
    for (const file of paths.filter(p => p !== undefined)) {
      if (typeof file !== 'string' || file.length > 1024 || isAbsolute(file) || file.includes('\\') || /[?#\x00-\x1f]/.test(file))
        throw Error('INVALID_AVATAR_REFERENCE');
      const location = await realpath(resolve(root, file)), rel = relative(root, location);
      if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || !mime[extname(file).toLowerCase()])
        throw Error('INVALID_AVATAR_REFERENCE');
      files.set('/avatar-assets/model/' + file.replace(/^\.\//, ''), { file: location, mime: mime[extname(file).toLowerCase()]! });
    }
    const profile = await realpath(resolve(profilePath)), core = await realpath(resolve(corePath));
    // Parse the profile at startup, rather than returning a misleading successful configuration.
    JSON.parse(await readFile(profile, 'utf8'));
    if (!(await stat(core)).isFile()) throw Error('INVALID_AVATAR_CORE');
    files.set('/avatar-assets/profile.json', { file: profile, mime: 'application/json' });
    files.set('/avatar-assets/live2dcubismcore.min.js', { file: core, mime: 'text/javascript' });
    Object.assign(config, { modelConfigured: true, modelUrl, profileUrl: '/avatar-assets/profile.json', coreUrl: '/avatar-assets/live2dcubismcore.min.js' });
  }
  return { config, async read(path) {
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { throw new AvatarError(400, 'INVALID_ASSET_PATH'); }
    const entry = files.get(decoded);
    if (!entry) return null;
    return { bytes: await readFile(entry.file), mime: entry.mime };
  } };
}
