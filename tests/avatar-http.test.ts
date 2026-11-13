import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AvatarOutput } from '../src/adapters/live/avatar-output.ts';
import { loadAvatarAssets, type AvatarAssets } from '../src/app/console/avatar-assets.ts';
import { ConsoleRuntime } from '../src/app/console/runtime.ts';
import { createConsoleServer } from '../src/app/console/server.ts';
import { formatSpokenText } from '../src/application/live/spoken-text.ts';
import { actorHarness } from './helpers.ts';

test('avatar assets expose only explicit model references and hide local filesystem paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-avatar-assets-'));
  try {
    const model = join(directory, 'model');
    await mkdir(model); await mkdir(join(model, 'textures'));
    await writeFile(join(model, '角色.model3.json'), JSON.stringify({ Version: 3, FileReferences: {
      Moc: 'model.moc3', Textures: ['textures/face.png'], Motions: { Idle: [{ File: 'idle.motion3.json' }] },
    } }));
    for (const file of ['model.moc3', 'textures/face.png', 'idle.motion3.json']) await writeFile(join(model, file), file);
    await writeFile(join(model, 'private.txt'), 'must not be exposed');
    await writeFile(join(directory, 'profile.json'), '{}');
    await writeFile(join(directory, 'core.js'), '/* test core */');
    const env = { MAJI_AVATAR_MODEL: join(model, '角色.model3.json'), MAJI_AVATAR_PROFILE: join(directory, 'profile.json'),
      MAJI_AVATAR_CORE: join(directory, 'core.js'), MAJI_AVATAR_NAME: '测试角色' };
    const assets = await loadAvatarAssets(env, true);
    assert.equal(assets.config.modelConfigured, true);
    assert.equal(assets.config.characterName, '测试角色');
    assert.ok(!JSON.stringify(assets.config).includes(directory));
    assert.equal((await assets.read(assets.config.modelUrl!))?.mime, 'application/json');
    assert.equal((await assets.read('/avatar-assets/model/textures/face.png'))?.bytes.toString(), 'textures/face.png');
    assert.equal(await assets.read('/avatar-assets/model/private.txt'), null);
    assert.equal(await assets.read('/avatar-assets/model/../profile.json'), null);
    assert.equal(await assets.read('/avatar-assets/model/%2e%2e/profile.json'), null);
    await assert.rejects(assets.read('/avatar-assets/model/%ZZ'), /INVALID_ASSET_PATH/);
    await writeFile(join(model, 'bad.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: '../profile.json', Textures: [] } }));
    await assert.rejects(loadAvatarAssets({ ...env, MAJI_AVATAR_MODEL: join(model, 'bad.model3.json') }, true), /INVALID_AVATAR_REFERENCE/);
    await symlink(join(directory, 'profile.json'), join(model, 'escape.json'));
    await writeFile(join(model, 'bad.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'escape.json', Textures: [] } }));
    await assert.rejects(loadAvatarAssets({ ...env, MAJI_AVATAR_MODEL: join(model, 'bad.model3.json') }, true), /INVALID_AVATAR_REFERENCE/);
    await assert.rejects(loadAvatarAssets({ MAJI_AVATAR_MODEL: env.MAJI_AVATAR_MODEL }, true), /AVATAR_MODEL_PROFILE_CORE_REQUIRED/);
    const empty = await loadAvatarAssets({}, true);
    assert.equal(empty.config.modelConfigured, false);
    assert.equal(empty.config.modelUrl, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('avatar audition uses the existing speech queue, rejects custom text, and respects owner, mute, busy and cooldown', async t => {
  const h = await actorHarness(4), heard: string[] = [], released: string[] = [];
  const output = new AvatarOutput({ synthesize: async text => { heard.push(text); return 'test-audition.mp3'; }, release: async file => { released.push(file); } });
  const runtime = await ConsoleRuntime.open({ store: h.store, source: { kind: 'follow', sessionId: h.actor.projection.sessionId },
    voiceId: 'voice', voices: [], speech: output.speech });
  const assets: AvatarAssets = { config: { enabled: true, modelConfigured: true, modelUrl: '/model', profileUrl: '/profile', coreUrl: '/core', characterName: '测试角色' }, read: async () => null };
  const server = createConsoleServer(runtime, 0, 17362, { output, assets });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
    assert.fail('audition did not settle');
  };
  try {
    let origin: string;
    try { ({ origin } = await server.listen()); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('loopback listen denied by sandbox'); return; }
      throw error;
    }
    const post = (path: string, body: object = {}, from = origin) => fetch(origin + '/api/avatar/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: from }, body: JSON.stringify(body),
    });
    assert.equal((await post('test', {}, 'https://example.com')).status, 403);
    assert.equal((await post('test', { text: 'arbitrary broadcast is not allowed' })).status, 422);
    const unavailable = await post('test');
    assert.equal(unavailable.status, 409);
    assert.equal((await unavailable.json()).error, 'AVATAR_RENDERER_UNAVAILABLE');
    assert.deepEqual(heard, []);
    const claim = await post('claim', { rendererId: 'audition-renderer', parameters: { ParamAngleX: { min: -20, max: 20, default: 0 } } }).then(r => r.json());
    const owner = { rendererId: 'audition-renderer', leaseId: claim.leaseId };
    await runtime.speech.setMuted(true);
    assert.equal((await post('test').then(r => r.json())).error, 'AVATAR_SPEECH_BUSY_OR_MUTED');
    await runtime.speech.setMuted(false);
    const accepted = await post('test');
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.ok, true);
    assert.equal(typeof acceptedBody.contentId, 'string');
    await until(() => output.status.phase === 'prepare');
    assert.deepEqual(heard, [formatSpokenText('[开心]大家好，一起开心打牌吧。')]);
    assert.equal((await post('test').then(r => r.json())).error, 'AVATAR_SPEECH_BUSY_OR_MUTED');
    const command = output.poll(owner).command!;
    const ack = { ...owner, speechId: command.speechId, playbackEpoch: command.playbackEpoch };
    assert.equal((await post('ack', { ...ack, status: 'ready', durationSec: 2 })).status, 200);
    assert.equal((await post('ack', { ...ack, status: 'started' })).status, 200);
    assert.equal((await post('ack', { ...ack, status: 'ended' })).status, 200);
    await until(() => !runtime.speech.busy);
    assert.equal(runtime.speech.last?.outcome, 'completed');
    assert.deepEqual(runtime.speech.last?.contentIds, [acceptedBody.contentId]);
    assert.deepEqual(released, ['test-audition.mp3']);
    const cooldown = await post('test');
    assert.equal(cooldown.status, 429);
    assert.equal((await cooldown.json()).error, 'AVATAR_TEST_COOLDOWN');
    assert.equal(heard.length, 1);
  } finally { output.close(); await server.close(); await runtime.close(); await h.cleanup(); }
});

test('avatar HTTP requires same-origin ownership and confines audio and acknowledgements to the current speech', async t => {
  const h = await actorHarness(4), directory = await mkdtemp(join(tmpdir(), 'maji-avatar-http-'));
  const artifact = join(directory, 'speech.mp3'), bundle = join(directory, 'avatar.bundle.js');
  const bytes = Buffer.from('test speech');
  await writeFile(artifact, bytes); await writeFile(bundle, '/* built test client */');
  const output = new AvatarOutput({ synthesize: async () => artifact, release: async () => {} });
  const assets: AvatarAssets = { config: { enabled: true, modelConfigured: true, modelUrl: '/avatar-assets/model/character.model3.json',
    profileUrl: '/avatar-assets/profile.json', coreUrl: '/avatar-assets/core.js', characterName: '测试角色' }, read: async () => null };
  const runtime = await ConsoleRuntime.open({ store: h.store, source: { kind: 'follow', sessionId: h.actor.projection.sessionId }, voiceId: 'voice', voices: [] });
  const server = createConsoleServer(runtime, 0, 17362, { output, assets, bundlePath: bundle });
  let playing: Promise<void> | undefined;
  try {
    let origin: string;
    try { ({ origin } = await server.listen()); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('loopback listen denied by sandbox'); return; }
      throw error;
    }
    const post = (path: string, body: object, from: string | null = origin) => fetch(origin + '/api/avatar/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(from ? { Origin: from } : {}) }, body: JSON.stringify(body),
    });
    const config = await fetch(origin + '/api/avatar/config').then(r => r.json());
    assert.equal(config.enabled, true); assert.equal(config.modelConfigured, true);
    assert.equal(config.data, undefined);
    assert.ok(!JSON.stringify(config).includes(directory));
    const page = await fetch(origin + '/avatar');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /media-src 'self'/);
    assert.equal((await fetch(origin + '/avatar.bundle.js')).status, 200);
    assert.equal((await fetch(origin + '/avatar-assets/private.txt')).status, 404);
    const claim = { rendererId: 'renderer-http', parameters: { ParamAngleX: { min: -30, max: 30, default: 0 } } };
    assert.equal((await post('claim', claim, null)).status, 403);
    assert.equal((await post('claim', claim, 'https://example.com')).status, 403);
    assert.equal((await post('claim', { ...claim, unknown: true })).status, 422);
    assets.config.modelConfigured = false;
    assert.equal((await post('claim', claim)).status, 409);
    assets.config.modelConfigured = true;
    const granted = await post('claim', claim).then(r => r.json());
    const identity = { rendererId: claim.rendererId, leaseId: granted.leaseId };
    assert.equal((await post('claim', { ...claim, rendererId: 'second-renderer' })).status, 409);
    const obs = await fetch(origin + '/api/obs/snapshot').then(r => r.json());
    assert.ok(!JSON.stringify(obs).includes(granted.leaseId));
    playing = output.speech.play(artifact, new AbortController().signal, { speechId: 'speech-http', playbackEpoch: 2,
      text: '[开心]试试动作吧。', expiresAt: new Date(Date.now() + 20_000).toISOString(), onStarted() {} });
    const poll = await post('poll', identity).then(r => r.json());
    assert.equal(poll.command.phase, 'prepare');
    const receivedAudio = await fetch(origin + poll.command.audioUrl).then(r => r.arrayBuffer());
    assert.deepEqual(Buffer.from(new Uint8Array(receivedAudio)), bytes);
    const forbiddenAudio = new URL(origin + poll.command.audioUrl); forbiddenAudio.searchParams.set('leaseId', 'old-lease');
    assert.equal((await fetch(forbiddenAudio)).status, 409);
    const ack = { ...identity, speechId: 'speech-http', playbackEpoch: 2 };
    assert.equal((await post('ack', { ...ack, status: 'ready', durationSec: 0 })).status, 422);
    assert.equal((await post('ack', { ...ack, status: 'ready', durationSec: 2 })).status, 200);
    assert.equal((await post('ack', { ...ack, status: 'ended' })).status, 409);
    assert.equal((await post('ack', { ...ack, status: 'started' })).status, 200);
    assert.equal((await post('ack', { ...ack, playbackEpoch: 1, status: 'ended' })).status, 409);
    assert.equal((await post('ack', { ...ack, status: 'ended' })).status, 200);
    await playing;
    assert.equal((await post('poll', identity).then(r => r.json())).command, null);
    assert.equal((await fetch(origin + poll.command.audioUrl)).status, 404);
    assert.equal((await post('release', identity)).status, 200);
    assert.equal((await post('poll', identity)).status, 409);
  } finally { output.close(); await playing?.catch(() => {}); await server.close(); await runtime.close(); await h.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
