import type { GameObservation, ObservationPayloads, Scores, Seat } from '../../domain/game/types.ts';
import { reduceObservation, seats } from '../../domain/game/reducer.ts';
import { canonical, digest, requireThat } from '../../domain/game/value.ts';
import { integer, parseObservation, timestamp } from '../../schemas/game.ts';
import type { NormalizeContext } from './normalize.ts';

function record(value: unknown): Record<string, any> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_PROTOCOL_OBJECT');
  return value as Record<string, any>;
}
function scoreArray(value: unknown): number[] {
  requireThat(Array.isArray(value) && value.length === 4, 'INVALID_PROTOCOL_SCORES');
  value.forEach(v => integer(v, -100_000, 1_000_000));
  return value;
}
const scoreMap = (value: number[]) => Object.fromEntries(seats.map(s => [s,value[s]!])) as Scores;
const sameScores = (a: number[], b: number[]) => canonical(a) === canonical(b);

/** The protocol sends complete round settlement, not a candidate or a client RPC receipt. */
export function normalizeHandEnd(name: string, payload: unknown, context: NormalizeContext): GameObservation[] {
  requireThat(['ActionHule','ActionNoTile','ActionLiuJu'].includes(name), 'UNSUPPORTED_PROTOCOL_ACTION');
  const input = record(payload), current = context.projection;
  integer(context.step,0,999_999_999); integer(context.connectionEpoch); timestamp(context.receivedAt);
  requireThat(current.state?.trust === 'trusted' && current.handStatus === 'playing' && current.matchStatus === 'playing' && current.connectionEpoch === context.connectionEpoch,
    'NORMALIZER_STATE_UNTRUSTED');
  for (const field of ['muyu','hun_zhi_yi_ji_info','yongchang','xia_ke_shang']) requireThat(input[field] === undefined || input[field] === null, 'UNSUPPORTED_PROTOCOL_TRANSITION');
  requireThat(input.hules_history === undefined || Array.isArray(input.hules_history) && input.hules_history.length === 0, 'UNSUPPORTED_PROTOCOL_VARIANT');
  requireThat(input.baopai === undefined || input.baopai === 0, 'UNSUPPORTED_PROTOCOL_VARIANT');
  const observations: GameObservation[] = [], cursor = `${context.sourceStream}:${context.step}`;
  let projected = current;
  const append = (type: GameObservation['type'], data: unknown, suffix: string, carriesCursor = false) => {
    const observation = parseObservation({ schemaVersion:1,
      observationId:`observation-${digest([context.connectionEpoch,cursor,suffix]).slice(0,24)}`,
      connectionEpoch:context.connectionEpoch,source:context.source ?? 'majsoul-network',
      sourceDedupKey:`${cursor}:${suffix}`,receivedAt:context.receivedAt,
      ...(carriesCursor ? {sourceCursor:cursor} : {}),type,payload:data });
    projected = reduceObservation(projected,observation); observations.push(observation);
  };
  // Abortive draws can carry the final explicit riichi deposit. It must be
  // settled before the unchanged-points abortive result is taken from state.
  if (input.liqi !== undefined && input.liqi !== null) {
    requireThat(name === 'ActionLiuJu', 'UNSUPPORTED_PROTOCOL_TRANSITION');
    const liqi = record(input.liqi); integer(liqi.seat,0,3); integer(liqi.score,-100_000,1_000_000); integer(liqi.liqibang,0,100);
    requireThat(liqi.failed === false && (liqi.liqi_type_beishuizhizhan === undefined || liqi.liqi_type_beishuizhizhan === 0), 'UNSUPPORTED_RIICHI_RESULT');
    const scores = scoreMap(seats.map(s => projected.state!.players[s].score)), actor = liqi.seat as Seat;
    requireThat(liqi.score === scores[actor]-1000 && liqi.liqibang === projected.state!.riichiSticks+1, 'RIICHI_SCORE_MISMATCH');
    scores[actor] = liqi.score; append('RiichiAccepted',{actor,scores,riichiSticks:liqi.liqibang},'riichi-accepted');
  }
  const before = seats.map(s => projected.state!.players[s].score);
  let after: number[], reason: ObservationPayloads['HandEnded']['reason'], winners: Seat[] = [], resultLabel: string;
  if (name === 'ActionHule') {
    const old = scoreArray(input.old_scores), deltas = scoreArray(input.delta_scores);
    after = scoreArray(input.scores);
    requireThat(sameScores(old,before) && after.every((score,s) => score === old[s]!+deltas[s]!), 'SETTLEMENT_SCORE_MISMATCH');
    requireThat(Array.isArray(input.hules) && input.hules.length > 0 && input.hules.length <= 3, 'INVALID_HULE_RESULT');
    const hules = input.hules.map(record);
    for (const hule of hules) { integer(hule.seat,0,3); requireThat(typeof hule.zimo === 'boolean','PROTOCOL_BOOLEAN_MISSING'); }
    winners = hules.map(hule => hule.seat as Seat);
    requireThat(new Set(winners).size === winners.length && (!hules.some(h => h.zimo) || hules.length === 1), 'INVALID_HULE_RESULT');
    reason = 'win'; resultLabel = hules[0]!.zimo ? '自摸' : winners.length > 1 ? '多家荣和' : '荣和';
  } else if (name === 'ActionNoTile') {
    requireThat(typeof input.liujumanguan === 'boolean' && typeof input.gameend === 'boolean', 'PROTOCOL_BOOLEAN_MISSING');
    requireThat(Array.isArray(input.scores) && input.scores.length <= 4, 'INVALID_PROTOCOL_SCORES');
    const entries = input.scores.map(record);
    // Each component carries a complete old-score vector. The upstream fixed
    // implementation sums components; never overwrite an earlier component.
    const deltas = entries.map(entry => {
      integer(entry.seat,0,3);
      requireThat(sameScores(scoreArray(entry.old_scores),before),'SETTLEMENT_SCORE_MISMATCH');
      // Standard exhaustive draws with no point transfer carry an empty
      // repeated delta field. The complete old-score vector still must match.
      if (!input.liujumanguan && Array.isArray(entry.delta_scores) && entry.delta_scores.length === 0) return [0,0,0,0];
      return scoreArray(entry.delta_scores);
    });
    after = before.map((score,seat) => score+deltas.reduce((sum,delta) => sum+delta[seat]!,0));
    scoreArray(after); reason = 'draw'; resultLabel = input.liujumanguan ? '荒牌流局（流局满贯）' : '荒牌流局';
  } else {
    integer(input.type,0,1000); integer(input.seat,0,3);
    // The standard-riichi ActionLiuJu schema has no score deltas. Preserve
    // known scores after any explicit LiQiSuccess, without guessing its cause.
    after = before; reason = 'abortive-draw'; resultLabel = `途中流局（${input.type}）`;
  }
  let matchEnded = name === 'ActionNoTile' ? input.gameend : false;
  if (name !== 'ActionNoTile' && input.gameend !== undefined && input.gameend !== null) {
    scoreArray(record(input.gameend).scores); matchEnded = true;
  }
  append('HandEnded',{scores:scoreMap(after),reason,winners,resultLabel,...(matchEnded ? {matchEnded:true} : {})},'hand-ended',true);
  return observations;
}

export type MatchEndContext = Pick<NormalizeContext,'projection'|'receivedAt'|'connectionEpoch'|'source'>;

/** Fixed upstream parse_game_end_standings documents players in placement order;
 * part_point_1 is raw final points. Never sort totals or invent a tie breaker. */
export function normalizeMatchEnd(payload: unknown, context: MatchEndContext): GameObservation[] {
  const input = record(payload), result = record(input.result), p = context.projection;
  requireThat(p.gameMatchKey && p.gameHandKey && p.state && p.handStatus === 'finished' && ['playing','finished'].includes(p.matchStatus) && p.connectionEpoch === context.connectionEpoch, 'MATCH_RESULT_WITHOUT_HAND_END');
  timestamp(context.receivedAt);
  requireThat(Array.isArray(result.players) && result.players.length === 4, 'INVALID_FINAL_STANDINGS');
  const players = result.players.map(record), scores = {} as Scores, ranks = {} as Scores;
  for (const [index,player] of players.entries()) {
    integer(player.seat,0,3); integer(player.part_point_1,-100_000,1_000_000);
    requireThat(!Object.hasOwn(scores,player.seat), 'INVALID_FINAL_STANDINGS');
    scores[player.seat as Seat] = player.part_point_1; ranks[player.seat as Seat] = index+1;
  }
  const body = {scores,ranks};
  if (p.matchStatus === 'finished') {
    requireThat(p.matchResult && canonical(body) === canonical(p.matchResult), 'MATCH_RESULT_CONFLICT');
    return [];
  }
  const key = `match-result-${digest([p.gameMatchKey,p.gameHandKey,body]).slice(0,32)}`;
  const event = parseObservation({schemaVersion:1,observationId:`observation-${digest([context.connectionEpoch,key]).slice(0,24)}`,
    connectionEpoch:context.connectionEpoch,source:context.source ?? 'majsoul-network',sourceDedupKey:key,
    receivedAt:context.receivedAt,type:'MatchEnded',payload:body});
  reduceObservation(p,event);
  return [event];
}
