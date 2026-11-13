import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AvatarError, type AvatarOutput, type AvatarAck, type AvatarIdentity } from '../../adapters/live/avatar-output.ts';
import type { AvatarAssets } from './avatar-assets.ts';
import { canonical } from '../../domain/game/value.ts';
import { object, string } from '../../schemas/game.ts';
import { ConsoleError, apiError, commandName, publicAction, type ConsoleRuntime } from './runtime.ts';

type Channel = 'console' | 'obs';
type Snapshots = ConsoleRuntime['projections'];
type Frame = { revision: number; generatedAt: string; views: Snapshots };
type Client = { channel: Channel; response: ServerResponse; stalledAt: number | null };
const html = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const assets = new Map([
  ['/', { body: html('./control.html'), mime: 'text/html' }],
  ['/obs', { body: html('./obs.html'), mime: 'text/html' }],
  ['/avatar', { body: html('./avatar.html'), mime: 'text/html' }],
  ['/avatar.css', { body: html('./avatar.css'), mime: 'text/css' }],
  ['/ui.js', { body: html('./ui.js'), mime: 'text/javascript' }],
  ['/obs.js', { body: html('./obs.js'), mime: 'text/javascript' }],
  ['/ui.css', { body: html('./ui.css'), mime: 'text/css' }],
]);
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ConsoleError(422, 'INVALID_JSON');
  const max = 256 * 1024, chunks: Buffer[] = [];
  if (Number(request.headers['content-length']) > max) { request.resume(); throw new ConsoleError(413, 'PAYLOAD_TOO_LARGE'); }
  let size = 0;
  const reader = request.iterator({ destroyOnReturn: false });
  for await (const chunk of reader) {
    size += chunk.length;
    if (size > max) { request.resume(); throw new ConsoleError(413, 'PAYLOAD_TOO_LARGE'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ConsoleError(422, 'INVALID_JSON'); }
}

export function createConsoleServer(runtime: ConsoleRuntime, initialPort: number, relayPort = 17362,
  avatar?: { output: AvatarOutput; assets: AvatarAssets; bundlePath?: string }) {
  if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535) throw Error('INVALID_RELAY_PORT');
  let origin = `http://127.0.0.1:${initialPort}`;
  const epoch = randomUUID(), cursorKey = randomBytes(32);
  const viewers = new Set<Client>();
  const frames: Frame[] = [{ revision: 0, generatedAt: new Date().toISOString(), views: runtime.projections }];
  let closing = false;
  let avatarTestAt = 0;

  const snapshot = (channel: Channel, frame = frames.at(-1)!) => ({
    projection: { epoch, revision: frame.revision, cursor: `${channel}.${epoch}.${frame.revision}`, generatedAt: frame.generatedAt },
    state: frame.views[channel],
  });
  function sendFrame(client: Client, event: 'snapshot' | 'reset', frame?: Frame) {
    const value = snapshot(client.channel, frame);
    if (!client.response.write(`id: ${value.projection.cursor}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
      client.stalledAt = Date.now();
  }
  runtime.onChange(() => {
    const views = runtime.projections;
    // Keep revision continuity for both channels with a bounded replay window.
    frames.push({ revision: frames.at(-1)!.revision + 1, generatedAt: new Date().toISOString(), views });
    if (frames.length > 64) frames.shift();
    for (const client of viewers) if (client.stalledAt === null) sendFrame(client, 'snapshot');
  });

  function stream(request: IncomingMessage, response: ServerResponse, channel: Channel, after: string | null) {
    if (viewers.size >= 24) throw new ConsoleError(429, 'RATE_LIMITED');
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const client: Client = { channel, response, stalledAt: null };
    viewers.add(client);
    response.once('close', () => viewers.delete(client));
    response.on('drain', () => {
      if (client.stalledAt !== null && !response.destroyed) {
        client.stalledAt = null;
        sendFrame(client, 'reset');
      }
    });
    const cursor = request.headers['last-event-id'] ?? after;
    const index = typeof cursor === 'string' ? frames.findIndex(f => snapshot(channel, f).projection.cursor === cursor) : -1;
    if (index < 0) sendFrame(client, 'reset');
    else for (const frame of frames.slice(index + 1)) {
      if (client.stalledAt !== null) break;
      sendFrame(client, 'snapshot', frame);
    }
  }

  function checkOrigin(request: IncomingMessage) {
    if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new ConsoleError(403, 'ORIGIN_FORBIDDEN');
  }
  function sign(payload: string) { return createHmac('sha256', cursorKey).update(payload).digest('base64url'); }
  async function decisions(url: URL) {
    const query = Object.fromEntries(url.searchParams);
    let after = Number.MAX_SAFE_INTEGER, limit = 20, expiry = Date.now() + 15 * 60_000;
    let sessionId: string, matchId: string | null, handId: string | null;
    try {
      object(query, ['sessionId'], ['matchId','handId','cursor','limit']);
      if (url.searchParams.size !== Object.keys(query).length) throw Error();
      string(query.sessionId, 128);
      for (const field of ['matchId','handId']) if (query[field] !== undefined) string(query[field], 128);
      sessionId = query.sessionId; matchId = query.matchId ?? null; handId = query.handId ?? null;
      if (query.limit !== undefined) {
        if (!/^[1-9]\d{0,2}$/.test(query.limit) || Number(query.limit) > 100) throw Error();
        limit = Number(query.limit);
      }
    } catch { throw new ConsoleError(422, 'VALIDATION_FAILED'); }
    const filters = [sessionId, matchId, handId, limit];
    if (query.cursor !== undefined) {
      if (!/^[\w-]{1,1800}\.[\w-]{43}$/.test(query.cursor)) throw new ConsoleError(422, 'VALIDATION_FAILED');
      const [body, signature] = query.cursor.split('.') as [string, string];
      if (!safeEqual(sign(body), signature)) throw new ConsoleError(410, 'CURSOR_EXPIRED');
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (canonical(parsed.filters) !== canonical(filters)) throw new ConsoleError(422, 'VALIDATION_FAILED');
      expiry = parsed.expiry; after = parsed.after;
      if (Date.now() >= expiry) throw new ConsoleError(410, 'CURSOR_EXPIRED');
    }
    const rows = await runtime.store.readDecisions(sessionId, matchId, handId, after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ decisionId: row.scope.decisionId, matchId: row.scope.matchId,
      handId: row.scope.handId, createdAt: row.createdAt, activeMode: row.activeMode, status: row.status, fellBack: false }));
    const body = rows.length > limit ? Buffer.from(JSON.stringify({ filters, expiry, after: rows[limit - 1]!.key })).toString('base64url') : null;
    return { items, nextCursor: body ? `${body}.${sign(body)}` : null };
  }
  async function decision(id: string) {
    const entry = await runtime.store.readDecision(id);
    if (!entry) throw new ConsoleError(404, 'NOT_FOUND');
    const { snapshot, attempts, confirmations } = entry;
    const { sourceCursor: _cursor, state: { latestAction, ...state }, ...record } = snapshot;
    return {
      record: { snapshot: { ...record, knownFacts: [], state: { ...state, ...(latestAction ? { latestAction: publicAction(latestAction) } : {}) } },
        status: entry.status, providerResults: [] },
      attempts: attempts.map(a => ({ id: a.id, scope: snapshot.scope, windowId: a.windowId, actionId: a.actionId, stateVersion: a.stateVersion,
        connectionEpoch: a.connectionEpoch, controlEpoch: a.controlEpoch, status: a.status, preparedAt: a.preparedAt,
        ...(a.receipt ? { transportReceipt: a.receipt.delivery } : {}) })),
      confirmations: confirmations.map(c => ({ attemptId: c.attempt.id, decisionId: id, observedAction: publicAction(c.fact), matchedBy: c.matchedBy,
        confirmedAt: c.fact.observedAt })),
      explanations: (await runtime.discards(snapshot.scope.sessionId)).filter(d => d.decisionId === id).map(d => ({
        id: d.id, decisionId: id, observedActionEventId: d.eventId, handId: d.handId, source: d.source,
        factText: d.text ?? '', evidenceIds: d.evidenceIds, limitations: d.limitations, createdAt: d.createdAt,
      })),
    };
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' http://127.0.0.1:${relayPort}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    const requestId = randomUUID(), at = new Date().toISOString();
    const reply = (status: number, data: unknown, error = false) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ apiVersion: 1, requestId, at, [error ? 'error' : 'data']: data }));
    };
    void (async () => {
      if (closing) throw new ConsoleError(503, 'SERVICE_UNAVAILABLE');
      if (request.headers.host !== new URL(origin).host || !request.url?.startsWith('/') || request.url.startsWith('//'))
        throw new ConsoleError(403, 'ORIGIN_FORBIDDEN');
      const url = new URL(request.url, origin), path = url.pathname, method = request.method ?? '';
      if (url.origin !== origin) throw new ConsoleError(403, 'ORIGIN_FORBIDDEN');
      if (path === '/avatar' || path === '/avatar.bundle.js' || path.startsWith('/avatar-assets/'))
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (method === 'GET' && (path === '/avatar.bundle.js' || path === '/avatar.bundle.js.LEGAL.txt')) {
        let bundle: Buffer;
        const legal = path.endsWith('.LEGAL.txt');
        try { bundle = await readFile((avatar?.bundlePath ?? resolve('.runtime/avatar/avatar.bundle.js')) + (legal ? '.LEGAL.txt' : '')); }
        catch { throw new AvatarError(503, 'AVATAR_BUILD_REQUIRED'); }
        response.writeHead(200, { 'Content-Type': (legal ? 'text/plain' : 'text/javascript') + '; charset=utf-8' }); response.end(bundle); return;
      }
      if (method === 'GET' && path.startsWith('/avatar-assets/')) {
        const asset = await avatar?.assets.read(path);
        if (!asset) throw new AvatarError(404, 'AVATAR_ASSET_NOT_FOUND');
        response.writeHead(200, { 'Content-Type': asset.mime }); response.end(asset.bytes); return;
      }
      if (path.startsWith('/api/avatar/')) {
        const avatarReply = (data: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
        if (method === 'GET' && path === '/api/avatar/config') return avatarReply(avatar ?
          { ...avatar.assets.config, ...avatar.output.status } : { enabled: false, modelConfigured: false, modelUrl: null, profileUrl: null, coreUrl: null, characterName: '雀魂主播' });
        if (!avatar) throw new AvatarError(503, 'AVATAR_DISABLED');
        const audioMatch = /^\/api\/avatar\/audio\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
        if (method === 'GET' && audioMatch) {
          const bytes = await avatar.output.audio({ rendererId: url.searchParams.get('rendererId') ?? '', leaseId: url.searchParams.get('leaseId') ?? '' }, audioMatch[1]!);
          response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': bytes.byteLength }); response.end(bytes); return;
        }
        if (method !== 'POST') throw new AvatarError(404, 'NOT_FOUND');
        // Dedicated playback capabilities never grant the console's game-control commands.
        if (request.headers.origin !== origin) throw new AvatarError(403, 'ORIGIN_FORBIDDEN');
        if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') throw new AvatarError(403, 'ORIGIN_FORBIDDEN');
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AvatarError(422, 'INVALID_AVATAR_REQUEST');
        const value = body as Record<string, unknown>;
        if (path === '/api/avatar/test') {
          if (Object.keys(value).length) throw new AvatarError(422, 'INVALID_AVATAR_REQUEST');
          if (!avatar.output.status.connected) throw new AvatarError(409, 'AVATAR_RENDERER_UNAVAILABLE');
          if (runtime.speech.view.muted || runtime.speech.busy || runtime.speech.view.pendingCount)
            throw new AvatarError(409, 'AVATAR_SPEECH_BUSY_OR_MUTED');
          if (Date.now() - avatarTestAt < 30_000) throw new AvatarError(429, 'AVATAR_TEST_COOLDOWN');
          avatarTestAt = Date.now();
          const contentId = randomUUID();
          runtime.speech.enqueue({ contentId, handId: null, priority: 'viewer', text: '[开心]大家好，一起开心打牌吧。',
            createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
          return avatarReply({ ok: true, contentId });
        }
        if (path === '/api/avatar/claim') {
          if (!avatar.assets.config.modelConfigured) throw new AvatarError(409, 'AVATAR_MODEL_NOT_CONFIGURED');
          if (Object.keys(value).some(key => !['rendererId','parameters'].includes(key))) throw new AvatarError(422, 'INVALID_AVATAR_REQUEST');
          return avatarReply(avatar.output.claim({ rendererId: value.rendererId as string, parameters: value.parameters }));
        }
        const allowed = path === '/api/avatar/ack' ? ['rendererId','leaseId','speechId','playbackEpoch','status','durationSec'] : ['rendererId','leaseId'];
        if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.rendererId !== 'string' || typeof value.leaseId !== 'string')
          throw new AvatarError(422, 'INVALID_AVATAR_REQUEST');
        const identity = value as unknown as AvatarIdentity;
        if (path === '/api/avatar/poll') return avatarReply(avatar.output.poll(identity));
        if (path === '/api/avatar/release') return avatarReply(avatar.output.release(identity));
        if (path === '/api/avatar/ack') {
          if (typeof value.speechId !== 'string' || !Number.isSafeInteger(value.playbackEpoch) || (value.playbackEpoch as number) < 1)
            throw new AvatarError(422, 'INVALID_AVATAR_REQUEST');
          return avatarReply(avatar.output.ack(value as unknown as AvatarAck));
        }
        throw new AvatarError(404, 'NOT_FOUND');
      }
      if (method === 'GET') {
        const asset = assets.get(path);
        if (asset) { response.writeHead(200, { 'Content-Type': asset.mime + '; charset=utf-8' }); response.end(asset.body); return; }
        if (path === '/healthz') return reply(200, { status: 'alive', buildVersion: '0.0.0' });
        if (path === '/api/obs/snapshot') return reply(200, snapshot('obs'));
        if (path === '/api/obs/events') return stream(request, response, 'obs', url.searchParams.get('after'));
      }
      if (!path.startsWith('/api/')) throw new ConsoleError(404, 'NOT_FOUND');
      if (method === 'GET') {
        if (path === '/api/console/snapshot') return reply(200, snapshot('console'));
        if (path === '/api/console/events') return stream(request, response, 'console', url.searchParams.get('after'));
        if (path === '/api/config') return reply(200, runtime.configView);
        if (path === '/api/capabilities') return reply(200, runtime.capabilities);
        if (path === '/api/output/status') return reply(200, { ...runtime.outputStatus, ...(avatar ? { avatar: avatar.output.status } : {}) });
        if (path === '/api/discards') {
          const id = url.searchParams.get('sessionId') ?? runtime.gameSessionId;
          if (id !== null) { try { string(id, 128); } catch { throw new ConsoleError(422, 'VALIDATION_FAILED'); } }
          return reply(200, { items: id ? await runtime.discards(id) : [] });
        }
        if (path === '/api/decisions') return reply(200, await decisions(url));
        const match = /^\/api\/(commands|decisions)\/([^/]+)$/.exec(path);
        if (match) {
          let id: string;
          try { id = decodeURIComponent(match[2]!); string(id, 128); } catch { throw new ConsoleError(422, 'VALIDATION_FAILED'); }
          if (match[1] === 'decisions') return reply(200, await decision(id));
          const command = await runtime.store.readCommand(id);
          if (!command) throw new ConsoleError(404, 'NOT_FOUND');
          return reply(200, command.body);
        }
      }
      const command = commandName(path, method);
      if (!command) throw new ConsoleError(404, 'NOT_FOUND');
      checkOrigin(request);
      return reply(200, await runtime.command(command, await readBody(request)));
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const storage = error instanceof Error && /^(STORAGE_|CONSOLE_STATE_CONFLICT)/.test(error.message);
      if (error instanceof AvatarError) {
        response.writeHead(error.status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: error.code }));
      }
      else if (error instanceof ConsoleError) reply(error.status, error.detail, true);
      else reply(storage ? 503 : 500, apiError(storage ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR'), true);
    });
  });
  server.maxConnections = 80;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of viewers) {
      if (client.stalledAt !== null) {
        if (now - client.stalledAt >= 15_000) client.response.destroy();
      } else if (!client.response.write(': ping\n\n')) client.stalledAt = now;
    }
  }, 5000).unref();

  return {
    server,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(initialPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('CONSOLE_LISTEN_FAILED');
      origin = `http://127.0.0.1:${address.port}`;
      return { origin, consoleUrl: `${origin}/`, obsUrl: `${origin}/obs`, ...(avatar ? { avatarUrl: `${origin}/avatar` } : {}) };
    },
    async close() {
      closing = true;
      avatar?.output.close();
      clearInterval(heartbeat);
      for (const client of viewers) client.response.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
