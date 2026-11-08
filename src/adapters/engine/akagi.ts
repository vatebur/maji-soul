import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import versions from '../../../config/versions.json' with { type: 'json' };
import type { DecisionSnapshot, GameObservation, LegalAction, TileCode } from '../../domain/game/types.ts';
import { seats } from '../../domain/game/reducer.ts';
import { canonical, digest, requireThat } from '../../domain/game/value.ts';

const modelHash = `sha256:${versions.model4pSha256}`;
const rules = 'majsoul-friend-east-3-red';
const honors = ['E', 'S', 'W', 'N', 'P', 'F', 'C'];
const mjaiTile = (tile: TileCode) => tile.endsWith('z') ? honors[Number(tile[0]) - 1]! : tile;
const sameTiles = (a: unknown, b: string[]) => Array.isArray(a) && canonical([...a].sort()) === canonical([...b].sort());

/** Only the local player's concealed tiles are supplied to the engine. */
export function akagiHistory(history: readonly GameObservation[]) {
  const first = history[0];
  requireThat(first?.type === 'HandStarted', 'AKAGI_HAND_START_REQUIRED');
  const view = first.payload.initialView;
  const own = view.ownConcealed.map(tile => mjaiTile(tile.code));
  requireThat(own.length === (view.dealer === view.ownSeat ? 14 : 13) && view.doraIndicators.length === 1, 'AKAGI_OPENING_UNSUPPORTED');
  // MJAI needs a dealer draw. For an unordered opening this split is local to
  // the engine; neither the action mapper nor the ledger calls it a tsumogiri.
  const openingDraw = view.dealer === view.ownSeat ? own.pop()! : '?';
  const events: { index: number; sourceEventId: string; mjai: object }[] = [];
  const add = (event: GameObservation, mjai: object) => {
    events.push({ index: events.length + 1, sourceEventId: event.observationId, mjai });
  };
  add(first, { type: 'start_kyoku', bakaze: mjaiTile(view.roundWind), dora_marker: mjaiTile(view.doraIndicators[0]!),
    kyoku: view.handNumber, honba: view.honba, kyotaku: view.riichiSticks, oya: view.dealer,
    scores: seats.map(seat => view.players[seat].score), tehais: seats.map(seat => seat === view.ownSeat ? own : Array<string>(13).fill('?')) });
  add(first, { type: 'tsumo', actor: view.dealer, pai: openingDraw });
  let doraCount = 1;
  for (const event of history.slice(1)) {
    switch (event.type) {
      case 'TileDrawn': {
        const { actor, tile } = event.payload;
        add(event, { type: 'tsumo', actor, pai: tile.known ? mjaiTile(tile.value) : '?' });
        break;
      }
      case 'TileDiscarded': {
        const { actor, tile, tsumogiri, riichiDeclaration } = event.payload;
        requireThat(tsumogiri.known, 'AKAGI_DISCARD_UNVERIFIED');
        if (riichiDeclaration) add(event, { type: 'reach', actor });
        add(event, { type: 'dahai', actor, pai: mjaiTile(tile), tsumogiri: tsumogiri.value });
        break;
      }
      case 'MeldDeclared': {
        const { actor, kind, fromSeat, calledTileIndex, tiles } = event.payload.meld;
        if (kind === 'closed-kan') add(event, { type: 'ankan', actor, consumed: tiles.map(mjaiTile) });
        else if (kind === 'added-kan') add(event, { type: 'kakan', actor, pai: mjaiTile(tiles.at(-1)!) });
        else add(event, { type: kind === 'open-kan' ? 'daiminkan' : kind, actor, target: fromSeat,
          pai: mjaiTile(tiles[calledTileIndex!]!), consumed: tiles.filter((_tile, index) => index !== calledTileIndex).map(mjaiTile) });
        break;
      }
      case 'RiichiAccepted': add(event, { type: 'reach_accepted', actor: event.payload.actor }); break;
      case 'DoraRevealed': {
        requireThat(event.payload.indicators.length > doraCount, 'AKAGI_DORA_HISTORY_MISMATCH');
        for (const indicator of event.payload.indicators.slice(doraCount)) add(event, { type: 'dora', dora_marker: mjaiTile(indicator) });
        doraCount = event.payload.indicators.length;
        break;
      }
      case 'OperationOffered':
      case 'OperationClosed': break;
      default: throw Error('AKAGI_HISTORY_UNSUPPORTED');
    }
  }
  return events;
}

export function selectAkagiAction(snapshot: DecisionSnapshot, advice: Record<string, unknown>, dealerOpening: boolean): LegalAction {
  const codes = new Map(snapshot.state.ownConcealed.map(tile => [tile.instanceId, tile.code]));
  let matches = snapshot.legalActions.filter(({ action, authority }) => {
    if (authority !== 'executor' || action.kind !== advice.kind) return false;
    if (action.kind === 'discard' || action.kind === 'riichi-discard') {
      return codes.get(action.tile) === advice.tile &&
        (action.kind === 'riichi-discard' || (dealerOpening ? !action.tsumogiri : action.tsumogiri === advice.tsumogiri));
    }
    if (action.kind === 'pass') return true;
    if (!('consumed' in action)) return false;
    const consumed = action.consumed.map(id => codes.get(id)!);
    if (action.kind === 'closed-kan') return sameTiles(advice.tiles, consumed);
    if (action.kind === 'added-kan') return advice.addedTile === consumed[0] && sameTiles(advice.existingPon, action.tiles.slice(0, -1));
    return action.fromSeat === advice.fromSeat && action.tiles[action.calledTileIndex!] === advice.calledTile && sameTiles(advice.consumed, consumed);
  });
  // Reach advice names a rank that may differ in red-five identity from the
  // client's explicit allowlist. Prefer the exact physical color above; if it
  // is absent, another offered five of that suit preserves the riichi shape.
  // Never expand the allowlist or relax ordinary discard/call matching.
  if (!matches.length && advice.kind === 'riichi-discard' && typeof advice.tile === 'string' && /^5[mps]r?$/.test(advice.tile)) {
    const rank = advice.tile.replace('r', '');
    matches = snapshot.legalActions.filter(({ action, authority }) => authority === 'executor' && action.kind === 'riichi-discard' &&
      codes.get(action.tile)?.replace('r', '') === rank);
  }
  requireThat(matches.length > 0, 'AKAGI_ACTION_NOT_OFFERED');
  if (advice.kind === 'discard' || advice.kind === 'riichi-discard') {
    // Same-color copies with the same discard semantics are wire-equivalent.
    // For riichi the engine names a tile, and the authoritative drawn ref
    // distinguishes the preferred drawn copy from other copies of that tile.
    return matches.find(({ action }) => 'tsumogiri' in action && action.tsumogiri) ?? matches[0]!;
  }
  requireThat(matches.length === 1, 'AKAGI_ACTION_AMBIGUOUS');
  return matches[0]!;
}

export class AkagiRunner {
  #epoch = randomUUID();
  #child = spawn(fileURLToPath(new URL('../../../native/engine-runner/target/release/maji-engine-runner', import.meta.url)), [], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  #lines = createInterface({ input: this.#child.stdout });
  #pending: { resolve: (value: any) => void; reject: (error: Error) => void } | null = null;

  constructor() {
    this.#child.on('error', () => this.#pending?.reject(Error('AKAGI_RUNNER_UNAVAILABLE')));
    this.#child.stdin.on('error', () => this.#pending?.reject(Error('AKAGI_RUNNER_CLOSED')));
    this.#lines.on('close', () => this.#pending?.reject(Error('AKAGI_RUNNER_CLOSED')));
    this.#lines.on('line', line => {
      if (line.length > 64 * 1024) { this.#pending?.reject(Error('AKAGI_RESPONSE_LIMIT')); return; }
      try { this.#pending?.resolve(JSON.parse(line)); }
      catch { this.#pending?.reject(Error('AKAGI_INVALID_RESPONSE')); }
    });
  }

  async #call(method: string, params: object, scope: object, timeoutMs = 5_000) {
    const id = randomUUID();
    requireThat(!this.#pending && !this.#child.killed, 'AKAGI_RUNNER_UNAVAILABLE');
    const frame = JSON.stringify({ v: 1, id, runnerEpoch: this.#epoch, scope, method, params }) + '\n';
    requireThat(Buffer.byteLength(frame) <= 1024 * 1024, 'AKAGI_REQUEST_LIMIT');
    let timer: NodeJS.Timeout | undefined;
    try {
      const response = await new Promise<any>((resolve, reject) => {
        this.#pending = { resolve, reject };
        timer = setTimeout(() => reject(Error('AKAGI_TIMEOUT')), timeoutMs);
        this.#child.stdin.write(frame);
      });
      requireThat(response?.v === 1 && response.id === id && response.runnerEpoch === this.#epoch &&
        canonical(response.scope) === canonical(scope), 'AKAGI_RESPONSE_MISMATCH');
      if (response.ok === false) {
        const code = response.error?.code;
        throw Error(typeof code === 'string' && /^[A-Z][A-Z_0-9]+$/.test(code) ? code : 'AKAGI_RUNNER_FAILED');
      }
      requireThat(response.ok === true && response.result, 'AKAGI_INVALID_RESPONSE');
      return response.result;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
      this.#pending = null;
    }
  }

  async init() {
    const result = await this.#call('init', { protocolVersion: 1, sourceCommit: versions.akagiCommit, modelHash }, {}, 15_000);
    requireThat(result.engineVersion === versions.akagiCommit && result.modelHash === modelHash && result.rules?.includes(rules), 'AKAGI_VERSION_MISMATCH');
  }

  async decide(snapshot: DecisionSnapshot, history: readonly GameObservation[]) {
    const events = akagiHistory(history), first = history[0]!;
    requireThat(first.type === 'HandStarted' && first.payload.initialView.ownSeat === snapshot.state.ownSeat, 'AKAGI_HAND_MISMATCH');
    const scope = snapshot.scope, snapshotHash = `sha256:${digest(snapshot)}`;
    const reset = await this.#call('reset', { handId: scope.handId, ownSeat: snapshot.state.ownSeat, rules }, scope);
    requireThat(reset.cursor === 0, 'AKAGI_CURSOR_MISMATCH');
    const advanced = await this.#call('replay', { expectedCursor: 0, events }, scope);
    requireThat(advanced.cursor === events.length, 'AKAGI_CURSOR_MISMATCH');
    const reply = await this.#call('decide', { expectedCursor: events.length, stateVersion: snapshot.stateVersion, snapshotHash }, scope);
    requireThat(reply.cursor === events.length && reply.stateVersion === snapshot.stateVersion && reply.snapshotHash === snapshotHash &&
      reply.engineVersion === versions.akagiCommit && reply.modelHash === modelHash && reply.advice, 'AKAGI_DECISION_MISMATCH');
    return selectAkagiAction(snapshot, reply.advice, first.sourceCursor === snapshot.sourceCursor);
  }

  close() {
    this.#lines.close();
    this.#child.stdin.destroy();
    this.#child.kill();
  }
}
