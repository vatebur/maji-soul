import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Evidence { schemaVersion: 1; probe: string; status: 'passed' | 'partial' | 'blocked';
  observedAt: string; evidenceType: 'local-integration' | 'service-integration'; details: Record<string, unknown>; }
export async function saveEvidence(evidence: Evidence) {
  const dir = 'data/validation';
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${evidence.probe}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  return path;
}
