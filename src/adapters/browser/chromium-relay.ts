import { setTimeout as delay } from 'node:timers/promises';
import { jpegSize, startRelay } from '../../../scripts/ego-obs-relay/server.mjs';
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
    let failed = false, lastSent = 0, lastHeartbeat = 0, pending: string | undefined;
    let viewport: { width: number; height: number } | undefined;
    let layoutDirty = true, lastLayoutRead = 0;
    const readLayout = async () => {
      // Clear before awaiting so a resize during this read is not lost.
      layoutDirty = false;
      const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
      if (![layout?.width, layout?.height, layout?.dpr].every(value => Number.isFinite(value) && value > 0))
        throw Error('RELAY_VIEWPORT_INVALID');
      viewport = { width: layout.width * layout.dpr, height: layout.height * layout.dpr };
      lastLayoutRead = Date.now();
    };
    const fullFrame = (size: { width: number; height: number } | null) => {
      if (!size || !viewport) return false;
      const expected = viewport, scale = Math.min(1, options.width / expected.width, 2160 / expected.height);
      const matches = (factor: number) => Math.abs(size.width - Math.round(expected.width * factor)) <= 2 &&
        Math.abs(size.height - Math.round(expected.height * factor)) <= 2;
      return matches(scale) || matches(1); // Unscaled full-viewport heartbeat captures are also valid.
    };
    const remove = page.on('Page.screencastFrame', event => {
      pending = event.data;
      // Acknowledge cropped frames too; otherwise Chromium can stop capture.
      void page.cdp('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => { failed = true; });
    });
    const removeResize = page.on('Page.frameResized', () => { layoutDirty = true; });
    const capture = (async () => {
      try {
        await readLayout();
        await page.cdp('Page.startScreencast', { format: 'jpeg', quality: options.quality,
          maxWidth: options.width, maxHeight: 2160, everyNthFrame: 1 });
        while (!cancellation.signal.aborted && !failed) {
          if (layoutDirty) await readLayout();
          // Chromium emits no screencast frames on a static page. A periodic
          // screenshot is both a real capture heartbeat and a fresh still frame.
          if (!pending && Date.now() - Math.max(lastSent, lastHeartbeat) >= 2000) {
            lastHeartbeat = Date.now();
            const heartbeat = await page.cdp('Page.captureScreenshot', {
              format: 'jpeg', quality: options.quality, fromSurface: true, captureBeyondViewport: false,
            });
            pending ??= heartbeat.data; // Preserve a newer screencast received during capture.
          }
          if (pending) {
            const frame = pending; pending = undefined;
            const bytes = Buffer.from(frame, 'base64'), size = jpegSize(bytes);
            // A clipped screenshot on another CDP session can briefly resize
            // screencast pixels without resizing the page. Keep the last full
            // frame. Recheck layout at most once per second for missed resizes.
            if (!fullFrame(size) && Date.now() - lastLayoutRead >= 1000) await readLayout();
            if (fullFrame(size)) {
              const response = await fetch(`${relay.address}/frame`, { method: 'POST',
                headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'image/jpeg' },
                body: bytes, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(3000)]) });
              if (!response.ok) throw Error('RELAY_FRAME_REJECTED');
              lastSent = Date.now();
            }
          }
          await delay(1000 / options.fps, undefined, { signal: cancellation.signal });
        }
      } catch { if (!cancellation.signal.aborted) failed = true; }
      finally { remove(); removeResize(); await page.cdp('Page.stopScreencast').catch(() => {}); page.close(); }
    })();
    return { ...relay,
      stats: () => ({ ...relay.stats(), running: !failed && !cancellation.signal.aborted,
        workerExit: failed ? 'RELAY_CAPTURE_FAILED' : null }),
      async close() { cancellation.abort(); page.close(); await capture; await relay.close(); },
    };
  };
}
