import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { requireThat } from '../../domain/game/value.ts';
import type { EgoPagePort } from './ego-transport.ts';
import { createOperationRules } from './actions.ts';

export async function installLiveBridge(page: EgoPagePort, reconnect = false, options: { phase2ActionsEnabled?: boolean; akagiEnabled?: boolean } = {}) {
  const base = new URL('../../../', import.meta.url);
  const upstream = '.runtime/upstream/Akagi-63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/bridge/majsoul/';
  const [proto, rpcText, source, library, versionText] = await Promise.all([
    readFile(new URL(upstream + 'proto/liqi.proto', base), 'utf8'),
    readFile(new URL(upstream + 'liqi.json', base), 'utf8'),
    readFile(new URL('browser-bridge.js', import.meta.url), 'utf8'),
    readFile(new URL('node_modules/protobufjs/dist/protobuf.min.js', base), 'utf8'),
    readFile(new URL('config/versions.json', base), 'utf8'),
  ]);
  const versions = JSON.parse(versionText), sha = (text: string) => createHash('sha256').update(text).digest('hex');
  requireThat(sha(proto) === versions.protoSha256 && sha(rpcText) === versions.rpcMapSha256, 'PROTOCOL_HASH_MISMATCH');
  const scripts = await page.evaluate(() => [...document.scripts].map(s => s.src).filter(s => s.includes('WebGL-release-'))) as string[];
  requireThat(scripts.some(s => s.includes(`release-${versions.clientVersion}(`)), 'CLIENT_VERSION_MISMATCH');
  const input = { proto, rpcMap: JSON.parse(rpcText), operationRulesSource: createOperationRules.toString(),
    phase2ActionsEnabled: options.phase2ActionsEnabled === true || options.akagiEnabled === true,
    akagiEnabled: options.akagiEnabled === true };
  if (reconnect) {
    requireThat(page.cdp && page.reload, 'EGO_RELOAD_UNAVAILABLE');
    const preload = `${library}\n(${source.replace('export function', 'function')})(${JSON.stringify(input)});`;
    const added = await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: preload });
    try { await page.reload(); }
    finally { await page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier }); }
    return { installed: true, reconnected: true, clientVersion: versions.clientVersion, automationEnabled: false };
  }
  await page.evaluate(library);
  const installed = await page.evaluate(({ source, input }) => (0, eval)(`(${source})`)(input),
    { source: source.replace('export function', 'function'), input });
  return { ...installed, clientVersion: versions.clientVersion, protoSha256: versions.protoSha256,
    source: fileURLToPath(new URL('browser-bridge.js', import.meta.url)), automationEnabled: false };
}
