// Private acceptance helper. No browser API, game RPC, database write, timer or
// automatic loop lives here. The host owns capture, one gesture, and its audit.
import { digest, canonical } from '../../src/domain/game/value.ts';
import { handSourceStream } from '../../src/adapters/majsoul/sync.ts';
import { legalOperationActions, mapActionToRequest } from '../../src/adapters/majsoul/actions.ts';

const requireThat=(value,code)=>{if(!value)throw Error(code);};
const clone=value=>structuredClone(value);
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const SHA=/^[a-f0-9]{64}$/;
const indexes=Array.from({length:34},(_,i)=>i<27?`${i%9+1}${'mps'[Math.floor(i/9)]}`:`${i-26}z`);
const orphans=[0,8,9,17,18,26,27,28,29,30,31,32,33];
const scopeKeys=['pageEpoch','sourceStream','generation','step','controlEpoch','nativeRestoreRevision'];
const wait=code=>({kind:'wait',code});
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value??{},key)).map(key=>[key,clone(value[key])]));

function visibleState(input) {
  const state=pick(input,['sessionId','matchId','handId','connectionEpoch','stateVersion','trust','trustIssues','ownSeat',
    'drawnTileRef','currentActor','dealer','roundWind','seatWind','handNumber','honba','riichiSticks','doraIndicators','doraTiles','tilesRemaining','unknownFields']);
  state.ownConcealed=input.ownConcealed.map(tile=>pick(tile,['instanceId','code']));
  state.players=Object.fromEntries([0,1,2,3].map(seat=>{
    const player=input.players[seat],publicPlayer=pick(player,['seat','score','riichi','concealedCount']);
    publicPlayer.river=player.river.map(tile=>pick(tile,['tile','tsumogiri','riichiDeclaration','calledBy','eventId']));
    publicPlayer.melds=player.melds.map(meld=>pick(meld,['id','actor','kind','tiles','fromSeat','calledTileIndex','upgradedFrom']));
    return [seat,publicPlayer];
  }));
  if(input.latestAction)state.latestAction=pick(input.latestAction,['eventId','handId','actor','kind','tiles','tsumogiri','origin','observedAt','riichiDeclaration','meld']);
  if(input.operationWindow){
    state.operationWindow=pick(input.operationWindow,['id','connectionEpoch','openedAt','deadline','status']);
    state.operationWindow.candidates=input.operationWindow.candidates.map(candidate=>({...pick(candidate,['id','authority','label','evidenceEventIds']),
      action:pick(candidate.action,['kind','tile','tsumogiri','consumed','tiles','operation','fromSeat','calledTileIndex','upgradedFrom'])}));
  }
  return state;
}

function tileIndex(code) {
  requireThat(typeof code==='string'&&/^(?:[1-9][mps]|[1-7]z|5[mps]r)$/.test(code),'UI_TILE_INVALID');
  return code[1]==='z'?27+Number(code[0])-1:'mps'.indexOf(code[1])*9+Number(code[0])-1;
}
function countsOf(codes) {
  requireThat(Array.isArray(codes)&&codes.length<=14,'UI_HAND_INVALID');
  const counts=Array(34).fill(0);
  for(const code of codes)requireThat(++counts[tileIndex(code)]<=4,'UI_TILE_MULTIPLICITY');
  return counts;
}

/** Exact decomposition for a closed hand; no opponent tile information is used. */
function shantenEvaluator() {
  const groups=new Map(),hands=new Map();
  function profiles(input,suited) {
    const key=`${suited?1:0}:${input.join('')}`;
    if(groups.has(key))return groups.get(key);
    const i=input.findIndex(n=>n>0);
    if(i<0)return [[0,0,0]];
    const output=new Map();
    const branch=(removed,dm,dt,dp)=>{
      const rest=[...input];for(const index of removed)rest[index]--;
      for(const [m,t,p]of profiles(rest,suited))if(m+dm<=4&&t+dt<=4&&p+dp<=1)
        output.set(`${m+dm}/${t+dt}/${p+dp}`,[m+dm,t+dt,p+dp]);
    };
    branch([i],0,0,0);
    if(input[i]>=3)branch([i,i,i],1,0,0);
    if(input[i]>=2){branch([i,i],0,1,0);branch([i,i],0,0,1);}
    if(suited){
      if(i<7&&input[i+1]&&input[i+2])branch([i,i+1,i+2],1,0,0);
      if(i<8&&input[i+1])branch([i,i+1],0,1,0);
      if(i<7&&input[i+2])branch([i,i+2],0,1,0);
    }
    const result=[...output.values()];groups.set(key,result);return result;
  }
  return counts=>{
    const key=counts.join('');if(hands.has(key))return hands.get(key);
    let combined=[[0,0,0]];
    for(const [start,end,suited]of [[0,9,true],[9,18,true],[18,27,true],[27,34,false]]){
      const next=new Map();
      for(const [m,t,p]of combined)for(const [a,b,c]of profiles(counts.slice(start,end),suited))
        if(m+a<=4&&p+c<=1)next.set(`${m+a}/${Math.min(4,t+b)}/${p+c}`,[m+a,Math.min(4,t+b),p+c]);
      combined=[...next.values()];
    }
    const standard=Math.min(...combined.map(([m,t,p])=>8-2*m-Math.min(t,4-m)-p));
    const pairs=counts.filter(n=>n>=2).length,distinct=counts.filter(n=>n>0).length;
    const sevenPairs=6-pairs+Math.max(0,7-distinct);
    const thirteenOrphans=13-orphans.filter(i=>counts[i]>0).length-(orphans.some(i=>counts[i]>=2)?1:0);
    const result={standard,sevenPairs,thirteenOrphans,minimum:Math.min(standard,sevenPairs,thirteenOrphans)};
    hands.set(key,result);return result;
  };
}
export function closedShanten(codes) {
  requireThat(Array.isArray(codes)&&[13,14].includes(codes.length),'UI_HAND_INVALID');
  return shantenEvaluator()(countsOf(codes));
}

export function pageScope(page) {
  const scope={pageEpoch:page?.pageEpoch,sourceStream:page?.sourceStream,generation:page?.generation,
    step:page?.lastStep,controlEpoch:page?.controlEpoch,nativeRestoreRevision:page?.nativeRestoreRevision};
  requireThat(scopeKeys.every(key=>integer(scope[key],key==='pageEpoch'?1:0)),'UI_SCOPE_INVALID');
  return scope;
}
function identity(page) {
  requireThat(typeof page?.gameUuid==='string'&&page.gameUuid.length>0&&SHA.test(page.handSha256??''),'UI_HAND_IDENTITY_REQUIRED');
  const gameMatchKey=`game-${digest(page.gameUuid).slice(0,32)}`;
  const gameHandKey=`hand-${digest([gameMatchKey,page.handSha256]).slice(0,32)}`;
  return {gameMatchKey,gameHandKey,sourceCursor:`${handSourceStream(gameMatchKey,gameHandKey)}:${page.lastStep}`};
}
function assertPageIdle(page) {
  pageScope(page);
  requireThat(page.paused===true&&page.connected===true&&page.freshConnection===true&&
    !page.reason&&!page.overflow&&page.queued===0&&page.phase2ActionsEnabled===false,'UI_PAGE_NOT_IDLE');
  requireThat(!page.handEnded&&!page.matchEnded,'UI_HAND_NOT_PLAYING');
  requireThat(page.operation?.step===page.lastStep&&page.operation.value?.seat===page.ownSeat&&
    Array.isArray(page.operation.value.operation_list)&&page.operation.value.operation_list.length>0,'UI_OWN_OFFER_REQUIRED');
  requireThat(!page.operation.value.operation_list.some(op=>op.type===8||op.type===9),'CLIENT_AUTO_WIN_WINDOW');
  requireThat(!(page.lastClientWin?.pageEpoch===page.pageEpoch&&page.lastClientWin?.sourceStream===page.sourceStream),'UI_CLIENT_WIN_IN_FLIGHT');
}
function assertProof(page) {
  const proof=page.autoWin,last=page.lastAutoWinReadback;
  requireThat(proof?.state==='enabled'&&proof.pageEpoch===page.pageEpoch&&proof.generation===page.generation&&
    proof.step===page.lastStep&&proof.nativeRestoreRevision===page.nativeRestoreRevision&&proof.expiresInMs>0&&
    last?.state==='enabled'&&last.pageEpoch===page.pageEpoch&&last.sourceStream===page.sourceStream&&
    last.generation===page.generation&&last.step===page.lastStep&&last.nativeRestoreRevision===page.nativeRestoreRevision&&
    proof.rgbaSha256===last.rgbaSha256&&SHA.test(proof.rgbaSha256??''),'UI_FRESH_AUTO_WIN_PROOF_REQUIRED');
}
function checkpointStamp(checkpoint) {
  return digest({sessionId:checkpoint.sessionId,sequence:checkpoint.sequence,connectionEpoch:checkpoint.connectionEpoch,
    gameMatchKey:checkpoint.gameMatchKey,gameHandKey:checkpoint.gameHandKey,sourceCursor:checkpoint.sourceCursor,state:checkpoint.state});
}
export function assertCheckpointCurrent(checkpoint,page) {
  assertPageIdle(page);
  const expected=identity(page),state=checkpoint?.state;
  requireThat(checkpoint&&checkpoint.recoveryRequired===false&&checkpoint.unresolvedAttempts===0&&
    integer(checkpoint.sequence)&&integer(checkpoint.connectionEpoch,1)&&checkpoint.handStatus==='playing'&&
    checkpoint.matchStatus==='playing'&&!checkpoint.matchEndPending&&
    ['gameMatchKey','gameHandKey','sourceCursor'].every(key=>checkpoint[key]===expected[key]),'UI_CHECKPOINT_STALE');
  requireThat(state?.sessionId===checkpoint.sessionId&&state.connectionEpoch===checkpoint.connectionEpoch&&state.trust==='trusted'&&
    state.ownSeat===page.ownSeat&&Array.isArray(state.ownConcealed)&&new Set(state.ownConcealed.map(t=>t.instanceId)).size===state.ownConcealed.length,
    'UI_CHECKPOINT_INVALID');
  countsOf(state.ownConcealed.map(t=>t.code));
  const window=state.operationWindow;
  requireThat(window?.status==='open'&&window.connectionEpoch===checkpoint.connectionEpoch&&
    Array.isArray(window.candidates)&&window.candidates.length>0,'UI_LEGAL_WINDOW_REQUIRED');
  const fresh=legalOperationActions(state,page.operation.value,'private-ui-check','private-ui-evidence');
  requireThat(canonical(fresh.map(c=>[c.authority,c.action]))===canonical(window.candidates.map(c=>[c.authority,c.action])),
    'UI_CANDIDATES_CHANGED');
}

async function withReadOnly(databasePath,read) {
  requireThat(typeof databasePath==='string'&&databasePath.length>0&&databasePath!==':memory:','UI_DATABASE_PATH_REQUIRED');
  // Lazy import keeps pure ranking/planning usable in ego's Node environment.
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(databasePath,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    requireThat(db.prepare('PRAGMA application_id').get().application_id===0x4d414a49&&
      db.prepare('PRAGMA user_version').get().user_version===2,'UI_DATABASE_VERSION_UNSUPPORTED');
    return read(db);
  } finally {db.close();}
}

function committedProjection(db,sessionId) {
  const row=db.prepare('SELECT c.sequence,c.projection,s.recovery_required FROM checkpoints c JOIN sessions s USING(session_id) WHERE c.session_id=?').get(sessionId);
  requireThat(row,'UI_SESSION_NOT_FOUND');
  const projection=JSON.parse(row.projection);
  requireThat(projection.sessionId===sessionId&&integer(projection.sequence)&&row.sequence===projection.sequence&&
    db.prepare('SELECT max(sequence) AS sequence FROM game_events WHERE session_id=?').get(sessionId).sequence===projection.sequence,
    'UI_CHECKPOINT_NOT_COMMITTED');
  const pending=db.prepare("SELECT count(*) AS n FROM action_attempts WHERE game_match_key=? AND execution_mode IN ('contract-test','live') AND status IN ('prepared','dispatching','awaiting-confirmation','uncertain')").get(projection.gameMatchKey).n;
  return {projection,recoveryRequired:row.recovery_required!==0,unresolvedAttempts:Number(pending)};
}
function checkpointSummary({projection,recoveryRequired,unresolvedAttempts},state) {
  return {sessionId:projection.sessionId,sequence:projection.sequence,connectionEpoch:projection.connectionEpoch,
    gameMatchKey:projection.gameMatchKey,gameHandKey:projection.gameHandKey,sourceCursor:projection.sourceCursor,
    handStatus:projection.handStatus,matchStatus:projection.matchStatus,matchEndPending:projection.matchEndPending===true,
    recoveryRequired,unresolvedAttempts,state};
}

/** Pending input reconciliation does not require a new own offer or expose any hand tiles. */
export async function readUiProgress({databasePath,sessionId}) {
  requireThat(typeof sessionId==='string'&&sessionId.length>0,'UI_SESSION_REQUIRED');
  return withReadOnly(databasePath,db=>{
    const committed=committedProjection(db,sessionId),p=committed.projection;
    requireThat(!committed.recoveryRequired&&committed.unresolvedAttempts===0,'UI_PROGRESS_RECONCILIATION_REQUIRED');
    requireThat(integer(p.connectionEpoch,1)&&p.state?.sessionId===sessionId&&p.state.connectionEpoch===p.connectionEpoch&&
      ['trusted','syncing','untrusted'].includes(p.state.trust)&&typeof p.gameMatchKey==='string'&&typeof p.gameHandKey==='string'&&
      typeof p.sourceCursor==='string','UI_CHECKPOINT_INVALID');
    return checkpointSummary(committed,{trust:p.state.trust});
  });
}

/** Exact caller-owned session only; never chooses the latest session or opens a writer. */
export async function readUiCheckpoint({databasePath,sessionId,pageState}) {
  requireThat(typeof sessionId==='string'&&sessionId.length>0,'UI_SESSION_REQUIRED');
  assertPageIdle(pageState);
  return withReadOnly(databasePath,db=>{
    const committed=committedProjection(db,sessionId);
    const result=checkpointSummary(committed,visibleState(committed.projection.state));
    assertCheckpointCurrent(result,pageState);return result;
  });
}

/** Ukeire is an own-known-tile upper bound, not live-wall knowledge or a win guarantee. */
export function chooseUiAction(checkpoint,page) {
  if(page?.operation?.value?.operation_list?.some(op=>op.type===8||op.type===9))return wait('CLIENT_AUTO_WIN_WINDOW');
  if(page?.lastClientWin?.pageEpoch===page?.pageEpoch&&page?.lastClientWin?.sourceStream===page?.sourceStream&&page?.lastClientWin)
    return wait('UI_CLIENT_WIN_IN_FLIGHT');
  assertCheckpointCurrent(checkpoint,page);
  const state=checkpoint.state,own=state.players[state.ownSeat],operations=page.operation.value.operation_list;
  if(own.melds.length)return wait('UI_CLOSED_HAND_ONLY');
  if(operations.every(op=>[2,3,5].includes(op.type)))return {kind:'skip',reason:'DECLINE_CALL_KEEP_CLOSED'};
  const candidates=state.operationWindow.candidates.filter(c=>c.authority==='executor'&&c.action.kind==='discard');
  if(!operations.some(op=>op.type===1)||!candidates.length)return wait('UI_ORDINARY_DISCARD_ONLY');
  requireThat(state.ownConcealed.length===14&&state.drawnTileRef.known&&typeof state.drawnTileRef.value==='string','UI_DRAW_IDENTITY_REQUIRED');
  const original=countsOf(state.ownConcealed.map(t=>t.code)),evaluate=shantenEvaluator(),byCode=new Map();
  const ranked=candidates.map(candidate=>{
    const action=candidate.action,at=state.ownConcealed.findIndex(t=>t.instanceId===action.tile),tile=state.ownConcealed[at];
    requireThat(tile&&action.tsumogiri===(tile.instanceId===state.drawnTileRef.value),'UI_PHYSICAL_TILE_MISMATCH');
    mapActionToRequest(action,state,page.operation.value); // Validate only. Never call this request.
    const index=tileIndex(tile.code);
    if(!byCode.has(index)){
      const after=[...original];after[index]--;const shanten=evaluate(after).minimum;
      const improving=[];let ukeireUpperBound=0;
      for(let draw=0;draw<34;draw++){
        const unseen=4-original[draw];if(unseen<=0)continue;
        after[draw]++;const next=evaluate(after).minimum;after[draw]--;
        if(next<shanten){improving.push({tile:indexes[draw],remainingUpperBound:unseen});ukeireUpperBound+=unseen;}
      }
      byCode.set(index,{shanten,ukeireUpperBound,improving});
    }
    return {candidateId:candidate.id,action:clone(action),tileCode:tile.code,physicalIndex:at,...clone(byCode.get(index))};
  }).sort((a,b)=>a.shanten-b.shanten||b.ukeireUpperBound-a.ukeireUpperBound||
    Number(a.tileCode.endsWith('r'))-Number(b.tileCode.endsWith('r'))||Number(b.action.tsumogiri)-Number(a.action.tsumogiri)||a.physicalIndex-b.physicalIndex);
  return {kind:'discard',...ranked[0],explanation:'MIN_SHANTEN_MAX_OWN_KNOWN_UKEIRE_THEN_KEEP_RED_THEN_DRAWN',ranking:ranked};
}

function visualPoint(visual,choice,checkpoint,scope,nowMs) {
  requireThat(visual?.clientVersion==='4.0.51'&&visual.width===2036&&visual.height===918&&visual.devicePixelRatio===1&&
    visual.layoutVerified===true&&SHA.test(visual.rgbaSha256??'')&&integer(visual.observedAtMs)&&
    nowMs>=visual.observedAtMs&&nowMs-visual.observedAtMs<=1000&&canonical(visual.scope)===canonical(scope),'UI_VISUAL_PROOF_REQUIRED');
  if(choice.kind==='skip'){
    requireThat(visual.kind==='verified-skip-button'&&visual.label==='skip','UI_SKIP_BUTTON_UNVERIFIED');
    requireThat(visual.selectedBinding?.x===1302&&visual.selectedBinding?.y===700&&visual.selectedBinding.pngSha256===visual.rgbaSha256,
      'UI_SKIP_BUTTON_UNVERIFIED');
    return {x:1302,y:700};
  }
  const binding=visual.selectedBinding,tile=checkpoint.state.ownConcealed.find(t=>t.instanceId===choice.action.tile);
  requireThat(visual.kind==='verified-selected-tile'&&tile&&binding?.code===tile.code&&binding.drawn===choice.action.tsumogiri&&
    binding.pngSha256===visual.rgbaSha256&&integer(binding.slot)&&binding.slot<=13&&
    (binding.slot===13)===binding.drawn&&binding.x===(binding.slot===13?1504:430.5+80.7*binding.slot)&&[825,850].includes(binding.y),
    'UI_TILE_PIXEL_MISMATCH');
  // Same-code held copies are wire-equivalent. Keep the selected candidate's
  // reference for audit; only red identity and the separate drawn slot matter.
  return {x:binding.x,y:binding.y};
}

/** Host supplies a pixel-verified binding; this module never guesses tile ordering or coordinates. */
export function planUiAction({checkpoint,pageState,choice,visual,nowMs=Date.now()}) {
  assertCheckpointCurrent(checkpoint,pageState);assertProof(pageState);
  const selected=chooseUiAction(checkpoint,pageState);
  requireThat(selected.kind!=='wait'&&canonical(choice)===canonical(selected),'UI_CHOICE_CHANGED');
  const scope=pageScope(pageState),point=visualPoint(visual,selected,checkpoint,scope,nowMs);
  return {schemaVersion:1,executionKind:'private-ui-input',kind:selected.kind,scope,point,
    sessionId:checkpoint.sessionId,gameMatchKey:checkpoint.gameMatchKey,gameHandKey:checkpoint.gameHandKey,
    sourceCursor:checkpoint.sourceCursor,sequence:checkpoint.sequence,ownSeat:checkpoint.state.ownSeat,
    windowKey:digest([checkpoint.gameMatchKey,checkpoint.gameHandKey,checkpoint.sourceCursor]),
    checkpointSha256:checkpointStamp(checkpoint),operationSha256:digest(pageState.operation),visualSha256:visual.rgbaSha256,visualProof:clone(visual),
    plannedAtMs:nowMs,expiresAtMs:Math.min(nowMs+750,visual.observedAtMs+1000),
    ...(selected.kind==='discard'?{candidateId:selected.candidateId,action:clone(selected.action),tileCode:selected.tileCode,
      shanten:selected.shanten,ukeireUpperBound:selected.ukeireUpperBound,expectedSourceCursor:`${handSourceStream(checkpoint.gameMatchKey,checkpoint.gameHandKey)}:${scope.step+1}`} : {}),
    bridgeActionSendsBefore:pageState.stats?.bridgeActionSends??null,clientRequestsBefore:pageState.stats?.clientRequests??null};
}
export function assertUiPlanCurrent(plan,{checkpoint,pageState,nowMs=Date.now()}) {
  requireThat(plan?.schemaVersion===1&&plan.executionKind==='private-ui-input'&&['discard','skip'].includes(plan.kind),'UI_PLAN_INVALID');
  assertCheckpointCurrent(checkpoint,pageState);assertProof(pageState);
  requireThat(canonical(pageScope(pageState))===canonical(plan.scope)&&checkpoint.sessionId===plan.sessionId&&
    checkpoint.gameMatchKey===plan.gameMatchKey&&checkpoint.gameHandKey===plan.gameHandKey&&checkpoint.sourceCursor===plan.sourceCursor&&
    checkpoint.sequence===plan.sequence&&checkpoint.state.ownSeat===plan.ownSeat&&
    (plan.kind==='discard'?plan.expectedSourceCursor===`${handSourceStream(checkpoint.gameMatchKey,checkpoint.gameHandKey)}:${pageState.lastStep+1}`:
      !Object.hasOwn(plan,'expectedSourceCursor'))&&
    checkpointStamp(checkpoint)===plan.checkpointSha256&&digest(pageState.operation)===plan.operationSha256&&
    plan.windowKey===digest([checkpoint.gameMatchKey,checkpoint.gameHandKey,checkpoint.sourceCursor])&&
    plan.visualSha256===plan.visualProof?.rgbaSha256&&integer(plan.plannedAtMs)&&plan.expiresAtMs<=plan.plannedAtMs+750&&
    nowMs>=plan.plannedAtMs&&nowMs<plan.expiresAtMs,'UI_PLAN_STALE');
  const selected=chooseUiAction(checkpoint,pageState);
  requireThat(selected.kind===plan.kind&&(selected.kind==='skip'||selected.candidateId===plan.candidateId&&
    canonical(selected.action)===canonical(plan.action)&&selected.tileCode===plan.tileCode&&
    selected.shanten===plan.shanten&&selected.ukeireUpperBound===plan.ukeireUpperBound)&&
    canonical(visualPoint(plan.visualProof,selected,checkpoint,plan.scope,nowMs))===canonical(plan.point),'UI_PLAN_CHANGED');
  return true;
}

export function createUiLatch(consumedWindowKeys=[]) {
  requireThat(Array.isArray(consumedWindowKeys)&&consumedWindowKeys.length<=2048&&consumedWindowKeys.every(key=>SHA.test(key)), 'UI_AUDIT_HISTORY_INVALID');
  return {schemaVersion:1,consumedWindowKeys:[...new Set(consumedWindowKeys)],pending:null,halted:false};
}
/** Reserve and durably audit before moving the pointer. Even a rejected gesture is never retried in this window. */
export function claimUiWindow(latch,plan,current) {
  requireThat(latch?.schemaVersion===1&&!latch.halted&&!latch.pending,'UI_INPUT_PENDING');
  requireThat(!latch.consumedWindowKeys.includes(plan.windowKey),'UI_WINDOW_ALREADY_ATTEMPTED');
  requireThat(latch.consumedWindowKeys.length<2048,'UI_AUDIT_HISTORY_LIMIT');
  assertUiPlanCurrent(plan,current);
  return {...clone(latch),consumedWindowKeys:[...latch.consumedWindowKeys,plan.windowKey],pending:{plan:clone(plan),pointerOutcome:'reserved'}};
}
export function noteUiPointerOutcome(latch,outcome) {
  requireThat(latch?.pending?.pointerOutcome==='reserved'&&['released','not-started','uncertain'].includes(outcome),'UI_POINTER_OUTCOME_INVALID');
  const next=clone(latch);next.pending.pointerOutcome=outcome;
  // A CDP failure can follow actual native input. Do not turn it into a retry.
  if(outcome!=='released')next.halted=true;
  return next;
}

export async function readUiDiscardAuthority({databasePath,plan}) {
  requireThat(plan?.kind==='discard'&&typeof plan.expectedSourceCursor==='string','UI_DISCARD_PLAN_REQUIRED');
  return withReadOnly(databasePath,db=>{
    const rows=db.prepare('SELECT session_id,game_match_key,game_hand_key,source_cursor,body FROM observed_actions WHERE game_match_key=? AND game_hand_key=? AND source_cursor=?').all(plan.gameMatchKey,plan.gameHandKey,plan.expectedSourceCursor);
    requireThat(rows.length<=1,'UI_AUTHORITY_AMBIGUOUS');
    if(!rows.length)return null;
    const row=rows[0],fact=JSON.parse(row.body);
    return {sessionId:row.session_id,gameMatchKey:row.game_match_key,gameHandKey:row.game_hand_key,sourceCursor:row.source_cursor,
      kind:fact.kind,actor:fact.actor,tiles:clone(fact.tiles),tsumogiri:clone(fact.tsumogiri),riichiDeclaration:fact.riichiDeclaration===true};
  });
}
/** A skip has no discard confirmation: only report that its window advanced. */
export function reconcileUiWindow(latch,{checkpoint,pageState,authority=null}) {
  requireThat(latch?.pending&&latch.pending.pointerOutcome==='released'&&!latch.halted,'UI_INPUT_NOT_RECONCILABLE');
  const plan=latch.pending.plan,next=clone(latch);
  requireThat(checkpoint?.sessionId===plan.sessionId&&checkpoint.gameMatchKey===plan.gameMatchKey,'UI_SESSION_CHANGED');
  const sameHand=checkpoint.gameHandKey===plan.gameHandKey;
  const currentCursor=sameHand?`${handSourceStream(plan.gameMatchKey,plan.gameHandKey)}:${pageState.lastStep}`:null;
  if(!sameHand||pageState.pageEpoch!==plan.scope.pageEpoch||pageState.sourceStream!==plan.scope.sourceStream||
    pageState.nativeRestoreRevision!==plan.scope.nativeRestoreRevision){next.halted=true;return {status:'scope-changed',latch:next};}
  if(pageState.paused!==true||pageState.phase2ActionsEnabled!==false||pageState.connected!==true||pageState.freshConnection!==true||
    pageState.reason||pageState.overflow||checkpoint.recoveryRequired||checkpoint.unresolvedAttempts||checkpoint.state?.trust!=='trusted'){
    next.halted=true;return {status:'observer-not-ready',latch:next};
  }
  if(checkpoint.sourceCursor!==currentCursor||pageState.queued!==0||pageState.lastStep<=plan.scope.step)return {status:'awaiting-authority',latch:next};
  if(plan.kind==='discard'){
    if(!authority)return {status:'awaiting-authority',latch:next};
    const matched=authority.sessionId===plan.sessionId&&authority.gameMatchKey===plan.gameMatchKey&&authority.gameHandKey===plan.gameHandKey&&
      authority.sourceCursor===plan.expectedSourceCursor&&authority.kind==='discard'&&authority.actor===plan.ownSeat&&
      canonical(authority.tiles)===canonical([plan.tileCode])&&authority.tsumogiri?.known===true&&
      authority.tsumogiri.value===plan.action.tsumogiri&&authority.riichiDeclaration===false;
    if(!matched){next.halted=true;return {status:'authority-mismatch',latch:next};}
  }
  next.pending=null;
  return {status:plan.kind==='discard'?'discard-observed':'skip-window-advanced',latch:next};
}

// Integration contract: only the original observer drains/ingests/recovers.
// read → exact read-only checkpoint → fresh verifyAutoWin → verified frame →
// choose/plan → durable UI reservation → claim → hover → repeat read/checkpoint
// and assertUiPlanCurrent → one press/release in finally → audit outcome → wait
// for original-ledger authority. Never re-ensure from this helper, call drain,
// resume the Actor, or infer total sends from bridgeActionSends === 0.
