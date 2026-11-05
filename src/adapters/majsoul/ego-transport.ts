import type { ProductionTransport } from '../../application/game/executor.ts';
import type { ActorControl } from '../../application/game/actor.ts';
import type { ActionAttempt, CallReceipt, DecisionSnapshot, FencedActionCommand, LegalAction } from '../../domain/game/types.ts';
import { canonical, requireThat } from '../../domain/game/value.ts';

/** The documented ego Page API is supplied by the caller; no browser is launched here. */
export interface EgoPagePort {
  evaluate(source: string | ((argument: any) => any), argument?: any): Promise<any>;
  cdp?(method: string, parameters?: any): Promise<any>;
  reload?(): Promise<any>;
}
export interface PageCursor { generation: number; pageEpoch: number; step: number }
export interface ManualCountdown {
  source: 'manual-client-countdown'; budgetMs: number; observedAt: string;
}
export function bridgeCall(page: EgoPagePort, method: string, argument?: unknown): Promise<any> {
  requireThat(['read', 'drain', 'pause', 'sync', 'ackSync', 'prepare', 'dispatch', 'reconnect', 'restore'].includes(method), 'BRIDGE_METHOD_INVALID');
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
  #timing: ManualCountdown | undefined;
  constructor(page: EgoPagePort) { this.#page = page; }
  bind(cursor: PageCursor, timing: ManualCountdown): void {
    requireThat(Number.isInteger(cursor.generation) && Number.isInteger(cursor.pageEpoch) && Number.isInteger(cursor.step), 'BRIDGE_CURSOR_INVALID');
    requireThat(timing.source === 'manual-client-countdown' && timing.budgetMs > 0 && timing.budgetMs <= 30_000 && Number.isFinite(Date.parse(timing.observedAt)), 'COUNTDOWN_READBACK_REQUIRED');
    this.#cursor = { ...cursor }; this.#timing = { ...timing };
  }
  async invalidate(control: ActorControl): Promise<void> {
    await bridgeCall(this.#page, 'pause', control);
  }
  async prepare(command: FencedActionCommand, snapshot: DecisionSnapshot, intent: ActionAttempt) {
    requireThat(this.#cursor && this.#timing, 'BRIDGE_NOT_BOUND');
    const action = snapshot.legalActions.find(a => a.id === command.actionId);
    requireThat(action?.action.kind === 'discard', 'UNSUPPORTED_LIVE_ACTION');
    // Resolve the exact physical tile from the immutable decision, including red fives.
    const spec = action.action;
    const physical = snapshot.state.ownConcealed.find(t => t.instanceId === spec.tile);
    requireThat(physical && intent.status === 'dispatching' && intent.executionMode === 'live', 'DURABLE_INTENT_REQUIRED');
    const protocolTile = physical.code.endsWith('r') ? `0${physical.code[1]}` : physical.code;
    const prepared = await bridgeCall(this.#page, 'prepare', { command, snapshot, intent, action, tile: protocolTile,
      expected: this.#cursor, timing: this.#timing });
    const token = typeof prepared === 'string' ? prepared : prepared.token;
    requireThat(typeof token === 'string', 'BRIDGE_PERMIT_INVALID');
    return async (selected: LegalAction): Promise<CallReceipt> => {
      requireThat(canonical(selected) === canonical(action), 'ACTION_CHANGED');
      return await bridgeCall(this.#page, 'dispatch', { command, token }) as CallReceipt;
    };
  }
}
