import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ChromiumPage } from '../../adapters/browser/chromium.ts';
import { runAutomation } from './automation-loop.ts';

// Separate process ownership matches the ego worker: the supervisor can kill a
// hung browser worker and its game/engine descendants before trying again.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
let page: ChromiumPage | undefined;
try {
  page = await ChromiumPage.connect(input.endpoint);
  await runAutomation(page, input.runtime, input.options, input.directory);
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const errorCode = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'AUTOMATION_START_FAILED';
  const path = join(input.directory, 'status.json');
  await writeFile(path + '.tmp', JSON.stringify({ available: true, enabled: false, status: 'faulted',
    completedMatches: 0, sessionId: null, errorCode }));
  await rename(path + '.tmp', path);
} finally { page?.close(); }
