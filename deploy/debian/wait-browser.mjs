import { setTimeout as delay } from 'node:timers/promises';
import { ChromiumPage } from '../../src/adapters/browser/chromium.ts';

// A target URL appears before Unity's client script loads. Starting automation
// at that point would misclassify an empty script list as a version mismatch.
const until = Date.now() + 120_000;
while (true) {
  let page;
  try {
    page = await ChromiumPage.connect('http://127.0.0.1:9222');
    if (await page.evaluate(() => document.readyState === 'complete' && !!document.querySelector('canvas') &&
      [...document.scripts].some(script => script.src.includes('WebGL-release-')))) break;
  } catch { /* Browser startup is asynchronous. */ }
  finally { page?.close(); }
  if (Date.now() >= until) throw Error('BROWSER_START_TIMEOUT');
  await delay(500);
}
