import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { archiveEvidence } from './archive.mjs';

const label = 'offline-run';
const ui = `${label}-ui`;
const driverAudit = `${label}-ui-driver-audit.jsonl`;
const manualAudit = `${label}-manual-audit.jsonl`;
const manualReadback = `${label}-manual-readback-audit.jsonl`;
const reportPath = `${label}/report.json`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonl = (...records) => records.map(record => JSON.stringify(record) + '\n').join('');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maji-acceptance-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, 'source');
  const outputDirectory = join(root, 'archive');
  const manualFramesDirectory = join(root, 'manual');
  await mkdir(sourceRoot);
  await mkdir(manualFramesDirectory);
  async function put(path, bytes) {
    const target = join(sourceRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return { sourceRoot, outputDirectory, manualFramesDirectory, put };
}

test('archives raw records and captures with byte counts and digests, preserving blocked status', async t => {
  const { put, ...paths } = await fixture(t);
  const failedFrame = Buffer.from([0, 65, 255, 13, 10]);
  const manualFrame = Buffer.from([30, 40, 50, 60]);
  const screenshot = `maji-${label}-3.png`;
  await writeFile(join(paths.manualFramesDirectory, screenshot), manualFrame);
  const originals = new Map([
    [reportPath, '{"status":"blocked","captureDirectories":["/elsewhere/capture","/elsewhere/capture-2"]}\n'],
    [`${label}/capture/manifest.json`, '{ "scope": "initial" }\n'],
    [`${label}/capture/events.jsonl`, '{"event":"HandEnded"}\r\n'],
    [`${label}/capture/expected.json`, '{"matchResult":null}\n'],
    [`${label}/capture-2/manifest.json`, '{ "scope": "resumed" }\n'],
    [`${label}/capture-2/events.jsonl`, '{"event":"HandEnded"}\n'],
    [`${label}/capture-2/expected.json`, '{"matchResult":null}\n'],
    [`${label}-events-private.json`, '[{"name":"ActionHule","step":103}]\n'],
    [`${label}-detached-incident.json`, '{"archiveAttempt":"failed"}\n'],
    [`${ui}/key-pixels-1-failed.png`, failedFrame],
    [`${ui}/1-before.png`, Buffer.from([17, 72])],
    [driverAudit, jsonl(
      { kind: 'pixel-frame-failed', frame: 'key-pixels-1-failed.png', pngSha256: hash(failedFrame) },
      { kind: 'input-reserved', input: 1 },
      { kind: 'input-frame-retained', input: 1, frame: '1-before.png', pngSha256: hash(Buffer.from([17, 72])) },
      { kind: 'input-reconciled', input: 1, authority: { step: 17 } },
    )],
    [manualAudit, jsonl({ sequence: 3, command: { kind: 'click' }, screenshot: `/elsewhere/${screenshot}` })],
    [manualReadback, jsonl(
      { kind: 'manual-readback-failed', failureFrame: { path: `${ui}/key-pixels-1-failed.png`,
        pngSha256: hash(failedFrame), byteLength: failedFrame.length } },
      { kind: 'manual-readback-verified', proof: { observedAt: '2026-11-06T04:00:00Z' } },
    )],
  ]);
  for (const [path, content] of originals) await put(path, content);
  await put('different-run-ui-driver-audit.jsonl', 'different run');

  const evidence = await archiveEvidence({ label, ...paths });
  originals.set(`${ui}/${screenshot}`, manualFrame);
  assert.equal(evidence.sourceReportStatus, 'blocked');
  assert.equal(evidence.files.length, originals.size);
  assert.deepEqual(evidence.issues, []);
  for (const { path, bytes, sha256 } of evidence.files) {
    const expected = Buffer.from(originals.get(path));
    const archived = join(paths.outputDirectory, path);
    assert.deepEqual(await readFile(archived), expected);
    assert.equal(bytes, expected.length);
    assert.equal(sha256, hash(expected));
    assert.equal((await stat(archived)).mode & 0o777, 0o600);
  }
  const manifest = join(paths.outputDirectory, 'manifest.json');
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), evidence);
  assert.equal((await stat(paths.outputDirectory)).mode & 0o777, 0o700);
});

test('preserves failed readback lines and makes missing or mismatched files explicit', async t => {
  const { put, sourceRoot, outputDirectory } = await fixture(t);
  const audit = jsonl(
    { kind: 'post-input-readback-failed', code: 'AUTO_WIN_READBACK_STALE' },
    { kind: 'pixel-frame-failed', frame: 'missing-failed.png' },
    { kind: 'pixel-frame-failed', frame: 'mismatch-failed.png', pngSha256: 'not the archive digest' },
    { kind: 'input-reserved', input: 2 },
    { kind: 'readback-failed', frame: null, pngSha256: null },
  ) + '{"truncated":';
  await put(driverAudit, audit);
  await put(`${ui}/mismatch-failed.png`, 'retained frame');
  await put(reportPath, '{"status":"blocked","captureDirectory":"archive/capture-2"}');
  await put(manualAudit, jsonl({ sequence: 3, screenshot: `/tmp/maji-${label}-3.png` }));

  const evidence = await archiveEvidence({ label, sourceRoot, outputDirectory });
  assert.equal(await readFile(join(outputDirectory, driverAudit), 'utf8'), audit);
  assert(evidence.missing.some(item => item.audit === driverAudit && item.line === 1 && item.path === null));
  assert(evidence.missing.some(item => item.audit === driverAudit && item.line === 5 && item.path === null));
  assert(evidence.missing.some(item => item.role === 'failure-frame' && item.path === `${ui}/missing-failed.png`));
  assert(evidence.missing.some(item => item.role === 'driver-before-frame' && item.path === `${ui}/2-before.png`));
  assert(evidence.missing.some(item => item.role === 'manual-frame' && item.path === `${ui}/maji-${label}-3.png`));
  assert(evidence.missing.some(item => item.role === 'manual-readback-audit'));
  assert(evidence.missing.some(item => item.path === `${label}/capture-2/events.jsonl`));
  assert.deepEqual(evidence.issues, [
    { path: `${ui}/mismatch-failed.png`, audit: driverAudit, line: 3, code: 'FRAME_DIGEST_MISMATCH' },
    { path: driverAudit, line: 6, code: 'INVALID_JSON' },
  ]);
});

test('rejects traversal, symlink evidence, and an existing destination', async t => {
  const { put, sourceRoot, outputDirectory } = await fixture(t);
  await put('unrelated-secret.txt', 'private');
  const auditPath = join(sourceRoot, driverAudit);
  await symlink(join(sourceRoot, 'unrelated-secret.txt'), auditPath);
  await assert.rejects(archiveEvidence({ label: '../offline-run', sourceRoot, outputDirectory }), /Invalid run label/);
  await assert.rejects(archiveEvidence({ label, sourceRoot, outputDirectory }), /Expected a regular file/);
  await assert.rejects(access(outputDirectory), { code: 'ENOENT' });
  await mkdir(outputDirectory);
  const sentinel = join(outputDirectory, 'sentinel.txt');
  await writeFile(sentinel, 'previous archive');
  await assert.rejects(archiveEvidence({ label, sourceRoot, outputDirectory }), { code: 'EEXIST' });
  assert.equal(await readFile(sentinel, 'utf8'), 'previous archive');
});
