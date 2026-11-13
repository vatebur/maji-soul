/** Calibrate the supplied DeepSeek-chan model through Cubism's public Core API. */
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadModelProfile, SoullinkRuntime, detectCapabilities } from '@soullink-emotion/engine';

const directory = resolve(process.argv[2] ?? 'data/avatar/deepseek');
const corePath = resolve(process.argv[3] ?? 'data/avatar/core/live2dcubismcore.min.js');
const modelFiles = (await readdir(directory)).filter(name => name.endsWith('.model3.json'));
if (modelFiles.length !== 1) throw Error('Expected one model3 file');
const modelFile = modelFiles[0];
const manifest = JSON.parse(await readFile(join(directory, modelFile), 'utf8'));
const mocBytes = await readFile(join(directory, manifest.FileReferences.Moc));
const context = vm.createContext({ console, atob, btoa, WebAssembly, setTimeout, clearTimeout, performance });
vm.runInContext(await readFile(corePath, 'utf8'), context, { timeout: 5000 });
const core = context.Live2DCubismCore;
let initialized = false;
for (let i = 0; i < 100; i++) {
  try { core.Version.csmGetVersion(); initialized = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
}
if (!initialized) throw Error('Cubism Core initialization failed');
const moc = core.Moc.fromArrayBuffer(mocBytes.buffer.slice(mocBytes.byteOffset, mocBytes.byteOffset + mocBytes.byteLength));
if (!moc) throw Error('Cubism Core cannot load this MOC');
const model = core.Model.fromMoc(moc);
const parameters = Object.fromEntries(model.parameters.ids.map((id, i) => [id, {
  min: model.parameters.minimumValues[i], max: model.parameters.maximumValues[i], default: model.parameters.defaultValues[i],
}]));
const rule = (target, min, max, scale = 1, mode = 'set') => {
  for (const id of Array.isArray(target) ? target : [target]) {
    if (!parameters[id] || parameters[id].min > min || parameters[id].max < max) throw Error(`Unexpected model parameter ${id}`);
  }
  return { ...(Array.isArray(target) ? { targets: target } : { target }), min, max, scale, mode };
};
const eyes = ['ParamEyeLOpen', 'ParamEyeROpen'], brows = ['ParamBrowLY', 'ParamBrowRY'];
const parameterMap = {
  headX: rule('ParamAngleX', -20, 20, 20), headY: rule('ParamAngleY', -15, 15, 15), headZ: rule('ParamAngleZ', -15, 15, 15),
  bodyX: rule('ParamBodyAngleX', -10, 10, 10), bodyY: rule('ParamBodyAngleY', -8, 8, 8), bodyZ: rule('ParamBodyAngleZ', -8, 8, 8),
  gazeX: rule('ParamEyeBallX', -.8, .8, .8), gazeY: rule('ParamEyeBallY', -.8, .8, .8),
  eyeOpen: rule(eyes, 0, 1.3), eyeBlinkL: rule('ParamEyeLOpen', 0, 1.3, 1, 'subtract'), eyeBlinkR: rule('ParamEyeROpen', 0, 1.3, 1, 'subtract'),
  eyeSmile: rule(eyes, 0, 1.3, .25, 'subtract'), eyeSquint: rule(eyes, 0, 1.3, .2, 'subtract'),
  browInnerUp: rule(brows, -.8, .8, .5), browOuterUp: rule(brows, -.8, .8, .25, 'add'), browDown: rule(brows, -.8, .8, .7, 'subtract'),
  mouthOpen: rule('ParamMouthOpenY', 0, 1, 8), mouthSmile: rule('ParamMouthForm', -.8, .8, .65), mouthFrown: rule('ParamMouthForm', -.8, .8, .65, 'subtract'),
  breath: rule('ParamBreath', 0, 1), blush: rule('key7', 0, 1, .7), tear: rule('key2', 0, 1, .55), sweat: rule('key13', 0, 1, .55),
};
const customParams = Object.fromEntries(['LArm', 'LForearm', 'LWrist', 'RArm', 'RForearm', 'RWrist'].map(id => [id, rule(id, -.25, .25, .25)]));
const mapped = new Set(Object.values({ ...parameterMap, ...customParams }).flatMap(r => r.targets ?? [r.target]));
const profile = {
  modelId: 'deepseek-chan', displayName: 'DeepSeek-chan', version: '1.0.0', schemaVersion: 2, modelPath: modelFile,
  sourceSignature: { model3File: modelFile, hash: createHash('sha256').update(mocBytes).digest('hex') },
  autoProfile: { provider: 'manual', notes: ['Measured with Cubism Core 5.1.0 public API.', 'Face/body gestures only; clothing, body shape and visibility controls excluded.', 'MouthOpenY is reserved for actual audio RMS lip sync; model mapping gain 8 makes Fish speech RMS visible without changing the audio or silence gate.'] },
  parameterMap, customParams,
  neutralParams: Object.fromEntries([...mapped].map(id => [id, parameters[id].default])),
  parameterSmoothing: Object.fromEntries([...mapped].map(id => [id, id === 'ParamMouthOpenY' ? 22 : 12])),
  idleConfig: { headX: [-.18, .18], headY: [-.1, .1], headZ: [-.14, .14], bodyX: [-.12, .12], bodyY: [-.06, .06], bodyZ: [-.1, .1] },
};
profile.capabilities = detectCapabilities(profile);
await loadModelProfile('local', async () => new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } }));
const runtime = new SoullinkRuntime({ profile });
const snapshot = runtime.update(0, 0);
if (snapshot.live2dParams.ParamMouthOpenY !== 0) throw Error('Neutral mouth must be closed');
await writeFile(join(directory, 'soullink.profile.json'), JSON.stringify(profile, null, 2) + '\n');
model.release(); moc._release();
console.log(JSON.stringify({ profile: join(directory, 'soullink.profile.json'), coreVersion: core.Version.csmGetVersion(), parameters: Object.keys(parameters).length, calibrated: mapped.size }));
