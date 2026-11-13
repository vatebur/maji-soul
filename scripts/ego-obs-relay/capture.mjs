import { setTimeout as delay } from 'node:timers/promises';

/** Runs in ego's Node runtime; taskSpace is supplied by the documented CLI. */
export async function capture({ taskSpace, space, page: label, endpoint, token, fps, width, quality }) {
  const task = await taskSpace(space);
  const page = task.page(label);
  const headers = { authorization: `Bearer ${token}` };
  let stopping = false, mode = 'screencast', started = false;
  let frames = 0, nextSend = 0, pending, nextControlCheck = 0, lastFrameAt = 0;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const post = async (route, body, type) => {
    const response = await fetch(`${endpoint}/${route}`, {
      method: 'POST', headers: { ...headers, 'content-type': type }, body,
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw Error(`Relay returned ${response.status}`);
  };
  const send = async data => {
    await post('frame', Buffer.from(data, 'base64'), 'image/jpeg');
    frames++;
    lastFrameAt = performance.now();
  };
  const shouldStop = async () => {
    if (stopping) return true;
    if (performance.now() < nextControlCheck) return false;
    nextControlCheck = performance.now() + 250;
    const response = await fetch(`${endpoint}/capture-control`, { headers, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw Error('Capture control disconnected');
    stopping = !(await response.json()).enabled;
    return stopping;
  };
  try {
    // No navigation, input, emulation or control takeover is needed to capture.
    await page.cdp('Page.startScreencast', {
      format: 'jpeg', quality, maxWidth: width, maxHeight: 2160,
      // Output pacing below already caps fps. Skipping compositor frames here
      // would also halve a browser that itself renders below 60 fps.
      everyNthFrame: 1,
    });
    started = true;
    const firstFrameDeadline = performance.now() + 3000;
    while (!await shouldStop()) {
      const events = await page.events();
      for (const event of events) {
        if (event.method !== 'Page.screencastFrame') continue;
        pending = event.params.data;
        await page.cdp('Page.screencastFrameAck', { sessionId: event.params.sessionId });
      }
      if (frames && !pending && performance.now() - lastFrameAt >= 2000) {
        pending = (await page.cdp('Page.captureScreenshot', {
          format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false,
        })).data;
      }
      if (pending && performance.now() >= nextSend) {
        // Keep the newest frame until its slot, rather than dropping frames
        // that arrive just before the deadline due to polling/network jitter.
        nextSend = Math.max(nextSend + 1000 / fps, performance.now());
        await send(pending);
        pending = undefined;
      }
      if (!frames && performance.now() > firstFrameDeadline) {
        await page.cdp('Page.stopScreencast');
        started = false;
        mode = 'screenshots';
        console.log('No screencast frames; using sequential screenshots.');
        break;
      }
      await delay(8);
    }
    while (mode === 'screenshots' && !await shouldStop()) {
      const before = performance.now();
      const image = await page.cdp('Page.captureScreenshot', {
        format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false,
      });
      await send(image.data);
      await delay(Math.max(0, 1000 / fps - (performance.now() - before)));
    }
  } finally {
    // A control loss is terminal: do not claim the Space or retry around it.
    if (started) await page.cdp('Page.stopScreencast').catch(() => {});
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    console.log(JSON.stringify({ mode, frames }));
    // This Space belongs to the existing live task, so do not finish it here.
  }
}
