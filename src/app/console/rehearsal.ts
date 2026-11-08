import { initialProjection, reduceObservation } from '../../domain/game/reducer.ts';
import type { GameObservation, GameProjection } from '../../domain/game/types.ts';
import { digest, requireThat } from '../../domain/game/value.ts';
import type { loadReplay } from '../replay.ts';

type Fixture = Awaited<ReturnType<typeof loadReplay>>;
export function prepareRehearsal(fixture: Fixture) {
  const originalId = fixture.manifest.sessionId as string;
  let original = initialProjection(originalId);
  const events = fixture.events.map(event => {
    const refs = event.type === 'OperationOffered' || event.type === 'MeldDeclared'
      ? original.state?.ownConcealed.map(tile => tile.instanceId) ?? [] : [];
    original = reduceObservation(original, event);
    return { event, refs };
  });
  return (projection: GameProjection): GameObservation | null => {
    const entry = events[projection.sequence];
    if (!entry) return null;
    const { event, refs } = entry;
    const tileRef = (id: string) => {
      const tile = projection.state?.ownConcealed[refs.indexOf(id)];
      requireThat(tile, 'REPLAY_TILE_REF_MISMATCH');
      return tile.instanceId;
    };
    const prefix = `${originalId}:event:`;
    const eventRef = (id: string) => id.startsWith(prefix) ? `${projection.sessionId}:event:${id.slice(prefix.length)}` : id;
    switch (event.type) {
      case 'MatchStarted':
        return { ...event, payload: { ...event.payload, gameMatchKey: `rehearsal-${digest([projection.sessionId, event.payload.gameMatchKey])}` } };
      case 'OperationOffered': {
        const copy = structuredClone(event), window = copy.payload.window;
        if (window.deadline.known) window.deadline.value.sourceEventId = eventRef(window.deadline.value.sourceEventId);
        for (const candidate of window.candidates) {
          const action = candidate.action;
          candidate.evidenceEventIds = candidate.evidenceEventIds.map(eventRef);
          if (action.kind === 'discard' || action.kind === 'riichi-discard') action.tile = tileRef(action.tile);
          else if ('consumed' in action) action.consumed = action.consumed.map(tileRef);
        }
        return copy;
      }
      case 'MeldDeclared':
        return { ...event, payload: { ...event.payload, consumed: event.payload.consumed.map(tileRef) } };
      default: return event;
    }
  };
}
