import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function jpegSize(buffer) {
  let offset = 2;
  while (offset + 8 < buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    if (marker === 0xda || marker === 0xd9) break;
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

export async function startRelay(options) {
  const token = randomBytes(24).toString('hex');
  const clients = new Set();
  let latest, sequence = 0, bytes = 0, lastFrameAt = 0, worker, workerExit = null;
  let stopping = false;
  const arrivalTimes = [];
  const startedAt = Date.now();
  const player = await readFile(new URL('./player.html', import.meta.url));
  const stats = () => {
    const recent = arrivalTimes.filter(time => time > Date.now() - 5000);
    const seconds = Math.min(5, (Date.now() - startedAt) / 1000);
    return {
      space: options.space, page: options.page, sequence, bytes,
      fps: Number((recent.length / Math.max(seconds, 0.001)).toFixed(1)),
      frameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null,
      dimensions: latest ? jpegSize(latest) : null,
      clients: clients.size, workerExit, running: workerExit === null && !stopping,
    };
  };
  const sendFrame = (res, buffer) => {
    // Never build an unbounded frame queue for a slow/disconnected OBS source.
    if (res.destroyed || res.writableNeedDrain) return;
    res.write(`Content-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
    res.write(buffer);
    // Terminate this part immediately so a static page can show its one frame
    // without waiting for the next capture to supply the boundary delimiter.
    res.write('\r\n--frame\r\n');
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/capture-control') {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ enabled: !stopping }));
    } else if (req.method === 'POST' && url.pathname === '/frame') {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
      } catch { res.destroy(); return; }
      const buffer = Buffer.concat(chunks);
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || !jpegSize(buffer)) { res.writeHead(400).end(); return; }
      latest = buffer;
      sequence++;
      bytes += size;
      lastFrameAt = Date.now();
      arrivalTimes.push(lastFrameAt);
      while (arrivalTimes[0] < lastFrameAt - 5000) arrivalTimes.shift();
      for (const client of clients) sendFrame(client, buffer);
      res.writeHead(204).end();
    } else if (req.method === 'GET' && ['/', '/obs'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(player);
    } else if (req.method === 'GET' && url.pathname === '/stream.mjpeg') {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', Connection: 'keep-alive' });
      res.flushHeaders();
      res.write('--frame\r\n');
      clients.add(res);
      if (latest) sendFrame(res, latest);
      res.on('close', () => clients.delete(res));
    } else if (req.method === 'GET' && url.pathname === '/frame.jpg') {
      if (!latest) { res.writeHead(503).end('Waiting for first frame'); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(latest);
    } else if (req.method === 'GET' && url.pathname === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stats()));
    } else { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  const address = `http://127.0.0.1:${server.address().port}`;
  if (options.capture !== false) {
    const config = { ...options, endpoint: address, token };
    delete config.capture;
    const moduleUrl = new URL('./capture.mjs', import.meta.url).href;
    const script = `const {capture}=await import(${JSON.stringify(moduleUrl)}); await capture({taskSpace,...${JSON.stringify(config)}});`;
    worker = spawn('ego-browser', ['nodejs', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout.pipe(process.stdout);
    worker.stderr.pipe(process.stderr);
    worker.on('error', error => { workerExit = error.message; console.error(error.message); });
    worker.on('exit', (code, signal) => { workerExit = { code, signal }; console.log('Capture stopped:', workerExit); });
  }
  const close = async () => {
    if (stopping) return;
    stopping = true;
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      // Keep HTTP alive until the worker observes the stop flag and finishes
      // Page.stopScreencast. Otherwise an old runtime can stop a new stream.
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          worker.kill('SIGTERM');
          resolve();
        }, 5000);
        worker.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    }
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return { address, token, close, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = { space: null, page: 'p1', port: 17362, fps: 30, width: 1920, quality: 80 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!Object.hasOwn(options, key) || args[i + 1] === undefined) throw Error(`Invalid option: ${args[i]}`);
    options[key] = key === 'page' ? args[i + 1] : Number(args[i + 1]);
  }
  if (!Number.isSafeInteger(options.space) || options.space < 0 || !/^p\d+$/.test(options.page) ||
      !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 ||
      !Number.isInteger(options.fps) || options.fps < 1 || options.fps > 60 ||
      !Number.isInteger(options.width) || options.width < 320 || options.width > 3840 ||
      !Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) {
    throw Error('Usage: node scripts/ego-obs-relay/server.mjs --space 0 [--page p1 --port 17362 --fps 30 --width 1920 --quality 80]');
  }
  const relay = await startRelay(options);
  console.log(`OBS browser source: ${relay.address}/obs`);
  console.log(`Status: ${relay.address}/stats`);
  console.log('Press Ctrl+C to stop the relay. The existing game task is left running.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close(); });
}
