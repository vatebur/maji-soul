export async function clickWithExpectedScope(page,command) {
  if(!['click','result-click'].includes(command.kind))throw Error('INVALID_COMMAND');
  if(!Number.isFinite(command.x)||!Number.isFinite(command.y)||command.x<0||command.y<0||command.x>=2036||command.y>=918)throw Error('INVALID_COORDINATE');
  if(!Number.isSafeInteger(command.expectedStep)||command.expectedStep<0||
    !Number.isSafeInteger(command.expectedPageEpoch)||command.expectedPageEpoch<1||
    !Number.isSafeInteger(command.expectedSourceStream)||command.expectedSourceStream<0)throw Error('MANUAL_SCOPE_REQUIRED');
  const assertScope=()=>page.evaluate(({step,epoch,sourceStream,resultClick})=>{
    const r=window.__majiBridge.read();
    if(!r.paused||!r.connected||!r.freshConnection||r.reason||r.queued||r.overflow||
      r.lastStep!==step||r.pageEpoch!==epoch||r.sourceStream!==sourceStream)throw Error('MANUAL_SCOPE_CHANGED');
    if(resultClick?!(r.handEnded||r.matchEnded):(r.handEnded||r.matchEnded))throw Error('MANUAL_PHASE_CHANGED');
    if(r.operation?.value?.operation_list?.some(o=>o.type===8||o.type===9))throw Error('CLIENT_AUTO_WIN_WINDOW');
    return {generation:r.generation,controlEpoch:r.controlEpoch,sourceStream:r.sourceStream,nativeRestoreRevision:r.nativeRestoreRevision};
  },{step:command.expectedStep,epoch:command.expectedPageEpoch,sourceStream:command.expectedSourceStream,resultClick:command.kind==='result-click'});
  const beforeClick=await assertScope();
  await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:command.x,y:command.y});
  await page.waitForTimeout(150);
  if(JSON.stringify(await assertScope())!==JSON.stringify(beforeClick))throw Error('MANUAL_SCOPE_CHANGED');
  try {
    await page.cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:command.x,y:command.y,button:'left',clickCount:1});
    await page.waitForTimeout(100);
  } finally {
    await page.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:command.x,y:command.y,button:'left',clickCount:1});
  }
  return {pageEpoch:command.expectedPageEpoch,sourceStream:beforeClick.sourceStream,
    nativeRestoreRevision:beforeClick.nativeRestoreRevision,controlEpoch:beforeClick.controlEpoch};
}
