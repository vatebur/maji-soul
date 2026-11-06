import { randomUUID } from 'node:crypto';
import { bridgeCall, type EgoPagePort } from '../adapters/majsoul/ego-transport.ts';
import type { GameActor } from '../application/game/actor.ts';
import type { FencedActionCommand } from '../domain/game/types.ts';
import { digest, requireThat } from '../domain/game/value.ts';

const errorCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)
  ? error.message : 'BOUNDARY_FENCE_CHALLENGE_FAILED';
const scope = (actor: GameActor) => {
  const p = actor.projection;
  return { gameMatchKey: p.gameMatchKey, gameHandKey: p.gameHandKey, handId: p.state?.handId ?? null,
    handOrdinal: p.handOrdinal, connectionEpoch: p.connectionEpoch, controlEpoch: actor.control.controlEpoch, sourceCursor: p.sourceCursor };
};

/** Arming errors specific to the optional timing and UI proof. Authority or
 * ledger errors still stop the run. */
export function isBoundaryProofFailure(error: unknown): boolean {
  return /^(?:COUNTDOWN_|TIMING_|AUTO_WIN_)/.test(errorCode(error));
}

type Armed = {
  before: ReturnType<typeof scope>;
  decisionId: string;
  permitSha256: string;
  permitExpiresAt: string;
  pageAtArm: { pageEpoch: number; sourceStream: number; step: number; paused: true; bridgeActionSends: 0 };
};

/** Holds the genuine Actor artifacts without constructing an executor or
 * calling any reserve, prepare or dispatch path. */
export class LiveBoundaryFenceChallenge {
  #report: { status: 'unarmed' } | { status: 'arming-failed'; code: string } |
    (Armed & ({ status: 'awaiting-new-hand' } | {
      status: 'passed' | 'failed';
      after: ReturnType<typeof scope>;
      decisionCode: string | null;
      permitCode: string | null;
    })) = { status: 'unarmed' };
  #held: FencedActionCommand | undefined;
  get report() { return structuredClone(this.#report); }
  failArming(error: unknown): void {
    this.#report = { status: 'arming-failed', code: errorCode(error) };
  }
  async arm(actor: GameActor, page: EgoPagePort, cursor: { pageEpoch: number; generation: number; lastStep: number }): Promise<void> {
    if (this.#report.status !== 'unarmed') return;
    try {
      await actor.resume();
      const decision = await actor.freezeDecision();
      const candidate = decision.legalActions.find(c => c.action.kind === 'discard' && c.action.tsumogiri);
      requireThat(candidate, 'ORDINARY_DRAW_REQUIRED');
      const command = actor.issuePermit(decision.id, candidate.id, `boundary-challenge-${randomUUID()}`);
      const current = await bridgeCall(page, 'read');
      requireThat(current.paused === true && current.controlEpoch === actor.control.controlEpoch &&
        current.connected === true && current.freshConnection === true && !current.reason && !current.overflow &&
        current.queued === 0 && current.pageEpoch === cursor.pageEpoch && current.generation === cursor.generation &&
        current.lastStep === cursor.lastStep && Number.isSafeInteger(current.sourceStream) && current.sourceStream >= 0 &&
        current.stats?.bridgeActionSends === 0, 'BOUNDARY_PAGE_SCOPE_UNVERIFIED');
      this.#held = command;
      this.#report = { status: 'awaiting-new-hand', before: scope(actor), decisionId: decision.id,
        permitSha256: digest(command), permitExpiresAt: command.expiresAt,
        pageAtArm: { pageEpoch: current.pageEpoch, sourceStream: current.sourceStream, step: current.lastStep, paused: true, bridgeActionSends: 0 } };
    } catch (error) {
      this.failArming(error);
      if (!actor.control.paused) actor.suspendForBoundary();
      await actor.awaitControlBarrier();
    }
  }
  checkAfterHandStart(actor: GameActor): void {
    if (!this.#held || this.#report.status !== 'awaiting-new-hand') return;
    const { before } = this.#report;
    const after = scope(actor);
    if (after.gameHandKey === before.gameHandKey) return;
    const rejectCode = (check: () => unknown) => {
      try { check(); return null; }
      catch (error) { return errorCode(error); }
    };
    const command = this.#held;
    this.#held = undefined;
    const decisionCode = rejectCode(() => actor.decision(command.fence.decisionId));
    const permitCode = rejectCode(() => actor.consumePermit(command));
    const passed = after.gameMatchKey === before.gameMatchKey && after.connectionEpoch === before.connectionEpoch &&
      after.handOrdinal > before.handOrdinal && after.controlEpoch > before.controlEpoch && actor.control.paused &&
      decisionCode === 'DECISION_STALE' && permitCode === 'PERMIT_INVALID';
    this.#report = { ...this.#report, status: passed ? 'passed' : 'failed', after, decisionCode, permitCode };
  }
}
