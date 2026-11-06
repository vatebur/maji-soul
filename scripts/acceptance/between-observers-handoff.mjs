// Private, explicitly invoked tool; importing it does not access a browser or ledger.
// The caller must own the stopped observer and have independently established that
// its child exited and its original ledger has no unresolved attempts. A report on
// disk alone is NOT that proof. Never use this while another observer/UI writer runs.
// A successful replacement is not a game sync, UI-ready proof, or acceptance pass.
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOperationRules} from '../../src/adapters/majsoul/actions.ts';

const repository=new URL('../../',import.meta.url);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const requireThat=(value,code)=>{if(!value)throw Error(code);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

async function verifiedBundle(protocol) {
  const versions=protocol?.pins??JSON.parse(await fs.readFile(new URL('config/versions.json',repository),'utf8'));
  const directory=protocol?.directory??fileURLToPath(new URL(
    `.runtime/upstream/Akagi-${versions.akagiCommit}/src/bridge/majsoul/`,repository));
  const [proto,rpcText,source,library]=await Promise.all([
    fs.readFile(join(directory,'proto','liqi.proto'),'utf8'),
    fs.readFile(join(directory,'liqi.json'),'utf8'),
    fs.readFile(new URL('src/adapters/majsoul/browser-bridge.js',repository),'utf8'),
    fs.readFile(new URL('node_modules/protobufjs/dist/protobuf.min.js',repository),'utf8'),
  ]);
  const operationRulesSource=createOperationRules.toString();
  requireThat(hash(proto)===versions.protoSha256&&hash(rpcText)===versions.rpcMapSha256,'PROTOCOL_HASH_MISMATCH');
  return {source:source.replace('export function','function'),library,
    input:{proto,rpcMap:JSON.parse(rpcText),operationRulesSource,phase2ActionsEnabled:false},
    pins:{clientVersion:versions.clientVersion,protoSha256:hash(proto),rpcMapSha256:hash(rpcText),
      bridgeSha256:hash(source),librarySha256:hash(library),operationRulesSha256:hash(operationRulesSource)}};
}

// Self-contained and synchronous. In particular there is no await between the
// final current-scope check and reconnect -> guarded restore -> new installation.
function pageOperation(input) {
  const key='__majiBetweenObserversHandoff';
  const check=(value,code)=>{if(!value)throw Error(code);};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
  function cursor(r) {
    return {pageEpoch:r.pageEpoch,generation:r.generation,nativeRestoreRevision:r.nativeRestoreRevision,
      controlEpoch:r.controlEpoch,sourceStream:r.sourceStream,lastStep:r.lastStep,
      gameUuid:r.gameUuid,handSha256:r.handSha256,ownSeat:r.ownSeat,stats:clone(r.stats)};
  }
  function active(r,expected) {
    check(r&&r.schemaVersion===1&&r.allocator==='wire-multiplexer-v1','HANDOFF_BRIDGE_INVALID');
    // Check BEFORE drain. An overflowed/ended queue is not a complete tail.
    check(r.overflow===false&&r.reason===null,'HANDOFF_BRIDGE_UNTRUSTED');
    check(r.handEnded===false&&r.matchEnded===false&&r.matchResult===null,'HANDOFF_TERMINAL');
    check(r.connected===true&&r.freshConnection===true,'HANDOFF_CONNECTION_UNAVAILABLE');
    check(r.paused===true&&r.phase2ActionsEnabled===false&&r.stats?.bridgeActionSends===0,'HANDOFF_NOT_PASSIVE');
    check(r.pendingRpcCount===0,'HANDOFF_PENDING_RPC');
    check(integer(r.pageEpoch,1)&&integer(r.generation)&&integer(r.nativeRestoreRevision)&&integer(r.controlEpoch)&&
      integer(r.sourceStream)&&integer(r.lastStep)&&integer(r.queued)&&r.queued<=1024,'HANDOFF_CURSOR_INVALID');
    check(r.gameUuid===expected.gameUuid&&r.handSha256===expected.handSha256&&r.ownSeat===expected.ownSeat&&
      r.pageEpoch===expected.pageEpoch&&r.sourceStream===expected.sourceStream&&r.lastStep>=expected.afterStep,'HANDOFF_SCOPE_CHANGED');
    check(!r.operation?.value?.operation_list?.some(o=>o.type===8||o.type===9)&&
      !r.lastClientWin&&!r.lastOwnWin,'HANDOFF_WIN_WINDOW');
    return cursor(r);
  }
  function version(pins) {
    check([...document.scripts].some(s=>s.src.includes('WebGL-release-')&&s.src.includes(`release-${pins.clientVersion}(`)),
      'CLIENT_VERSION_MISMATCH');
  }
  const bridge=window.__majiBridge;
  check(bridge&&typeof bridge.read==='function','HANDOFF_BRIDGE_MISSING');
  version(input.pins);
  if(input.kind==='archive') {
    const existing=window[key];
    if(existing) {
      // A failed disk write can be retried to a NEW path without draining again.
      check(existing.phase==='drained'&&existing.bridge===bridge&&same(existing.expected,input.expected)&&
        same(existing.pins,input.pins),'HANDOFF_ARCHIVE_ALREADY_EXISTS');
      return clone(existing.capture);
    }
    const before=bridge.read();active(before,input.expected);
    const batch=bridge.drain(),after=bridge.read();
    const capture={token:input.token,expected:input.expected,pins:input.pins,
      before:{...cursor(before),queued:before.queued},batch:{...cursor(batch),queued:batch.queued},
      after:{...cursor(after),queued:after.queued},records:batch.records};
    // Retain the exact drained records until the Node side has fsynced them. No
    // requeue, synthetic network event, clearing owner, or old permit reuse.
    window[key]={phase:'drained',bridge,expected:clone(input.expected),pins:clone(input.pins),capture:clone(capture)};
    return clone(capture);
  }
  const saved=window[key];
  check(saved&&saved.bridge===bridge&&saved.capture.token===input.token,'HANDOFF_ARCHIVE_STALE');
  if(input.kind==='saved') {
    check(saved.phase==='drained','HANDOFF_ARCHIVE_ALREADY_EXISTS');
    saved.phase='saved';saved.payloadSha256=input.payloadSha256;return {saved:true};
  }
  check(input.kind==='handoff'&&saved.phase==='saved'&&saved.payloadSha256===input.payloadSha256,'HANDOFF_ARCHIVE_NOT_SAVED');
  check(same(saved.pins,input.pins),'HANDOFF_CODE_CHANGED');
  const current=bridge.read(),currentCursor=active(current,saved.expected);
  check(current.queued===0&&same({...currentCursor,queued:0},saved.capture.after),'HANDOFF_CURSOR_CHANGED');

  // Compile and validate the same pinned input used by installLiveBridge before
  // closing a socket. Loading protobuf changes no mux/owner/permit state.
  (0,eval)(input.bundle.library);
  const install=(0,eval)(`(${input.bundle.source})`);
  const root=window.protobuf.parse(input.bundle.input.proto,{keepCase:true}).root;
  root.lookupType('lq.Wrapper');
  const rules=(0,eval)(`(${input.bundle.input.operationRulesSource})`)();
  check(typeof install==='function'&&typeof rules.mapActionToRequest==='function','HANDOFF_INSTALLER_INVALID');
  // All preceding work was synchronous too; repeat immediately before teardown.
  const final=bridge.read();active(final,saved.expected);
  check(final.queued===0&&same({...cursor(final),queued:0},saved.capture.after),'HANDOFF_CURSOR_CHANGED');
  saved.phase='handoff-started'; // Never retry uncertain/partially completed teardown.
  check(bridge.reconnect()?.reconnectRequested===true,'HANDOFF_RECONNECT_FAILED');
  check(bridge.restore()?.restored===true,'HANDOFF_RESTORE_FAILED');
  check(!window.__majiBridge,'HANDOFF_RESTORE_INCOMPLETE');
  const installed=install(input.bundle.input),next=window.__majiBridge;
  const initial=next?.read();
  check(installed?.installed===true&&next!==bridge&&initial?.paused===true&&initial.phase2ActionsEnabled===false&&
    initial.stats.bridgeActionSends===0&&initial.stats.bridgeSyncRequests===0&&initial.pendingRpcCount===0&&
    initial.queued===0&&initial.generation===0&&initial.nativeRestoreRevision===0&&initial.lastStep===null&&
    initial.gameUuid===null&&initial.handSha256===null&&initial.autoWin===null&&initial.lastAutoWinReadback===null,
    'HANDOFF_NEW_BRIDGE_INVALID');
  window[key]={phase:'replaced',token:input.token,payloadSha256:input.payloadSha256};
  return {status:'bridge-replaced-awaiting-fresh-sync',automationEnabled:false,
    pageEpoch:initial.pageEpoch,generation:initial.generation,queued:initial.queued,
    bridgeActionSends:initial.stats.bridgeActionSends,bridgeSyncRequests:initial.stats.bridgeSyncRequests};
}

function assertExpected(expected) {
  const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
  requireThat(expected&&typeof expected.gameUuid==='string'&&expected.gameUuid.length>0&&expected.gameUuid.length<=128&&
    typeof expected.handSha256==='string'&&expected.handSha256.length>0&&expected.handSha256.length<=128&&
    integer(expected.ownSeat)&&expected.ownSeat<4&&integer(expected.pageEpoch,1)&&integer(expected.sourceStream)&&
    integer(expected.afterStep),'HANDOFF_EXPECTED_SCOPE_REQUIRED');
}
function assertClosure(closure) {
  requireThat(closure?.actorExited===true&&closure.unresolvedAttempts===0,'HANDOFF_OBSERVER_NOT_CLOSED');
}
function tailError(capture) {
  const {before,batch,after,records,expected}=capture;
  if(!Array.isArray(records)||records.length!==before.queued||batch.queued!==before.queued||after.queued!==0||
    !equal({...before,queued:0},{...batch,queued:0})||!equal({...before,queued:0},after))return 'HANDOFF_DRAIN_CHANGED';
  const allowed=['ActionDealTile','ActionDiscardTile','ActionChiPengGang','ActionAnGangAddGang'];
  let step=expected.afterStep,previousGeneration=-1;
  for(const record of records) {
    if(record.kind!=='action'||!allowed.includes(record.name)||!record.payload||typeof record.payload!=='object'||
      Array.isArray(record.payload)||record.payload.gameend)return 'HANDOFF_TAIL_BOUNDARY_OR_UNKNOWN';
    if(record.gameUuid!==expected.gameUuid||record.handSha256!==expected.handSha256||
      record.pageEpoch!==expected.pageEpoch||record.sourceStream!==expected.sourceStream)return 'HANDOFF_TAIL_SCOPE_CHANGED';
    if(record.step!==++step||!Number.isSafeInteger(record.generation)||record.generation<=previousGeneration||
      record.generation>after.generation)return 'HANDOFF_TAIL_NOT_CONTIGUOUS';
    previousGeneration=record.generation;
  }
  return step===after.lastStep?null:'HANDOFF_TAIL_NOT_CONTIGUOUS';
}
async function privatePath(evidenceDirectory,path,existing=false) {
  requireThat(typeof path==='string'&&path.endsWith('.json'),'HANDOFF_ARCHIVE_PATH_INVALID');
  const absolute=resolve(path),root=await fs.realpath(evidenceDirectory),parent=await fs.realpath(dirname(absolute));
  const rootInfo=await fs.stat(root);
  requireThat(rootInfo.isDirectory()&&(rootInfo.mode&0o077)===0,'HANDOFF_ARCHIVE_PATH_INVALID');
  requireThat(parent===root||parent.startsWith(root+sep),'HANDOFF_ARCHIVE_PATH_INVALID');
  if(existing) {
    const file=await fs.lstat(absolute);
    requireThat(file.isFile()&&(file.mode&0o077)===0,'HANDOFF_ARCHIVE_PATH_INVALID');
  }
  return absolute;
}
async function durableArchive(path,artifact) {
  const file=await fs.open(path,'wx',0o600);
  try {await file.writeFile(JSON.stringify(artifact,null,2)+'\n');await file.sync();}
  finally {await file.close();}
  const directory=await fs.open(dirname(path),'r');
  try {await directory.sync();} finally {await directory.close();}
}

/** expected.afterStep is the prior observer's last committed wire step, not a
 * later unobserved checkpoint. The exact session/hand must be supplied by caller.
 * A rejected tail is still saved, but never eligible for handoff. */
async function archiveTail(evidenceDirectory,protocol,page,{archivePath,expected,closure}={}) {
  assertClosure(closure);assertExpected(expected);
  const path=await privatePath(evidenceDirectory,archivePath),bundle=await verifiedBundle(protocol);
  const capture=await page.evaluate(pageOperation,{kind:'archive',expected,pins:bundle.pins,token:randomUUID()});
  const code=tailError(capture),payload={schemaVersion:1,kind:'between-observers-tail',
    capturedAt:new Date().toISOString(),closure:{actorExited:true,unresolvedAttempts:0},
    eligible:code===null,code,capture};
  const payloadSha256=hash(payload);
  await durableArchive(path,{payload,payloadSha256});
  await page.evaluate(pageOperation,{kind:'saved',token:capture.token,pins:bundle.pins,payloadSha256});
  if(code)throw Error(code);
  return {archivePath:path,payloadSha256,eligible:true,records:capture.records.length,
    afterStep:capture.after.lastStep};
}

/** The caller remains exclusive owner between archiveTail and this call.
 * After replacement, use the existing fresh-bridge/native-recovery gates and a
 * NEW Actor on the ORIGINAL DB. Require same match/hand and complete sync history
 * covering the archived lastStep/facts before accepting the continuation. This
 * function does not send sync/input RPCs, ACK, click, resume, or declare passed. */
async function handoff(evidenceDirectory,protocol,page,archivePath) {
  const path=await privatePath(evidenceDirectory,archivePath,true),artifact=JSON.parse(await fs.readFile(path,'utf8'));
  const {payload,payloadSha256}=artifact;
  requireThat(payload?.schemaVersion===1&&payload.kind==='between-observers-tail'&&hash(payload)===payloadSha256,
    'HANDOFF_ARCHIVE_INVALID');
  assertClosure(payload.closure);assertExpected(payload.capture?.expected);
  requireThat(payload.eligible===true&&payload.code===null&&tailError(payload.capture)===null,'HANDOFF_TAIL_REJECTED');
  const bundle=await verifiedBundle(protocol);
  requireThat(equal(payload.capture.pins,bundle.pins),'HANDOFF_CODE_CHANGED');
  return page.evaluate(pageOperation,{kind:'handoff',token:payload.capture.token,payloadSha256,pins:bundle.pins,bundle});
}

// An alternate pinned protocol supplies the synthetic inputs for the VM tests.
// Normal use takes the pinned client and protocol from config/versions.json.
export function createObserverHandoff({evidenceDirectory,protocol}={}) {
  requireThat(typeof evidenceDirectory==='string'&&evidenceDirectory.length>0,'HANDOFF_ARCHIVE_PATH_INVALID');
  if(protocol!==undefined) {
    requireThat(typeof protocol?.directory==='string'&&protocol.directory.length>0&&
      typeof protocol.pins?.clientVersion==='string'&&protocol.pins.clientVersion.length>0&&
      [protocol.pins.protoSha256,protocol.pins.rpcMapSha256].every(value=>/^[a-f0-9]{64}$/.test(value)),
      'HANDOFF_PROTOCOL_PINS_INVALID');
  }
  const directory=resolve(evidenceDirectory);
  const pinnedProtocol=protocol&&{directory:resolve(protocol.directory),pins:{...protocol.pins}};
  return Object.freeze({
    archiveTail:(page,options)=>archiveTail(directory,pinnedProtocol,page,options),
    handoff:(page,path)=>handoff(directory,pinnedProtocol,page,path),
  });
}
