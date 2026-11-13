import { setTimeout as delay } from 'node:timers/promises';
import { startRelay } from '../../../scripts/ego-obs-relay/server.mjs';
import { ChromiumPage, browserEndpoint } from './chromium.ts';

/** Reuse the clean MJPEG output and its backpressure; only capture is platform-specific. */
export function chromiumRelay(endpoint: string): typeof startRelay {
  browserEndpoint(endpoint);
  return async options => {
    const page = await ChromiumPage.connect(endpoint);
    let relay: Awaited<ReturnType<typeof startRelay>>;
    try { relay = await startRelay({ ...options, capture: false }); }
    catch (error) { page.close(); throw error; }
    const cancellation = new AbortController();
    let failed = false, lastSent = 0, pending: string | undefined;
    const remove = page.on('Page.screencastFrame', event => {
      pending = event.data;
      void page.cdp('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => { failed = true; });
    });
    const capture = (async () => {
      try {
        await page.cdp('Page.startScreencast', { format: 'jpeg', quality: options.quality,
          maxWidth: options.width, maxHeight: 2160, everyNthFrame: 1 });
        while (!cancellation.signal.aborted && !failed) {
          // Chromium emits no screencast frames on a static page. A periodic
          // screenshot is both a real capture heartbeat and a fresh still frame.
          if (!pending && Date.now() - lastSent >= 2000) pending = (await page.cdp('Page.captureScreenshot', {
            format: 'jpeg', quality: options.quality, fromSurface: true, captureBeyondViewport: false,
          })).data;
          if (pending) {
            const frame = pending; pending = undefined;
            const response = await fetch(`${relay.address}/frame`, { method: 'POST',
              headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'image/jpeg' },
              body: Buffer.from(frame, 'base64'), signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(3000)]) });
            if (!response.ok) throw Error('RELAY_FRAME_REJECTED');
            lastSent = Date.now();
          }
          await delay(1000 / options.fps, undefined, { signal: cancellation.signal });
        }
      } catch { if (!cancellation.signal.aborted) failed = true; }
      finally { remove(); await page.cdp('Page.stopScreencast').catch(() => {}); page.close(); }
    })();
    return { ...relay,
      stats: () => ({ ...relay.stats(), running: !failed && !cancellation.signal.aborted,
        workerExit: failed ? 'RELAY_CAPTURE_FAILED' : null }),
      async close() { cancellation.abort(); page.close(); await capture; await relay.close(); },
    };
  };
}
