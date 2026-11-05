// Self-contained Page.evaluate installer. No authentication payload is retained.
// Live action XOR: Akagi 63cea4b5, Copyright 2026 Shinkuan, Apache-2.0.
// License/notice: docs/research/licenses/akagi-{LICENSE,NOTICE}.txt.
export function installBrowserBridge({ proto, rpcMap, ownSeat, capacity = 256, operationRulesSource, phase2ActionsEnabled = false }) {
  if (window.__majiBridge) throw Error('BRIDGE_ALREADY_INSTALLED');
  if (!Number.isInteger(capacity) || capacity < 8 || capacity > 1024) throw Error('INVALID_BRIDGE_CAPACITY');
  const root = window.protobuf.parse(proto, { keepCase: true }).root;
  const wrapper = root.lookupType('lq.Wrapper');
  const operationRules = operationRulesSource ? (0, eval)(`(${operationRulesSource})`)() : null;
  if (phase2ActionsEnabled && !operationRules?.mapActionToRequest) throw Error('ACTION_RULES_REQUIRED');
  const OriginalSocket = window.WebSocket, originalSend = OriginalSocket.prototype.send;
  const flows = new Map(), replayed = new WeakSet(), records = [], tokens = new Map();
  let gameSocket, pageEpoch = 1, generation = 0, lastStep = null, paused = true;
  let reason = null, overflow = false, controlEpoch = 0, processInstanceId = null, lastSync = null;
  let actionStream = 0, operation = null, restored = false, gameUuid = null, authSummary = null;
  let roundSignature = null, handEnded = false;
  let autoWin = null;
  let lastAutoWinReadback = null, winningOffer = null;
  let operationTiming = null;
  let lastClientWin = null, lastOwnWin = null;
  const stats = { clientRequests: 0, bridgeSyncRequests: 0, bridgeActionSends: 0, clientWinRequests: 0, authoritativeOwnWins: 0 };
  const seen = new Map();
  const iso = () => new Date().toISOString();
  const fail = code => { paused = true; reason = code; pageEpoch++; tokens.clear(); autoWin = null; operationTiming = null; lastAutoWinReadback = null; winningOffer = null; };
  const requireThat = (value, code) => { if (!value) throw Error(code); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clone = value => JSON.parse(JSON.stringify(value));
  function observeWinningOffer() {
    winningOffer = null;
    if (!operation?.value.operation_list?.some(o => o.type === 8 || o.type === 9)) return;
    const prior = lastAutoWinReadback;
    winningOffer = { pageEpoch,sourceStream:actionStream,step:lastStep,
      priorAutoWinReadback:prior?.state==='enabled' && prior.pageEpoch===pageEpoch && prior.sourceStream===actionStream
        ? { ...pick(prior,['state','pageEpoch','sourceStream','step','generation','observedAt','rgbaSha256']),
          sampledMonoMs:prior.sampledMonoMs,ageAtOfferMs:Math.max(0,performance.now()-prior.sampledMonoMs) } : null };
  }
  // Unity toolbar changes do not emit game RPCs. Every local interaction revokes
  // prepared sends before Unity can handle it; a subsequent readback must be fresh.
  const localInput = () => { generation++;tokens.clear();autoWin=null;operationTiming=null;lastAutoWinReadback=null;winningOffer=null; };
  const inputEvents = ['pointerdown','keydown','resize','scroll'];
  for (const name of inputEvents) window.addEventListener(name,localInput,{capture:true});
  // Private 128-bit fingerprint compares complete decoded-wire action bytes before redaction.
  // No raw action bytes (including somebody else's draw) are retained in the dedup index.
  function fingerprint(bytes) {
    let hash = 0x6c62272e07bb014262b821756295c58dn;
    for (const byte of bytes) hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
    return hash.toString(16);
  }
  const body = (type, bytes) => { const t = root.lookupType(type); return t.toObject(t.decode(bytes), { defaults: true, bytes: Array, longs: Number }); };
  const bytesOf = raw => raw instanceof ArrayBuffer ? new Uint8Array(raw)
    : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null;
  function envelope(raw) {
    const bytes = bytesOf(raw);
    if (!bytes || bytes.length < 2 || ![1, 2, 3].includes(bytes[0])) return null;
    const type = bytes[0]; if (type !== 1 && bytes.length < 3) throw Error('TRUNCATED_FRAME');
    const w = wrapper.decode(bytes.subarray(type === 1 ? 1 : 3));
    return { type, id: type === 1 ? null : bytes[1] + 256 * bytes[2], name: w.name, data: w.data, bytes };
  }
  function frame(method, params, id) {
    const route = rpcMap[method]; requireThat(route, 'METHOD_NOT_ALLOWED');
    const t = root.lookupType(route.req), error = t.verify(params); requireThat(!error, 'INVALID_RPC_PARAMS');
    const encoded = wrapper.encode({ name: method, data: t.encode(t.fromObject(params)).finish() }).finish();
    const result = new Uint8Array(encoded.length + 3);
    result[0] = 2; result[1] = id & 255; result[2] = id >> 8; result.set(encoded, 3); return result;
  }
  function push(record) {
    generation++;
    if (records.length >= capacity) { overflow = true; fail('BRIDGE_QUEUE_OVERFLOW'); return; }
    records.push({ ...record, generation, pageEpoch });
  }
  function pick(value, fields) {
    const result = {};
    for (const key of fields) if (Object.hasOwn(value, key)) result[key] = clone(value[key]);
    return result;
  }
  function safeOperation(value) {
    if (!value) return value;
    return { ...pick(value, ['seat', 'time_add', 'time_fixed']),
      operation_list: (value.operation_list || []).map(o => pick(o, ['type', 'combination', 'change_tiles', 'change_tile_states', 'gap_type'])) };
  }
  function visible(name, value) {
    const fields = {
      ActionNewRound: ['chang','ju','ben','tiles','dora','scores','liqibang','md5','sha256','left_tile_count','doras','ju_count','field_spell'],
      ActionDealTile: ['seat','left_tile_count','doras','tile_state'],
      ActionDiscardTile: ['seat','tile','moqie','is_liqi','is_wliqi','doras','tile_state','revealed','scores','liqibang','liqi_type_beishuizhizhan'],
      ActionChiPengGang: ['seat','type','tiles','froms','tile_states','scores','liqibang'],
      ActionAnGangAddGang: ['seat','type','tiles','doras'],
      ActionHule: ['old_scores','delta_scores','scores','doras'],
      ActionNoTile: ['liujumanguan','gameend'],
      ActionLiuJu: ['type','seat'], ActionMJStart: [],
    }[name];
    if (!fields) return null;
    const result = pick(value, fields);
    if (name === 'ActionDealTile') result.tile = value.seat === ownSeat ? value.tile : '';
    if (name === 'ActionNewRound') result.opens = (value.opens || []).map(open =>
      open.tiles?.length || open.count?.length ? { unsupported: true } : { seat: open.seat, tiles: [] });
    if (Object.hasOwn(value, 'operation')) result.operation = safeOperation(value.operation);
    if (value.liqi) result.liqi = pick(value.liqi, ['seat','score','liqibang','failed','liqi_type_beishuizhizhan']);
    if (value.gameend && typeof value.gameend === 'object') result.gameend = pick(value.gameend, ['scores']);
    if (name === 'ActionHule') result.hules = (value.hules || []).map(h => pick(h, ['seat','zimo','point_rong','point_zimo_qin','point_zimo_xian']));
    if (name === 'ActionNoTile') result.scores = (value.scores || []).map(s => pick(s, ['seat','old_scores','delta_scores']));
    // Variant presence must survive redaction so a normalizer can reject it.
    for (const field of ['muyu','yongchang','hun_zhi_yi_ji_info','xia_ke_shang']) if (value[field]) result[field] = { unsupported: true };
    return result;
  }
  function decodedAction(protoAction, encrypted) {
    const name = protoAction.name.replace(/^\.lq\./, '');
    const data = new Uint8Array(protoAction.data);
    if (encrypted) {
      const keys = [0x84,0x5e,0x4e,0x42,0x39,0xa2,0x1f,0x60,0x1c], base = 23 ^ data.length;
      for (let i = 0; i < data.length; i++) data[i] ^= (base + 5 * i + keys[i % 9]) & 255;
    }
    const payload = visible(name, body(`lq.${name}`, data));
    requireThat(payload !== null, 'UNSUPPORTED_PROTOCOL_ACTION');
    const action = { name, step: protoAction.step, payload };
    Object.defineProperty(action, 'fingerprint', { value: `${name}/${protoAction.step}/${fingerprint(data)}` });
    return action;
  }
  function observeAction(protoAction) {
    let action;
    try { action = decodedAction(protoAction, true); }
    catch { fail('UNSUPPORTED_PROTOCOL_ACTION'); push({ kind: 'fault', code: 'UNSUPPORTED_PROTOCOL_ACTION' }); return; }
    const signature = action.fingerprint;
    // NewRound is the only accepted reset; its fingerprint makes retransmission idempotent.
    if (action.name === 'ActionNewRound' && lastStep !== null && action.step < lastStep) {
      if (roundSignature === signature) return;
      if (!handEnded) { fail('SOURCE_DEDUP_CONFLICT'); push({ kind: 'fault', code: 'SOURCE_DEDUP_CONFLICT' }); return; }
      actionStream++; seen.clear(); lastStep = null;
    }
    const previous = seen.get(action.step);
    if (previous !== undefined) {
      if (previous !== signature) { fail('SOURCE_DEDUP_CONFLICT'); push({ kind: 'fault', code: 'SOURCE_DEDUP_CONFLICT' }); }
      return;
    }
    if (lastStep !== null && action.step !== lastStep + 1) fail('SOURCE_STEP_GAP');
    if (seen.size >= 1024) { fail('SOURCE_DEDUP_CAPACITY'); return; }
    seen.set(action.step, signature); lastStep = action.step;
    if (action.name === 'ActionNewRound') { roundSignature = signature; handEnded = false; lastClientWin = null; lastOwnWin = null; lastAutoWinReadback=null; winningOffer=null; }
    if (['ActionHule','ActionNoTile','ActionLiuJu'].includes(action.name)) handEnded = true;
    if (action.name === 'ActionHule' && action.payload.hules?.some(h => h.seat === ownSeat)) {
      stats.authoritativeOwnWins++;
      const win = action.payload.hules.find(h => h.seat === ownSeat);
      const matches = lastClientWin?.pageEpoch === pageEpoch && lastClientWin?.sourceStream === actionStream &&
        lastClientWin.offered && lastClientWin.step < lastStep && lastClientWin.type === (win.zimo ? 8 : 9);
      lastOwnWin = { pageEpoch,sourceStream:actionStream,step:lastStep,receivedAt:iso(),kind:win.zimo?'tsumo':'ron',
        clientWinRequestId:matches?lastClientWin.requestId:null };
    }
    const receivedAt = iso(), receivedMonoMs = performance.now();
    operation = action.payload.operation ? { step: lastStep, receivedMonoMs, value: clone(action.payload.operation) } : null;
    observeWinningOffer();
    operationTiming = null;
    tokens.clear();
    push({ kind: 'action', ...action, receivedAt, receivedMonoMs, sourceStream: actionStream });
  }
  function allocate(flow) {
    if (flow.pending.size >= 512) { fail('RPC_PENDING_OVERFLOW'); throw Error('RPC_PENDING_OVERFLOW'); }
    for (let i = 0; i < 65536; i++) {
      const id = flow.nextId; flow.nextId = (flow.nextId + 1) & 65535;
      if (!flow.pending.has(id)) return id;
    }
    throw Error('RPC_ID_EXHAUSTED');
  }
  function attach(socket, fresh = false) {
    if (flows.has(socket)) return flows.get(socket);
    const flow = { fresh, pending: new Map(), nextId: 0, message: null, close: null };
    flow.message = event => {
      if (replayed.has(event) || restored) return;
      let packet;
      try { packet = envelope(event.data); }
      catch { fail('FRAME_DECODE_FAILED'); return; }
      if (!packet) return;
      if (packet.type === 1) {
        if (packet.name === '.lq.ActionPrototype') {
          gameSocket = socket;
          try { observeAction(body('lq.ActionPrototype', packet.data)); } catch { fail('ACTION_DECODE_FAILED'); }
        }
        return;
      }
      if (packet.type !== 3) return;
      const request = flow.pending.get(packet.id);
      if (!request) { if (flow.fresh) fail('UNEXPECTED_RPC_RESPONSE'); return; }
      flow.pending.delete(packet.id);
      if (request.timer) clearTimeout(request.timer);
      if (request.method === '.lq.FastTest.authGame') {
        try {
          const decoded = body(rpcMap[request.method].resp, packet.data);
          if (flow.authAccount !== undefined) ownSeat = decoded.seat_list?.indexOf(flow.authAccount);
          delete flow.authAccount;
          const mode = decoded.game_config?.mode;
          authSummary = { ownSeat, gameConfig: { category: decoded.game_config?.category,
            mode: mode ? { ...pick(mode, ['mode','ai']), detail_rule: pick(mode.detail_rule || {}, [
              'time_fixed','time_add','dora_count','shiduan','init_point','fandian','can_jifei','liqibang_value','changbang_value',
              'have_liujumanguan','have_qieshangmanguan','have_biao_dora','have_gang_biao_dora','have_li_dora',
              'have_gang_li_dora','have_sifenglianda','have_sigangsanle','have_sijializhi','have_jiuzhongjiupai',
              'have_sanjiahele','have_toutiao','have_helelianzhuang','have_helezhongju','have_tingpailianzhuang',
              'have_tingpaizhongju','have_yifa','have_nanruxiru',
            ]) } : null } };
          push({ kind: 'auth-summary', ...authSummary, receivedAt: iso() });
        } catch { delete flow.authAccount; fail('AUTH_SUMMARY_UNAVAILABLE'); }
      }
      if (!flow.fresh) return;
      event.stopImmediatePropagation();
      if (request.winRecord) {
        try {
          const decoded = body(rpcMap[request.method].resp, packet.data);
          request.winRecord.delivery = decoded.error ? 'rejected' : 'accepted';
          request.winRecord.receiptObservedAt = iso();
        } catch { request.winRecord.delivery = 'unknown'; }
      }
      if (request.bridge) {
        let response;
        try { response = body(rpcMap[request.method].resp, packet.data); }
        catch { request.reject(Error('RPC_RESPONSE_DECODE_FAILED')); fail('RPC_RESPONSE_DECODE_FAILED'); return; }
        request.resolve({ response, requestId: packet.id });
        return;
      }
      const rewritten = packet.bytes.slice(); rewritten[1] = request.clientId & 255; rewritten[2] = request.clientId >> 8;
      const replacement = new MessageEvent('message', { data: rewritten.buffer, origin: event.origin, lastEventId: event.lastEventId });
      replayed.add(replacement); socket.dispatchEvent(replacement);
    };
    flow.close = () => {
      if (socket === gameSocket) { pageEpoch++; fail('DISCONNECTED'); operation = null; push({ kind: 'disconnected', receivedAt: iso() }); }
      for (const pending of flow.pending.values()) if (pending.bridge) pending.reject(Error('RPC_CONNECTION_CLOSED'));
      for (const pending of flow.pending.values()) if (pending.timer) clearTimeout(pending.timer);
      delete flow.authAccount;
      flow.pending.clear();
    };
    flows.set(socket, flow);
    socket.addEventListener('message', flow.message, true); socket.addEventListener('close', flow.close, true);
    return flow;
  }
  const SocketProxy = new Proxy(OriginalSocket, { construct(target, args, newTarget) {
    const socket = Reflect.construct(target, args, newTarget === SocketProxy ? target : newTarget); attach(socket, true); return socket;
  } });
  function send(raw) {
    const flow = attach(this);
    let packet;
    try { packet = envelope(raw); } catch { fail('FRAME_DECODE_FAILED'); return originalSend.call(this, raw); }
    // Unknown client methods still share the wire allocator. Passing through their
    // original IDs could collide with an in-flight bridge request after schema drift.
    if (!packet || packet.type !== 2) return originalSend.call(this, raw);
    if (packet.name.startsWith('.lq.FastTest.')) gameSocket = this;
    if (packet.name === '.lq.FastTest.authGame') {
      // This transient correlation value is discarded on its response; never returned or queued.
      const request = body(rpcMap[packet.name].req, packet.data);
      flow.authAccount = request.account_id; gameUuid = request.game_uuid;
    }
    // Legacy sockets predate interception: preserve client operation, deny bridge RPCs.
    if (!flow.fresh) { const result = originalSend.call(this, raw); stats.clientRequests++; return result; }
    let clientWinType = null, winRecord = null;
    if (packet.name === '.lq.FastTest.inputOperation' || packet.name === '.lq.FastTest.inputChiPengGang') {
      tokens.clear(); generation++; // manual/client action revokes prepared program commands
      if (packet.name === '.lq.FastTest.inputOperation') {
        try {
          const input = body(rpcMap[packet.name].req, packet.data);
          if (input.type === 8 || input.type === 9) { stats.clientWinRequests++; clientWinType = input.type; }
        } catch { fail('CLIENT_OPERATION_DECODE_FAILED'); }
      }
    }
    const id = allocate(flow), rewritten = packet.bytes.slice(); rewritten[1] = id & 255; rewritten[2] = id >> 8;
    if (clientWinType !== null) {
      winRecord = { requestId:id,type:clientWinType,pageEpoch,sourceStream:actionStream,step:lastStep,observedAt:iso(),delivery:'pending',
        offered:operation?.step===lastStep && operation.value.seat===ownSeat && !!operation.value.operation_list?.some(o=>o.type===clientWinType),
        autoWinVerifiedAtRequest:autoWin?.state==='enabled' && autoWin.pageEpoch===pageEpoch && autoWin.generation===generation-1 &&
          autoWin.step===lastStep && performance.now()<autoWin.expiresMonoMs,
        priorAutoWinReadback:winningOffer?.pageEpoch===pageEpoch && winningOffer.sourceStream===actionStream && winningOffer.step===lastStep && winningOffer.priorAutoWinReadback
          ? { ...pick(winningOffer.priorAutoWinReadback,['state','pageEpoch','sourceStream','step','generation','observedAt','rgbaSha256','ageAtOfferMs']),
            ageAtRequestMs:Math.max(0,performance.now()-winningOffer.priorAutoWinReadback.sampledMonoMs) } : null };
      lastClientWin = winRecord;
    }
    flow.pending.set(id, { method: packet.name, bridge: false, clientId: packet.id, winRecord });
    try { const result = originalSend.call(this, rewritten); stats.clientRequests++; return result; }
    catch (error) { if (winRecord) winRecord.delivery='unknown'; flow.pending.delete(id); fail('CLIENT_SEND_FAILED'); throw error; }
  }
  OriginalSocket.prototype.send = send; window.WebSocket = SocketProxy;
  function rpc(method, params, finalCheck) {
    requireThat(gameSocket && gameSocket.readyState === 1, 'GAME_SOCKET_UNAVAILABLE');
    const flow = flows.get(gameSocket); requireThat(flow?.fresh, 'CONNECTION_REATTACH_REQUIRED');
    const id = allocate(flow), bytes = frame(method, params, id);
    let sent = false, invoked = false;
    const work = new Promise((resolve, reject) => {
      const pending = { method, bridge: true, resolve, reject, timer: null };
      flow.pending.set(id, pending);
      try {
        // All code between this check and actual send is synchronous, with no user callbacks.
        if (finalCheck) finalCheck();
        invoked = true; originalSend.call(gameSocket, bytes); sent = true;
        if (method === '.lq.FastTest.syncGame') stats.bridgeSyncRequests++;
        if (method === '.lq.FastTest.inputOperation' || method === '.lq.FastTest.inputChiPengGang') stats.bridgeActionSends++;
        if (flow.pending.has(id)) pending.timer = setTimeout(() => reject(Error('RPC_RECEIPT_TIMEOUT')), 5000);
      } catch (error) { if (!invoked) flow.pending.delete(id); reject(error); }
    });
    return { id, sent, invoked, work };
  }
  function checkFence(input) {
    const { command, intent, snapshot, action, expected } = input;
    requireThat(command && intent && snapshot && action && expected, 'BRIDGE_PREPARE_INVALID');
    requireThat(!restored && !overflow && !reason, 'BRIDGE_UNTRUSTED');
    requireThat(!paused, 'EXECUTION_PAUSED');
    requireThat(records.length === 0 && expected.generation === generation && expected.pageEpoch === pageEpoch && expected.step === lastStep, 'INGRESS_PENDING');
    requireThat(command.attemptId === intent.id && intent.status === 'dispatching', 'DURABLE_INTENT_REQUIRED');
    const f = command.fence;
    requireThat(f && f.processInstanceId === intent.processInstanceId && f.decisionId === intent.decisionId && command.actionId === action.id && intent.actionId === action.id, 'FENCE_STALE');
    for (const key of ['sessionId','matchId','handId','windowId','stateVersion','connectionEpoch','controlEpoch']) requireThat(f[key] === intent[key], 'FENCE_STALE');
    for (const key of ['sessionId','matchId','handId','decisionId']) requireThat(f[key] === snapshot.scope[key], 'FENCE_STALE');
    for (const key of ['windowId','stateVersion','connectionEpoch','controlEpoch']) requireThat(f[key] === snapshot[key], 'FENCE_STALE');
    requireThat(snapshot.sourceCursor && Number(snapshot.sourceCursor.split(':').at(-1)) === lastStep, 'SOURCE_CURSOR_STALE');
    requireThat(processInstanceId === f.processInstanceId, 'PROCESS_INSTANCE_STALE');
    requireThat(f.controlEpoch === controlEpoch, 'FENCE_STALE');
    requireThat(action.authority !== 'client-auto-win' && !['tsumo','ron'].includes(action.action?.kind), 'CLIENT_AUTO_WIN_WINDOW');
    requireThat(action.action?.kind === 'discard' || phase2ActionsEnabled, 'PHASE2_ACTIONS_DISABLED');
    requireThat(intent.executionMode === 'live' && snapshot.state?.ownSeat === ownSeat && intent.actor === ownSeat, 'DURABLE_INTENT_REQUIRED');
    requireThat(snapshot.legalActions?.some(candidate => same(candidate, action)), 'ACTION_NOT_LEGAL');
    if (['discard','riichi-discard'].includes(action.action.kind)) {
      const physical = snapshot.state.ownConcealed?.find(tile => tile.instanceId === action.action.tile);
      const protocolTile = physical?.code.endsWith('r') ? `0${physical.code[1]}` : physical?.code;
      requireThat(physical && protocolTile === input.tile && intent.tile === physical.code && intent.tsumogiri === action.action.tsumogiri, 'ACTION_NOT_LEGAL');
    }
    requireThat(operation && operation.step === lastStep && operation.value.seat === ownSeat, 'WINDOW_CLOSED');
    requireThat(!operation.value.operation_list?.some(o => o.type === 8 || o.type === 9), 'CLIENT_AUTO_WIN_WINDOW');
    requireThat(autoWin?.state === 'enabled' && autoWin.pageEpoch === pageEpoch && autoWin.generation === generation && autoWin.step === lastStep && performance.now() < autoWin.expiresMonoMs, 'AUTO_WIN_UNVERIFIED');
    let request;
    if (phase2ActionsEnabled) {
      requireThat(same(intent.actionSpec, action.action), 'DURABLE_INTENT_REQUIRED');
      request = operationRules.mapActionToRequest(clone(action.action), clone(snapshot.state), clone(operation.value));
    } else {
      requireThat(operation.value.operation_list?.length === 1 && operation.value.operation_list[0].type === 1 && !operation.value.operation_list[0].combination?.length, 'UNSUPPORTED_OPERATION');
      request = { method:'.lq.FastTest.inputOperation',params:{type:1,tile:input.tile,moqie:action.action.tsumogiri,timeuse:0} };
    }
    requireThat(operationTiming && same(input.timing, operationTiming.value) && input.timing.connectionEpoch === f.connectionEpoch, 'DEADLINE_PROVENANCE_UNVERIFIED');
    const now = Date.now();
    requireThat(performance.now() + 250 < operationTiming.deadlineMonoMs, 'DEADLINE_EXCEEDED');
    requireThat(Date.parse(snapshot.actionDeadline) > now && Date.parse(command.expiresAt) > now, 'DEADLINE_EXCEEDED');
    return request;
  }
  const api = {
    read: () => ({ schemaVersion: 1, pageEpoch, generation, lastStep, sourceStream: actionStream, ownSeat,
      paused, controlEpoch, reason, overflow, queued: records.length, freshConnection: !!flows.get(gameSocket)?.fresh,
      pendingRpcCount: [...flows.values()].reduce((count, flow) => count + flow.pending.size, 0),
      operation: operation ? clone(operation) : null, authSummary: authSummary ? clone(authSummary) : null,
      autoWin: autoWin ? { state: autoWin.state, pageEpoch: autoWin.pageEpoch, generation: autoWin.generation, step: autoWin.step,
        observedAt: autoWin.observedAt, rgbaSha256: autoWin.rgbaSha256, expiresInMs: Math.max(0, autoWin.expiresMonoMs-performance.now()) } : null,
      lastClientWin:lastClientWin?clone(lastClientWin):null,lastOwnWin:lastOwnWin?clone(lastOwnWin):null,
      lastAutoWinReadback:lastAutoWinReadback?pick(lastAutoWinReadback,['state','pageEpoch','sourceStream','step','generation','observedAt','rgbaSha256']):null,
      gameUuid, phase2ActionsEnabled, stats: { ...stats }, allocator: 'wire-multiplexer-v1' }),
    drain: () => { const result = { ...api.read(), records: records.splice(0) }; return result; },
    pause: control => {
      paused = true; tokens.clear();
      if (control?.processInstanceId && processInstanceId && control.processInstanceId !== processInstanceId) throw Error('PROCESS_INSTANCE_STALE');
      if (control?.processInstanceId) processInstanceId = control.processInstanceId;
      if (control && Number.isInteger(control.controlEpoch)) {
        requireThat(control.controlEpoch >= controlEpoch, 'FENCE_STALE');
        controlEpoch = control.controlEpoch; paused = control.paused !== false;
      } else { pageEpoch++; paused = true; }
      return { pageEpoch, generation, controlEpoch, paused };
    },
    ackAutoWin(readback) {
      tokens.clear();
      requireThat(!restored && !reason && !overflow && flows.get(gameSocket)?.fresh, 'BRIDGE_UNTRUSTED');
      requireThat(readback?.source === 'unity-button-pixels-v1' && ['enabled','disabled','unknown'].includes(readback.state) && /^[a-f0-9]{64}$/.test(readback.rgbaSha256), 'AUTO_WIN_READBACK_INVALID');
      requireThat(readback.pageEpoch === pageEpoch && readback.generation === generation && readback.step === lastStep, 'AUTO_WIN_READBACK_STALE');
      const age = Date.now()-Date.parse(readback.observedAt);
      requireThat(Number.isFinite(age) && age>=0 && age<1000, 'AUTO_WIN_READBACK_STALE');
      autoWin = { ...pick(readback, ['state','pageEpoch','generation','step','observedAt','rgbaSha256']), expiresMonoMs:performance.now()+1000-age };
      lastAutoWinReadback={ ...pick(readback,['state','pageEpoch','generation','step','observedAt','rgbaSha256']),sourceStream:actionStream,sampledMonoMs:performance.now()-age };
      if(readback.state!=='enabled')winningOffer=null;
      return { state:autoWin.state,pageEpoch,generation,expiresInMs:1000-age };
    },
    ackTiming(timing) {
      tokens.clear(); operationTiming = null;
      requireThat(operation && operation.requestedMonoMs !== undefined && operation.gameState === 1 && operation.lastPauseTimeMs === 0, 'DEADLINE_PROVENANCE_UNVERIFIED');
      requireThat(timing?.source === 'protocol-operation' && timing.origin === 'sync-game' && timing.step === lastStep && timing.pageEpoch === pageEpoch && Number.isInteger(timing.connectionEpoch) && timing.connectionEpoch > 0, 'TIMING_SCOPE_MISMATCH');
      requireThat(timing.sampledAt === operation.receivedAt && timing.sampledMonoMs === operation.receivedMonoMs && timing.fixedMs === operation.value.time_fixed && timing.addMs === 0 && operation.value.time_add === 0 && timing.elapsedMs === operation.passedWaitingTime * 1000, 'TIMING_SCOPE_MISMATCH');
      const rtt = Math.ceil(operation.receivedMonoMs - operation.requestedMonoMs);
      requireThat(rtt >= 0 && rtt <= 30000 && timing.networkAllowanceMs === rtt && timing.quantizationAllowanceMs === 2000 && timing.uncertaintyMs === rtt + 2000 && timing.remainingMs === timing.fixedMs - timing.elapsedMs, 'COUNTDOWN_READBACK_MISMATCH');
      const deadlineMonoMs = timing.sampledMonoMs + timing.remainingMs - timing.uncertaintyMs;
      requireThat(performance.now() + 250 < deadlineMonoMs, 'DEADLINE_EXCEEDED');
      operationTiming = { value:clone(timing),deadlineMonoMs };
      return { verified:true,pageEpoch,step:lastStep,remainingMs:deadlineMonoMs-performance.now() };
    },
    async sync() {
      paused = true; tokens.clear();
      autoWin = null; operationTiming = null;
      const requestedMonoMs = performance.now(), startGeneration = generation;
      const result = await rpc('.lq.FastTest.syncGame', { round_id: '', step: 0 }).work;
      const receivedMonoMs = performance.now(), receivedAt = iso();
      const response = result.response;
      requireThat(!response.error && !response.is_end && response.game_restore, 'SYNC_RESPONSE_INCOMPLETE');
      const actions = response.game_restore.actions.map(a => decodedAction(a, false));
      const firstHandIndex = actions.findIndex(a => a.name === 'ActionNewRound');
      requireThat(actions.length > 0 && (firstHandIndex === 0 || firstHandIndex === 1 && actions[0].name === 'ActionMJStart'), 'SYNC_HISTORY_INCOMPLETE');
      for (let i = 1; i < actions.length; i++) requireThat(actions[i].step === actions[i - 1].step + 1, 'SYNC_HISTORY_GAP');
      requireThat(response.step === actions.at(-1).step + 1, 'SYNC_NEXT_STEP_MISMATCH');
      lastSync = { generation, startGeneration, step: response.step - 1, actions, requestedMonoMs, receivedMonoMs, receivedAt,
        passedWaitingTime:response.game_restore.passed_waiting_time, gameState:response.game_restore.game_state,
        lastPauseTimeMs:response.game_restore.last_pause_time_ms };
      return { schemaVersion: 1, pageEpoch, generation, startGeneration, requestId: result.requestId, requestedMonoMs, receivedMonoMs, receivedAt,
        ownSeat, gameUuid, authSummary: authSummary ? clone(authSummary) : null, step: response.step, is_end: false,
        game_restore: { actions, passed_waiting_time: response.game_restore.passed_waiting_time,
          game_state:response.game_restore.game_state,last_pause_time_ms:response.game_restore.last_pause_time_ms } };
    },
    ackSync(expected) {
      requireThat(lastSync && expected.generation === generation && expected.generation === lastSync.generation && expected.step === lastSync.step, 'SYNC_STALE');
      requireThat(lastSync.startGeneration === lastSync.generation, 'SYNC_INGRESS_RACE');
      seen.clear(); for (const action of lastSync.actions) seen.set(action.step, action.fingerprint);
      roundSignature = lastSync.actions.find(a => a.name === 'ActionNewRound').fingerprint; handEnded = false;
      lastStep = lastSync.step;
      const last = lastSync.actions.at(-1), offered = last.payload.operation;
      operation = offered ? { step:lastStep,receivedMonoMs:lastSync.receivedMonoMs,receivedAt:lastSync.receivedAt,
        requestedMonoMs:lastSync.requestedMonoMs,passedWaitingTime:lastSync.passedWaitingTime,
        gameState:lastSync.gameState,lastPauseTimeMs:lastSync.lastPauseTimeMs,value:clone(offered) } : null;
      observeWinningOffer();
      records.length = 0; overflow = false; reason = null; tokens.clear(); lastSync = null;
      return api.read();
    },
    reconnect() {
      requireThat(gameSocket && gameSocket.readyState === 1, 'GAME_SOCKET_UNAVAILABLE');
      fail('RECONNECT_REQUESTED');
      gameSocket.close(1000, 'maji-state-resync');
      return { reconnectRequested: true, pageEpoch };
    },
    prepare(input) {
      const request = checkFence(input);
      for (const [key, entry] of tokens) if (entry.used || entry.expiresMono <= performance.now()) tokens.delete(key);
      requireThat(tokens.size < 64, 'BRIDGE_PERMIT_CAPACITY');
      const now = Date.now(), ttl = Math.min(Date.parse(input.command.expiresAt) - now,
        Date.parse(input.snapshot.actionDeadline) - now, operationTiming.deadlineMonoMs-performance.now()-250,
        autoWin.expiresMonoMs-performance.now(), 1000);
      requireThat(ttl > 0, 'PERMIT_EXPIRED');
      const token = crypto.randomUUID();
      tokens.set(token, { input: clone(input), request:clone(request),expiresMono: performance.now() + ttl, used: false });
      return { token, pageEpoch, generation, expiresInMs: ttl };
    },
    async dispatch({ command, token }) {
      const entry = tokens.get(token);
      if (!entry || entry.used) return { callId: `bridge:${pageEpoch}:not-sent:${crypto.randomUUID()}`, delivery: 'not-sent', observedAt: iso() };
      entry.used = true;
      const input = entry.input;
      const check = () => {
        requireThat(!paused && same(command, input.command), 'FENCE_STALE');
        requireThat(performance.now() < entry.expiresMono, 'PERMIT_EXPIRED');
        requireThat(command.fence.controlEpoch === controlEpoch && command.fence.processInstanceId === processInstanceId, 'FENCE_STALE');
        requireThat(same(checkFence(input),entry.request), 'ACTION_CHANGED');
      };
      let call;
      try { call = rpc(entry.request.method, entry.request.params, check); }
      catch { return { callId: `bridge:${pageEpoch}:not-sent`, delivery: 'not-sent', observedAt: iso() }; }
      if (!call.sent) { await call.work.catch(() => {}); if (call.invoked) fail('ACTION_UNCERTAIN'); return { callId: `bridge:${pageEpoch}:${call.id}`, delivery: call.invoked ? 'unknown' : 'not-sent', observedAt: iso() }; }
      operation = null; tokens.clear();
      try {
        const result = await call.work;
        return { callId: `bridge:${pageEpoch}:${call.id}`, delivery: result.response.error ? 'rejected' : 'accepted', observedAt: iso() };
      } catch { fail('ACTION_UNCERTAIN'); return { callId: `bridge:${pageEpoch}:${call.id}`, delivery: 'unknown', observedAt: iso() }; }
    },
    restore() {
      paused = true; tokens.clear();
      // Unresolved rewritten client responses still require the mux. Refuse unsafe teardown.
      requireThat([...flows.values()].every(f => f.pending.size === 0), 'BRIDGE_PENDING_REQUESTS');
      restored = true;
      if (OriginalSocket.prototype.send === send) OriginalSocket.prototype.send = originalSend;
      if (window.WebSocket === SocketProxy) window.WebSocket = OriginalSocket;
      for (const [socket, flow] of flows) { socket.removeEventListener('message', flow.message, true); socket.removeEventListener('close', flow.close, true); }
      for (const name of inputEvents) window.removeEventListener(name,localInput,{capture:true});
      flows.clear(); delete window.__majiBridge;
      return { restored: true };
    },
  };
  window.__majiBridge = api;
  return { installed: true, allocator: 'wire-multiplexer-v1', freshConnectionRequired: true };
}
