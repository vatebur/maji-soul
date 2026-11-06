import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const sidecars = [
  ['manual-audit.jsonl', 'manual-input-audit'],
  ['manual-readback-audit.jsonl', 'manual-readback-audit'],
  ['ui-driver-audit.jsonl', 'driver-input-and-readback-audit'],
  ['ui-driver-state.json', 'driver-state'],
  ['ui-driver-status.json', 'driver-status'],
  ['ui-driver-control.json', 'driver-control'],
  ['ready.json', 'observer-ready'],
  ['command.json', 'latest-manual-command'],
  ['result.json', 'latest-manual-result'],
  ['injection.json', 'fault-injection-record'],
  ['events-private.json', 'observed-protocol-frames'],
  ['win-diagnostics.json', 'client-win-diagnostics'],
  ['before-recovery-ledger-snapshot.json', 'ledger-snapshot'],
  ['detached-incident.json', 'incident'],
  ['handoff-tail.json', 'handoff-tail'],
];

const captureName = /^capture(?:-[1-9]\d*)?$/;

async function entry(path, type) {
  const stat = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !(type === 'directory' ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`Expected a regular ${type} at ${path}`);
  }
  return stat;
}

// The caller supplies an inactive run directory. Original bytes stay intact,
// including partial JSONL and private identifiers needed for local review.
export async function archiveEvidence({ sourceRoot, label, outputDirectory, manualFramesDirectory }) {
  if (typeof label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label)) {
    throw new Error('Invalid run label');
  }
  const source = await realpath(sourceRoot);
  const manualFrames = manualFramesDirectory && await realpath(manualFramesDirectory);
  const output = resolve(outputDirectory);
  const runDirectory = join(source, label);
  const uiName = `${label}-ui`;
  const uiDirectory = join(source, uiName);
  const hasRun = await entry(runDirectory, 'directory');
  const hasUi = await entry(uiDirectory, 'directory');
  const evidence = { schemaVersion: 1, label, sourceReportStatus: null, files: [], missing: [], issues: [] };
  const archived = new Map();

  async function copy(path, role, from = join(source, path)) {
    if (!await entry(from, 'file')) {
      evidence.missing.push({ path, role });
      return null;
    }
    const bytes = await readFile(from);
    const target = join(output, path);
    await mkdir(dirname(target), { mode: 0o700, recursive: true });
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    const info = { path, role, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    evidence.files.push(info);
    archived.set(path, info);
    return bytes;
  }

  function parse(bytes, path, line) {
    try {
      return JSON.parse(bytes);
    } catch {
      evidence.issues.push({ path, ...(line && { line }), code: 'INVALID_JSON' });
      return null;
    }
  }

  async function collectAuditFrames(bytes, path, manual) {
    if (!bytes) return;
    const lines = bytes.toString('utf8').split('\n');
    const linked = new Set();
    for (const [index, raw] of lines.entries()) {
      if (!raw.trim()) continue;
      const line = index + 1;
      const record = parse(raw, path, line);
      if (!record) continue;
      if (!manual && record.kind === 'input-reserved' && Number.isSafeInteger(record.input)) {
        const frame = `${uiName}/${record.input}-before.png`;
        if (!archived.has(frame)) evidence.missing.push({ path: frame, role: 'driver-before-frame', audit: path, line });
      }
      if (manual && record.screenshot != null) {
        const name = `maji-${label}-${record.sequence}.png`;
        if (!Number.isSafeInteger(record.sequence) || typeof record.screenshot !== 'string' || basename(record.screenshot) !== name) {
          evidence.issues.push({ path, line, code: 'INVALID_MANUAL_FRAME_REFERENCE' });
          continue;
        }
        const frame = `${uiName}/${name}`;
        if (!linked.has(frame) && !archived.has(frame)) {
          linked.add(frame);
          if (manualFrames) await copy(frame, 'manual-frame', join(manualFrames, name));
          else evidence.missing.push({ path: frame, role: 'manual-frame', audit: path, line });
        }
      }
      const failure = ['pixel-frame-failed', 'post-input-readback-failed', 'manual-readback-failed', 'readback-failed'].includes(record.kind);
      if (!failure && record.kind !== 'input-frame-retained') continue;
      const role = failure ? 'failure-frame' : 'driver-before-frame';
      const { path: reference, pngSha256, byteLength } = record.failureFrame ?? { path: record.frame, pngSha256: record.pngSha256 };
      if (typeof reference !== 'string' || !basename(reference).endsWith('.png')) {
        evidence.missing.push({ path: null, role, audit: path, line });
        continue;
      }
      const frame = `${uiName}/${basename(reference)}`;
      const info = archived.get(frame);
      if (!info) evidence.missing.push({ path: frame, role, audit: path, line });
      else {
        if (pngSha256 != null && pngSha256 !== info.sha256) {
          evidence.issues.push({ path: frame, audit: path, line, code: 'FRAME_DIGEST_MISMATCH' });
        }
        if (byteLength != null && byteLength !== info.bytes) {
          evidence.issues.push({ path: frame, audit: path, line, code: 'FRAME_LENGTH_MISMATCH' });
        }
      }
    }
  }

  // An existing directory might be another run. Create the destination
  // exclusively and write the manifest last as its completion marker.
  await mkdir(output, { mode: 0o700 });
  try {
    const reportPath = `${label}/report.json`;
    const reportBytes = await copy(reportPath, 'observer-report');
    const report = reportBytes && parse(reportBytes, reportPath);
    if (typeof report?.status === 'string') evidence.sourceReportStatus = report.status;
    const captures = new Set();
    if (hasRun) {
      for (const name of await readdir(runDirectory)) {
        if (captureName.test(name)) captures.add(name);
      }
    }
    const references = Array.isArray(report?.captureDirectories) ? report.captureDirectories : [report?.captureDirectory];
    for (const reference of references) {
      if (typeof reference === 'string' && captureName.test(basename(reference))) captures.add(basename(reference));
    }
    if (!captures.size) captures.add('capture');
    for (const name of [...captures].sort()) {
      await entry(join(runDirectory, name), 'directory');
      for (const file of ['manifest.json', 'events.jsonl', 'expected.json']) {
        await copy(`${label}/${name}/${file}`, 'authoritative-capture');
      }
    }

    if (hasUi) {
      for (const name of (await readdir(uiDirectory)).sort()) {
        let role;
        if (name.endsWith('-failed.png')) role = 'failure-frame';
        else if (/^\d+-before\.png$/.test(name)) role = 'driver-before-frame';
        else if (name.startsWith(`maji-${label}-`) && name.endsWith('.png')) role = 'manual-frame';
        else if (name.endsWith('.png')) role = 'ui-frame';
        else if (name === 'native-trace.json' || name === 'events.jsonl') role = 'ui-trace';
        else continue;
        await copy(`${uiName}/${name}`, role);
      }
    }
    for (const [name, role] of sidecars) {
      const path = `${label}-${name}`;
      const bytes = await copy(path, role);
      if (role === 'manual-input-audit' || role === 'manual-readback-audit' || role === 'driver-input-and-readback-audit') {
        await collectAuditFrames(bytes, path, role === 'manual-input-audit');
      }
    }
    if (!evidence.files.length) throw new Error('No run evidence found');
    await writeFile(join(output, 'manifest.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return evidence;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [sourceRoot, label, outputDirectory, flag, manualFramesDirectory, ...extra] = process.argv.slice(2);
  if (!outputDirectory || (flag !== undefined && (flag !== '--manual-frames' || !manualFramesDirectory || extra.length))) {
    console.error('Usage: node scripts/acceptance/archive.mjs <source-root> <label> <new-output-directory> [--manual-frames <directory>]');
    process.exitCode = 2;
  } else {
    try {
      const evidence = await archiveEvidence({ sourceRoot, label, outputDirectory, manualFramesDirectory });
      console.log(JSON.stringify({ manifest: join(resolve(outputDirectory), 'manifest.json'),
        files: evidence.files.length, missing: evidence.missing.length, issues: evidence.issues.length }));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
