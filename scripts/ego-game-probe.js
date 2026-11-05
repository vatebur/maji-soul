// Phase 0 only: install with current extracted protocol and protobufjs in the Page.
// No authentication payload, player identity, account token or hidden hand is retained.
// Action XOR adaptation: Akagi 63cea4b5, Copyright 2026 Shinkuan, Apache-2.0.
// Original license and notice: docs/research/licenses/akagi-{LICENSE,NOTICE}.txt.
export function installGameProbe({ proto, rpcMap }) {
  window.__majiGameProbe?.restore();
  const root = window.protobuf.parse(proto, { keepCase:true }).root;
  const wrapper = root.lookupType('lq.Wrapper');
  const original = WebSocket.prototype.send;
  const flows = new Map(), records = [];
  let ownSeat, ownAccount, gameSocket, lastAction, nextId = 60000, epoch = 1, gap = false, overflow = false;
  function obj(type, bytes) { const t=root.lookupType(type);return t.toObject(t.decode(bytes),{defaults:true,bytes:Array,longs:Number}); }
  function push(record) { records.push(record); if(records.length>512){records.shift();overflow=true;} }
  function action(name,bytes,step,encrypted) {
    const data = new Uint8Array(bytes);
    if(encrypted){const keys=[0x84,0x5e,0x4e,0x42,0x39,0xa2,0x1f,0x60,0x1c],base=23^data.length;for(let i=0;i<data.length;i++)data[i]^=(base+5*i+keys[i%9])&255;}
    const decoded = obj(name.startsWith('.')?name:`lq.${name}`,data);
    if(lastAction && name!=='ActionNewRound' && step!==lastAction.step+1)gap=true;
    // Whitelist visible game facts. All unrelated/proprietary fields are discarded.
    const safe={};
    for(const key of ['seat','tile','moqie','is_liqi','chang','ju','ben','liqibang','scores','doras','left_tile_count','operation','md5','gameend'])if(key in decoded)safe[key]=decoded[key];
    if(name==='ActionNewRound') {
      safe.tiles=decoded.tiles; // current player's visible hand only
      safe.round_id=decoded.round_id;
    }
    lastAction={name,step,...safe}; push({kind:'action',name,step,at:performance.now(),data:safe});
    return decoded;
  }
  function handle(socket,raw,direction) {
    const bytes=raw instanceof ArrayBuffer?new Uint8Array(raw):ArrayBuffer.isView(raw)?new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength):null;
    if(!bytes||bytes.length<2)return;
    const type=bytes[0],id=type===1?undefined:bytes[1]+bytes[2]*256;
    const w=wrapper.decode(bytes.subarray(type===1?1:3));
    const flow=flows.get(socket),name=type===3?flow.pending.get(id):w.name;
    if(type===2){flow.pending.set(id,name);if(flow.pending.size>512){flow.pending.clear();gap=true;}}
    if(type===3)flow.pending.delete(id);
    if(!name)return;
    const route=rpcMap[name];
    if(name==='.lq.FastTest.authGame') {
      const d=obj(type===2?route.req:route.resp,w.data);
      if(type===2)ownAccount=d.account_id;
      if(type===3){ownSeat=d.seat_list?.indexOf(ownAccount);gameSocket=socket;ownAccount=undefined;push({kind:'auth-summary',ownSeat,gameConfig:{category:d.game_config?.category,mode:d.game_config?.mode}});}
      return;
    }
    if(name==='.lq.ActionPrototype'&&type===1){const d=obj(name,w.data);action(d.name,d.data,d.step,true);return;}
    const allowed=['.lq.Lobby.createRoom','.lq.Lobby.fetchRoom','.lq.Lobby.addRoomRobot','.lq.Lobby.startRoom','.lq.FastTest.inputOperation','.lq.FastTest.inputChiPengGang','.lq.FastTest.syncGame','.lq.FastTest.enterGame','.lq.FastTest.finishSyncGame'];
    if(!allowed.includes(name))return;
    const d=obj(type===2?route.req:route.resp,w.data);
    let safe;
    if(name.includes('Room'))safe={mode:d.mode??d.room?.mode,player_count:d.player_count??d.room?.max_player_count,robot_count:d.room?.robot_count,error:d.error};
    else if((name.endsWith('syncGame')||name.endsWith('enterGame'))&&type===3)safe={error:d.error,is_end:d.is_end,step:d.step,restoreActions:d.game_restore?.actions?.map(a=>{const decoded=obj(a.name.startsWith('.')?a.name:`lq.${a.name}`,new Uint8Array(a.data));return {name:a.name,step:a.step,decoded:true,visibleHandCount:decoded.tiles?.length,operationTypes:decoded.operation?.operation_list?.map(o=>o.type)};}),snapshotHandCount:d.game_restore?.snapshot?.hands?.length,restoreKeys:Object.keys(d.game_restore??{})};
    else if(name.endsWith('inputOperation')&&type===2)safe={type:d.type,tile:d.tile,moqie:d.moqie,timeuse:d.timeuse};
    else safe={error:d.error};
    push({kind:direction,name,requestId:id,data:safe,at:performance.now()});
  }
  function attach(socket) {
    if(flows.has(socket))return;
    const message=e=>{try{handle(socket,e.data,'response');}catch{gap=true;push({kind:'decode-error'});}};
    const close=()=>{epoch++;gap=true;push({kind:'closed'});};
    flows.set(socket,{pending:new Map(),message,close});
    socket.addEventListener('message',message);socket.addEventListener('close',close);
  }
  const send=function(data){attach(this);try{handle(this,data,'request');}catch{gap=true;}return original.call(this,data);};
  WebSocket.prototype.send=send;
  function rpc(method,params,permit) {
    if(!permit||permit.epoch!==epoch||permit.used||permit.expiresAt<performance.now())throw Error('FENCE_STALE');
    if(!gameSocket||gameSocket.readyState!==1||gap||overflow)throw Error('BRIDGE_UNTRUSTED');
    if(!['.lq.FastTest.syncGame','.lq.FastTest.inputOperation'].includes(method))throw Error('METHOD_NOT_ALLOWED');
    if(method.endsWith('inputOperation')&&permit.step!==lastAction?.step)throw Error('WINDOW_CLOSED');
    const route=rpcMap[method],t=root.lookupType(route.req),data=t.encode(t.fromObject(params)).finish();
    const body=wrapper.encode({name:method,data}).finish(),id=nextId++;
    if(nextId>65000)throw Error('PROBE_ID_RANGE_EXHAUSTED');
    const frame=new Uint8Array(body.length+3);frame[0]=2;frame[1]=id&255;frame[2]=id>>8;frame.set(body,3);
    permit.used=true;
    // Fence and pending state are checked in the same synchronous JS turn as send.
    gameSocket.send(frame);
    return {requestId:id,sentAt:performance.now(),epoch};
  }
  window.__majiGameProbe={
    read:()=>({schemaVersion:1,ownSeat,epoch,gap,overflow,lastAction,records:records.slice(),productionReady:false}),
    pause:()=>{epoch++;return epoch;},
    permit:()=>({epoch,step:lastAction?.step,expiresAt:performance.now()+1000,used:false}),rpc,
    restore:()=>{if(WebSocket.prototype.send===send)WebSocket.prototype.send=original;for(const [s,h]of flows){s.removeEventListener('message',h.message);s.removeEventListener('close',h.close);}flows.clear();delete window.__majiGameProbe;}
  };
  return {installed:true,productionReady:false};
}
