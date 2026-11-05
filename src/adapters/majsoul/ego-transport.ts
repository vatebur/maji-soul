import type { ProductionTransport } from '../../application/game/executor.ts';
import type { ActorControl } from '../../application/game/actor.ts';
import type { ActionAttempt, CallReceipt, DecisionSnapshot, FencedActionCommand, LegalAction } from '../../domain/game/types.ts';
import { canonical, requireThat } from '../../domain/game/value.ts';
import type { ProtocolOperationTiming } from './operation-timing.ts';

/** The documented ego Page API is supplied by the caller; no browser is launched here. */
export interface EgoPagePort {
  evaluate(source: string | ((argument: any) => any), argument?: any): Promise<any>;
  cdp?(method: string, parameters?: any): Promise<any>;
  reload?(): Promise<any>;
}
export interface PageCursor { generation: number; pageEpoch: number; step: number }
export function bridgeCall(page: EgoPagePort, method: string, argument?: unknown): Promise<any> {
  requireThat(['read', 'drain', 'pause', 'sync', 'ackSync', 'prepare', 'dispatch', 'reconnect', 'restore', 'ackAutoWin', 'ackTiming', 'ensureAutoWin', 'verifyAutoWin', 'automaticTiming'].includes(method), 'BRIDGE_METHOD_INVALID');
  if (method === 'ensureAutoWin') requireThat(argument == null || typeof argument === 'object' && !Array.isArray(argument) &&
    Object.keys(argument).length === 1 && (argument as {purpose?:unknown}).purpose === 'reconnect', 'AUTO_WIN_PURPOSE_INVALID');
  // The ego helper owns CDP; the pinned child forwards these bounded operations
  // over the same whitelist instead of creating another browser or OCR service.
  if (page.cdp && (method === 'ensureAutoWin' || method === 'verifyAutoWin')) {
    return import('./auto-win.ts').then(adapter => method === 'ensureAutoWin'
      ? adapter.ensureAutoWin(page,undefined,true,argument ? 'reconnect':'resume') : adapter.verifyAutoWin(page));
  }
  if (page.cdp && method === 'automaticTiming') return import('./automatic-timing.ts').then(adapter => adapter.collectAutomaticTiming(page));
  return page.evaluate(({ method, argument }) => {
    const bridge = (window as unknown as { __majiBridge?: Record<string, (arg: unknown) => unknown> }).__majiBridge;
    if (!bridge) throw Error('BRIDGE_MISSING'); return bridge[method]!(argument);
  }, { method, argument: argument ?? null });
}

/** A bounded, explicitly chosen single-discard transport, also used by live acceptance. */
export class EgoProductionTransport implements ProductionTransport {
  readonly kind = 'live' as const;
  readonly #page: EgoPagePort;
  #cursor: PageCursor | undefined;
  #timing: ProtocolOperationTiming | undefined;
  constructor(page: EgoPagePort) { this.#page = page; }
  bind(cursor: PageCursor, timing: ProtocolOperationTiming): void {
    requireThat(Number.isInteger(cursor.generation) && Number.isInteger(cursor.pageEpoch) && Number.isInteger(cursor.step), 'BRIDGE_CURSOR_INVALID');
    requireThat(timing.source === 'protocol-operation' && timing.origin === 'sync-game' && timing.pageEpoch === cursor.pageEpoch && timing.step === cursor.step && timing.remainingMs > timing.uncertaintyMs && Number.isFinite(Date.parse(timing.sampledAt)), 'COUNTDOWN_READBACK_REQUIRED');
    this.#cursor = { ...cursor }; this.#timing = { ...timing };
  }
  async invalidate(control: ActorControl): Promise<void> {
    await bridgeCall(this.#page, 'pause', control);
  }
  async prepare(command: FencedActionCommand, snapshot: DecisionSnapshot, intent: ActionAttempt) {
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
    // Fresh visual readback is checked again in the synchronous page send fence.
    await bridgeCall(this.#page, 'verifyAutoWin');
    const prepared = await bridgeCall(this.#page, 'prepare', { command, snapshot, intent, action, ...(tile ? { tile } : {}),
      expected: this.#cursor, timing: this.#timing });
    const token = typeof prepared === 'string' ? prepared : prepared.token;
    requireThat(typeof token === 'string', 'BRIDGE_PERMIT_INVALID');
    return async (selected: LegalAction): Promise<CallReceipt> => {
      requireThat(canonical(selected) === canonical(action), 'ACTION_CHANGED');
      return await bridgeCall(this.#page, 'dispatch', { command, token }) as CallReceipt;
    };
  }
}
