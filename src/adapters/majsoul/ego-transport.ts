import type { ProductionTransport } from '../../application/game/executor.ts';
import type { ActorControl } from '../../application/game/actor.ts';
import type { ActionAttempt, CallReceipt, DecisionSnapshot, FencedActionCommand, LegalAction } from '../../domain/game/types.ts';
import { canonical, requireThat } from '../../domain/game/value.ts';
import type { ProtocolOperationTiming } from './operation-timing.ts';
import type { BrowserPagePort } from '../../ports/browser.ts';

/** Compatibility name for existing game adapters and ego callers. */
export type EgoPagePort = BrowserPagePort;
export interface PageCursor { generation: number; pageEpoch: number; step: number }
export interface AutoWinHandScope extends PageCursor { sourceStream: number }
export function bridgeCall(page: EgoPagePort, method: string, argument?: unknown): Promise<any> {
  requireThat(['read', 'drain', 'pause', 'sync', 'ackSync', 'prepare', 'dispatch', 'dispatchPrepared', 'reconnect', 'restore', 'ackAutoWin', 'ackTiming', 'ensureAutoWin', 'verifyAutoWin', 'automaticTiming', 'releaseAkagi', 'startNextMatch', 'inspectRoom', 'clearRoomRobots', 'fillRoom', 'abandonOwnedRoom'].includes(method), 'BRIDGE_METHOD_INVALID');
  if (method === 'ensureAutoWin' && argument != null) {
    const options=argument as {purpose?:unknown;expected?:AutoWinHandScope},expected=options.expected;
    requireThat(typeof argument==='object' && !Array.isArray(argument) && Object.hasOwn(argument,'purpose') &&
      (Object.keys(argument).length===1 && options.purpose==='reconnect' ||
       Object.keys(argument).length===2 && Object.hasOwn(argument,'expected') && options.purpose==='new-hand' && expected && typeof expected==='object' && !Array.isArray(expected) &&
       Object.keys(expected).length===4 && ['pageEpoch','sourceStream','generation','step'].every(key=>
         Object.hasOwn(expected,key) && Number.isSafeInteger(expected[key as keyof AutoWinHandScope]) && expected[key as keyof AutoWinHandScope]>=0) && expected.pageEpoch>0),
    'AUTO_WIN_PURPOSE_INVALID');
  }
  // The ego helper owns CDP; the pinned child forwards these bounded operations
  // over the same whitelist instead of creating another browser or OCR service.
  if (page.cdp && (method === 'ensureAutoWin' || method === 'verifyAutoWin')) {
    return import('./auto-win.ts').then(adapter => method === 'ensureAutoWin'
      ? adapter.ensureAutoWin(page,undefined,true,(argument as {purpose:'reconnect'|'new-hand'}|null)?.purpose ?? 'resume',
          (argument as {expected?:AutoWinHandScope}|null)?.expected,{nativeRecoveryRegion:true}) : adapter.verifyAutoWin(page,undefined,{atomicAck:true}));
  }
  if (page.cdp && method === 'automaticTiming') return import('./automatic-timing.ts').then(adapter => adapter.collectAutomaticTiming(page));
  return page.evaluate(async ({ method, argument }) => {
    try {
      const bridge = (window as unknown as { __majiBridge?: Record<string, (arg: unknown) => unknown> }).__majiBridge;
      if (!bridge) throw Error('BRIDGE_MISSING');
      return await bridge[method]!(argument);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { __majiBridgeError: /^[A-Z][A-Z_0-9]+$/.test(code) ? code : 'EGO_PAGE_FAILED' };
    }
  }, { method, argument: argument ?? null }).then(result => {
    if (typeof result?.__majiBridgeError === 'string') throw Error(result.__majiBridgeError);
    return result;
  });
}

/** A bounded, explicitly chosen single-discard transport, also used by live acceptance. */
export class EgoProductionTransport implements ProductionTransport {
  readonly kind = 'live' as const;
  readonly #page: EgoPagePort;
  #cursor: PageCursor | undefined;
  #timing: ProtocolOperationTiming | undefined;
  #bindingRevision = 0;
  #preflightRequest = 0;
  #preflight: { snapshot: string; intent: string; bindingRevision: number } | undefined;
  constructor(page: EgoPagePort) { this.#page = page; }
  bind(cursor: PageCursor, timing: ProtocolOperationTiming): void {
    requireThat(Number.isInteger(cursor.generation) && Number.isInteger(cursor.pageEpoch) && Number.isInteger(cursor.step), 'BRIDGE_CURSOR_INVALID');
    requireThat(timing.source === 'protocol-operation' && timing.origin === 'sync-game' && timing.pageEpoch === cursor.pageEpoch && timing.step === cursor.step && timing.remainingMs > timing.uncertaintyMs && Number.isFinite(Date.parse(timing.sampledAt)), 'COUNTDOWN_READBACK_REQUIRED');
    this.#bindingRevision++; this.#preflightRequest++; this.#preflight = undefined;
    this.#cursor = { ...cursor }; this.#timing = { ...timing };
  }
  async invalidate(control: ActorControl): Promise<void> {
    this.#bindingRevision++; this.#preflightRequest++; this.#preflight = undefined;
    await bridgeCall(this.#page, 'pause', control);
  }
  async preflight(snapshot: DecisionSnapshot, intent: ActionAttempt, signal?: AbortSignal): Promise<void> {
    this.#preflight = undefined;
    const request = ++this.#preflightRequest;
    requireThat(!signal?.aborted, 'FENCE_STALE');
    requireThat(this.#cursor && this.#timing, 'BRIDGE_NOT_BOUND');
    requireThat(intent.status === 'dispatching' && intent.executionMode === 'live' && intent.decisionId === snapshot.id,
      'DURABLE_INTENT_REQUIRED');
    const proof = { snapshot:canonical(snapshot),intent:canonical(intent),bindingRevision:this.#bindingRevision };
    await bridgeCall(this.#page, 'verifyAutoWin');
    requireThat(!signal?.aborted && this.#preflightRequest === request && this.#bindingRevision === proof.bindingRevision, 'FENCE_STALE');
    this.#preflight = proof;
  }
  async prepare(command: FencedActionCommand, snapshot: DecisionSnapshot, intent: ActionAttempt) {
    // Consume before any await or validation. A prior image can only avoid
    // another capture for this exact intent/snapshot and unchanged binding.
    const proof = this.#preflight; this.#preflight = undefined; this.#preflightRequest++;
    requireThat(this.#cursor && this.#timing, 'BRIDGE_NOT_BOUND');
    const action = snapshot.legalActions.find(a => a.id === command.actionId);
    requireThat(action && action.authority === 'executor' && action.action.kind !== 'tsumo' && action.action.kind !== 'ron', 'UNSUPPORTED_LIVE_ACTION');
    // Resolve the exact physical tile from the immutable decision, including red fives.
    const spec = action.action;
    requireThat(intent.status === 'dispatching' && intent.executionMode === 'live' && canonical(intent.actionSpec) === canonical(spec), 'DURABLE_INTENT_REQUIRED');
    let tile: string | undefined;
    if (spec.kind === 'discard' || spec.kind === 'riichi-discard') {
      const physical = snapshot.state.ownConcealed.find(t => t.instanceId === spec.tile);
      requireThat(physical, 'ACTION_NOT_LEGAL');
      tile = physical.code.endsWith('r') ? `0${physical.code[1]}` : physical.code;
    }
    // Direct prepare callers keep their fresh read. Preflight callers retain
    // the same original 1s visual expiry, checked by the final page send fence.
    const matched = proof && proof.bindingRevision === this.#bindingRevision && proof.snapshot === canonical(snapshot) &&
      proof.intent === canonical(intent);
    const input = { command, snapshot, intent, action, ...(tile ? { tile } : {}), expected: this.#cursor, timing: this.#timing };
    if (matched) {
      let consumed = false;
      return async (selected: LegalAction): Promise<CallReceipt> => {
        requireThat(!consumed, 'PERMIT_INVALID'); consumed = true;
        requireThat(canonical(selected) === canonical(action), 'ACTION_CHANGED');
        // The executor has just rechecked SQLite and consumed its short permit.
        // Prepare and final dispatch now share one page turn, so no extra IPC or
        // database wait consumes the remaining original 1s pixel lifetime.
        return await bridgeCall(this.#page, 'dispatchPrepared', input) as CallReceipt;
      };
    }
    await bridgeCall(this.#page, 'verifyAutoWin');
    const prepared = await bridgeCall(this.#page, 'prepare', input);
    const token = typeof prepared === 'string' ? prepared : prepared.token;
    requireThat(typeof token === 'string', 'BRIDGE_PERMIT_INVALID');
    return async (selected: LegalAction): Promise<CallReceipt> => {
      requireThat(canonical(selected) === canonical(action), 'ACTION_CHANGED');
      return await bridgeCall(this.#page, 'dispatch', { command, token }) as CallReceipt;
    };
  }
}
