import type { AuthoritativeSync, GameObservation, GameProjection } from '../../domain/game/types.ts';
import { requireThat } from '../../domain/game/value.ts';
import { GameActor } from './actor.ts';

/** Coordinates verified lifecycle facts. It neither chooses actions nor starts
 * a new game; browser recovery must supply fresh authoritative synchronization. */
export class GameCoordinator {
  readonly actor: GameActor;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(actor: GameActor) { this.actor=actor; }

  /** A dealer repeat is still a new hand. Counters and wall clocks never establish
   * identity; the caller supplies the verified game UUID/opening commitment key. */
  async resolveHandOrdinal(gameMatchKey: string, gameHandKey: string): Promise<number> {
    requireThat(gameMatchKey.length>0 && gameHandKey.length>0, 'HAND_IDENTITY_UNVERIFIED');
    const ledger=await this.actor.storage.inspectMatch(gameMatchKey);
    const existing=ledger.hands.find(h=>h.gameHandKey===gameHandKey), latest=ledger.hands.at(-1);
    if (existing) {
      requireThat(existing.ordinal===latest?.ordinal,'HAND_LEDGER_STALE');
      return existing.ordinal;
    }
    requireThat(ledger.matchStatus!=='finished' && ledger.matchStatus!=='pending-result','MATCH_LEDGER_TERMINAL');
    return (latest?.ordinal ?? 0)+1;
  }

  ingest(observations: GameObservation[]): Promise<GameProjection> {
    const copies=structuredClone(observations);
    // Revoke now, before this coordinator's own queue or any SQLite response.
    if (copies.some(o=>o.connectionEpoch>=this.actor.projection.connectionEpoch && ['HandStarted','HandEnded','MatchEnded'].includes(o.type))) this.actor.suspendForBoundary();
    return this.#enqueue(async()=>{
      for (const observation of copies) await this.actor.ingest(observation);
      await this.actor.awaitControlBarrier();
      return this.actor.projection;
    });
  }

  applySync(sync: AuthoritativeSync): Promise<GameProjection> {
    const copy=structuredClone(sync);
    return this.#enqueue(async()=>{
      const projection=await this.actor.applySync(copy);
      await this.actor.awaitControlBarrier();
      return projection;
    });
  }

  async resume(): Promise<void> {
    await this.#tail;
    await this.actor.resume();
  }
  async idle(): Promise<void> { await this.#tail; await this.actor.idle(); }
  #enqueue<T>(work:()=>Promise<T>):Promise<T> {
    const next=this.#tail.then(work);
    this.#tail=next.catch(()=>{});
    return next;
  }
}
