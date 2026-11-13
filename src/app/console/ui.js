const node = id => document.getElementById(id);
let state, config, output, cursor, eventSource, busy = false;
let archiveSequence = null, archiveRequest = 0;
const buttons = [...document.querySelectorAll('button[data-command]')];
const statuses = { running: '运行中', paused: '已暂停', stopping: '本场后停止', stopped: '已停止', faulted: '运行异常' };
const modes = { engine: '专用引擎', llm: 'LLM' };
const winds = { '1z': '东', '2z': '南', '3z': '西', '4z': '北' };
const time = value => new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.code ?? 'HTTP_' + response.status);
  return result.data;
}
function error(message) {
  node('error').textContent = message;
  node('error').hidden = !message;
}
function render() {
  if (!state || !output) return;
  const { session, game, speech, interaction } = state;
  const active = session && session.status !== 'stopped';
  node('source').textContent = output.source === 'replay' ? '回放演练 · 使用已保存的游戏事件' : state.automation?.available ? '实场控制 · 自动出牌与连续对局' : '台账跟随 · 只读游戏状态';
  node('run').textContent = session ? `${statuses[session.status]} · 完成 ${session.completedMatches} 场${session.pauseReason ? ' · ' + session.pauseReason : ''}` : output.source === 'replay' ? '当前没有回放运行' : '实场台账已连接 · 持续运行';
  node('game').textContent = game
    ? `${winds[game.roundWind] ?? ''}${game.handNumber}局 · ${game.honba}本场 · ${game.trust === 'trusted' ? '已同步' : '状态待同步'} · ${time(game.observedAt)} · 当前 ${modes[session?.activeMode] ?? '—'} / 下局 ${modes[session?.pendingMode] ?? '—'}`
    : '等待对局事实';
  node('speech').textContent = `语音 ${speech.muted ? '静音' : speech.playingSpeechId ? '播报中' : '空闲'} · 待播 ${speech.pendingCount}`;
  node('avatar-status').hidden = node('avatar-controls').hidden = !output.avatar;
  if (output.avatar) {
    node('avatar-status').textContent = output.avatar.connected ?
      `Live2D 已连接 · ${output.avatar.speaking ? '正在说话' : output.avatar.phase === 'prepare' ? '正在准备动作' : '待机'}` :
      '等待 OBS 角色页面连接；角色模式的声音由该页面播放。';
    node('avatar-address').value = location.origin + '/avatar';
    node('avatar-test').disabled = !output.avatar.connected || speech.muted || !!speech.playingSpeechId || speech.pendingCount > 0;
  }
  node('interaction').textContent = `弹幕 ${interaction.roomId ?? '未配置'} · ${interaction.connection} · ${interaction.dryRun ? '预演' : '真实回发'}`;
  const bili = output.bilibili;
  const biliErrors = { BILI_LOGIN_REQUIRED: '登录已失效，请更新本机登录文件', BILI_ACCOUNT_CHANGED: '登录账号不一致，请检查本机配置',
    BILI_ACCESS_DENIED: '平台拒绝连接', BILI_HTTP_429: '平台限流，请稍后重新连接', BILI_WS_AUTH_REJECTED: '弹幕认证被拒绝',
    BILI_MESSAGE_UNSUPPORTED: '部分弹幕缺少可验证身份或消息编号，已跳过', BILI_HEARTBEAT_TIMEOUT: '连接心跳超时，正在重连' };
  node('bili-source').textContent = bili?.mode === 'direct' ? `直连 B站 · 已收 ${bili.receivedCount} 条 · 跳过 ${bili.droppedCount} 条` +
    (bili.roomId ? ` · 实际房间 ${bili.roomId}` : '') + (bili.accountId ? ` · 账号 ${bili.accountId}` : '') +
    (bili.errorCode ? ` · ${biliErrors[bili.errorCode] ?? '连接异常，等待恢复'}` : '') : '';
  node('receipts').textContent = `最近语音 ${output.lastSpeech?.outcome ?? '—'} · 最近回发 ${output.lastDelivery?.status ?? '—'}`;
  const model = output.commentary;
  node('commentary').textContent = !model.enabled ? '解说使用事实模板' : !model.available ? '解说服务未配置，使用事实模板' :
    model.busy ? '正在生成解说' : model.last?.source === 'llm' ? '最近解说已引用事实证据' :
    model.last?.code === 'MODEL_HTTP_429' ? '模型服务限流，已使用事实模板' :
    model.last?.code === 'MODEL_TIMEOUT' ? '解说生成超时，已使用事实模板' :
    model.last?.code ? '解说服务暂不可用，已使用事实模板' : '模型解说已就绪';
  node('mute').textContent = speech.muted ? '解除静音' : '静音';
  const automation = state.automation;
  node('automation-actions').hidden = !automation?.available;
  node('automation-toggle').textContent = automation?.enabled ? '停止自动出牌' : '启用自动出牌';
  node('automation-toggle').setAttribute('aria-pressed', String(!!automation?.enabled));
  const automationStates = { creating:'正在创建房间', recruiting:'正在招募观众', recovering:'正在重启恢复', idle: '未启用', starting: '正在连接', playing: '自动出牌中', waiting: '等待下一场', stopping: '正在停止', stopped: '已停止', faulted: '运行异常' };
  const automationErrors = {
    MATCH_OBSERVATION_LIMIT: '当前对局观察中断',
    CONTROL_BARRIER_FAILED: '接管牌局失败',
    COUNTDOWN_EXPIRED: '当前操作已超过安全出牌时限',
    COUNTDOWN_VIEWPORT_MISMATCH: '牌桌画面尺寸不匹配',
    AUTO_WIN_VIEWPORT_MISMATCH: '牌桌画面尺寸不匹配',
    AUTOMATION_HEARTBEAT_TIMEOUT: '自动出牌进程未响应',
    AUTOMATION_PROGRESS_TIMEOUT: '对局长时间没有进展',
    BROWSER_CONTROL_WITH_USER: '浏览器已由用户接管，请交还控制后启用',
    LOGIN_REQUIRED: '自动恢复未完成，请在雀魂页面登录后重新启用',
    ROOM_OWNER_REQUIRED: '需要由当前账号担任四人友人房房主',
    DEFAULT_ROOM_RULES_MISMATCH: '房间规则或时钟与目标设置不一致',
    ROOM_PLAYERS_NOT_READY: '请等待房内玩家点击准备后重试',
    ROOM_FILL_REJECTED: '补电脑失败，请检查当前房间',
    LOBBY_NOT_READY: '大厅连接未就绪，请等待雀魂加载完成后重试',
    ROOM_NOT_READY: '未进入可用的友人房，请先进入配置的房间后重试',
    ROOM_FETCH_FAILED: '读取友人房失败，请检查雀魂连接后重试',
    ROOM_MISMATCH: '当前友人房与配置不一致，请检查房间号',
    ROBOT_ROOM_REQUIRED: '需要房主本人及三个电脑的四人友人房',
    GAME_START_TIMEOUT: '开局后未收到对局连接，请检查雀魂页面后重试',
  };
  node('automation-status').textContent = automation?.available
    ? `自动出牌：${automationStates[automation.status]}${automation.roomId ? ' · 房间 ' + automation.roomId : ''}${automation.recruitUntil && automation.status === 'recruiting' ? ' · 招募剩余 ' + Math.max(0, Math.ceil((Date.parse(automation.recruitUntil) - Date.now()) / 1000)) + ' 秒' : ''} · 已完成 ${automation.completedMatches} 场${automation.recoveryCount ? ' · 已恢复 ' + automation.recoveryCount + ' 次' : ''}${automation.nextRetryAt ? ' · ' + time(automation.nextRetryAt) + ' 重试' : ''}${automation.errorCode ? ' · ' + (automationErrors[automation.errorCode] ?? automation.errorCode) : ''}` : '';
  const relay = state.relay;
  const relayStates = { idle: '未启动', starting: '正在连接画面', live: '转播中', recovering: '正在自动恢复画面', stopped: '已停止', faulted: '转播异常' };
  const relayErrors = { RELAY_PORT_IN_USE: '转播地址已被占用，正在等待重试。',
    RELAY_START_FAILED: '转播启动失败，正在自动重试。',
    RELAY_CAPTURE_FAILED: '画面连接已中断，正在自动恢复。',
    RELAY_FRAME_TIMEOUT: '画面更新超时，正在重新连接。' };
  node('relay-status').textContent = relay?.available ? (relayStates[relay.status] ?? '等待状态') +
    (relay.status === 'live' ? ` · ${relay.fps} 帧/秒` : '') + (relay.nextRetryAt ? ` · ${time(relay.nextRetryAt)} 重试` : '') : '当前模式不支持画面转播';
  node('relay-help').textContent = !relay?.available ? '以实场模式启动控制台后，可转播同一张雀魂页面。' :
    relay.errorCode ? relayErrors[relay.errorCode] ?? '转播暂不可用，请停止后重新启动。' :
    '实场模式自动开启干净画面转播，手动关闭后保持关闭。声音继续使用 OBS 的音频采集。';
  node('relay-toggle').textContent = relay?.enabled ? '停止转播' : '启动转播';
  node('relay-toggle').setAttribute('aria-pressed', String(!!relay?.enabled));
  const relayUrl = relay?.enabled ? relay.obsUrl : null;
  node('relay-open').hidden = !relayUrl;
  if (relayUrl) node('relay-open').href = relayUrl;
  else node('relay-open').removeAttribute('href');
  node('relay-address-label').hidden = !relayUrl;
  node('relay-address').value = relayUrl ?? '';
  node('relay-copy').disabled = !relayUrl;
  const size = relay?.dimensions;
  node('relay-dimensions').textContent = relayUrl && size ? `OBS 宽度填 ${size.width}，高度填 ${size.height}；调整浏览器窗口后，以这里的最新尺寸为准。` : '';
  const preview = node('relay-preview');
  const previewUrl = relay?.enabled && node('relay-preview-toggle').checked ? relay.previewUrl : null;
  preview.hidden = !previewUrl;
  if (previewUrl && preview.getAttribute('src') !== previewUrl) preview.src = previewUrl;
  if (!previewUrl) preview.removeAttribute('src');
  node('game-reset-actions').hidden = output.source !== 'follow';
  node('run-actions').hidden = output.source !== 'replay';
  const enabled = {
    'control/start': !active, 'control/pause': active && ['running','stopping'].includes(session.status),
    'control/resume': session?.status === 'paused', 'control/end': active && ['paused','faulted'].includes(session.status),
    'control/stop-after-match': active && !session.stopAfterMatch, 'control/next-mode': active,
    'display/reset': output.source === 'follow' && !!game && !automation?.enabled && !['starting','playing','waiting','stopping'].includes(automation?.status),
    'automation/set': automation?.available && automation.status !== 'stopping',
    'relay/set': relay?.available,
    'speech/mute': true, 'speech/clear': true,
  };
  for (const button of buttons) button.disabled = busy || !enabled[button.dataset.command];
  const next = (game ? `${game.matchId}/${game.stateVersion}` : 'empty') + '/' + (output.commentary.last?.finishedAt ?? '');
  if (next !== archiveSequence) {
    archiveSequence = next;
    void loadArchive().catch(err => { if (archiveSequence === next) archiveSequence = null; error(err.message); });
  }
}
async function loadArchive() {
  const revision = ++archiveRequest;
  const { items } = await api('discards');
  if (revision !== archiveRequest) return;
  node('discards').replaceChildren(...items.map(item => {
    const entry = document.createElement('li'), at = document.createElement('time');
    entry.textContent = item.text ?? '此条档案已按规则隐藏';
    at.dateTime = item.observedAt;
    at.textContent = time(item.observedAt);
    entry.append(at);
    const details = document.createElement('details'), label = document.createElement('summary');
    label.textContent = '查看证据';
    details.append(label, document.createTextNode((item.source === 'llm' ? '模型选取证据 · ' : '事实模板 · ') + item.evidenceIds.join('、')));
    if (item.limitations.length) details.append(document.createElement('br'), document.createTextNode(item.limitations.join('')));
    if (item.decisionId) {
      const link = document.createElement('a');
      link.href = '/api/decisions/' + encodeURIComponent(item.decisionId);
      link.textContent = '查看冻结决策';
      link.target = '_blank';
      link.rel = 'noopener';
      details.append(' · ', link);
    }
    entry.append(details);
    return entry;
  }));
}
async function loadConfig() {
  const [view, capabilities] = await Promise.all([api('config'), api('capabilities')]);
  config = view;
  const v = view.values;
  node('room').value = v.interaction.roomId ?? '';
  const voices = [...new Set([v.speech.voiceId, ...capabilities.voices.map(voice => voice.id)])];
  node('voice').replaceChildren(...voices.map(id => new Option(id, id)));
  node('voice').value = v.speech.voiceId;
  node('phrase').value = v.persona.catchphrases[0] ?? '';
  node('persona-style').value = v.persona.style;
  node('commentary-profile').replaceChildren(new Option('事实模板', 'disabled'),
    ...capabilities.modelProfiles.filter(profile => profile.purposes.includes('explanation')).map(profile => new Option('本机配置的模型', profile.id)));
  if (v.models.commentaryProfile === 'local' && !capabilities.modelProfiles.length)
    node('commentary-profile').append(new Option('模型配置不可用', 'local'));
  node('commentary-profile').value = v.models.commentaryProfile;
  node('commentary-interval').value = v.models.commentaryIntervalMs / 1000;
  node('rules').value = JSON.stringify(v.moderation.rules, null, 2);
  node('dry-run').checked = v.interaction.dryRun || !view.readOnly.bilibiliCredentialsConfigured;
  node('dry-run').disabled = !view.readOnly.bilibiliCredentialsConfigured;
  node('show-scores').checked = v.output.showScores;
  node('theme').value = v.output.theme;
}
async function refreshOutput() { output = await api('output/status'); render(); }
function apply(snapshot) {
  const p = snapshot.projection;
  if (cursor?.epoch === p.epoch && cursor.revision >= p.revision) return;
  cursor = p;
  state = snapshot.state;
  render();
  void refreshOutput().catch(err => error(err.message));
}
function subscribe() {
  eventSource?.close();
  eventSource = new EventSource('/api/console/events?after=' + encodeURIComponent(cursor.cursor));
  for (const event of ['snapshot','reset']) eventSource.addEventListener(event, message => apply(JSON.parse(message.data)));
  eventSource.onopen = () => { node('connection').textContent = '本机连接已建立'; };
  eventSource.onerror = () => { node('connection').textContent = '连接中断，正在重连'; };
}
const commandId = () => ({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString() });
const sessionId = () => state.session?.status === 'stopped' ? null : state.session?.id ?? null;
async function action(task) {
  if (busy) return;
  busy = true; render(); error('');
  try { await task(); }
  catch (err) { error(err.message); }
  finally { busy = false; render(); }
}
for (const button of buttons) button.addEventListener('click', () => void action(async () => {
  const name = button.dataset.command;
  const body = { ...commandId(), ...(name === 'control/start' ? { expectedConfigRevision: state.configRevision } : { sessionId: sessionId() }) };
  if (['control/resume','control/end','control/next-mode'].includes(name)) body.expectedControlEpoch = state.session.controlEpoch;
  if (name === 'control/next-mode') body.mode = node('next-mode').value;
  if (name === 'automation/set') body.enabled = !state.automation.enabled;
  if (name === 'relay/set') body.enabled = !state.relay.enabled;
  if (name === 'speech/mute') body.muted = !state.speech.muted;
  await api(name, 'POST', body);
  apply(await api('console/snapshot'));
}));
node('settings').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const values = config.values;
    const changes = {
      interaction: { roomId: node('room').value || null, dryRun: node('dry-run').checked },
      moderation: { rules: JSON.parse(node('rules').value) },
      output: { showScores: node('show-scores').checked, theme: node('theme').value },
    };
    const phrase = node('phrase').value.trim();
    if (phrase !== (values.persona.catchphrases[0] ?? '')) changes.persona = { catchphrases: phrase ? [phrase, ...values.persona.catchphrases.slice(1)] : [] };
    if (node('persona-style').value !== values.persona.style) changes.persona = { ...changes.persona, style: node('persona-style').value };
    if (node('commentary-profile').value !== values.models.commentaryProfile) changes.models = { commentaryProfile: node('commentary-profile').value };
    const commentaryIntervalMs = Number(node('commentary-interval').value) * 1000;
    if (commentaryIntervalMs !== values.models.commentaryIntervalMs) changes.models = { ...changes.models, commentaryIntervalMs };
    if (node('voice').value !== values.speech.voiceId) changes.speech = { voiceId: node('voice').value };
    await api('config', 'PATCH', { ...commandId(), sessionId: sessionId(), expectedRevision: config.revision, changes });
    await loadConfig();
    await loadArchive();
  });
});
node('reload').addEventListener('click', () => void action(loadConfig));
node('relay-preview-toggle').addEventListener('change', render);
node('relay-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(node('relay-address').value); node('relay-copy').textContent = '已复制'; }
  catch { node('relay-address').focus(); node('relay-address').select(); error('请复制已选中的 OBS 地址。'); }
  setTimeout(() => { node('relay-copy').textContent = '复制 OBS 地址'; }, 2000);
});

try {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const [snapshot, status] = await Promise.all([api('console/snapshot'), api('output/status'), loadConfig()]);
  output = status;
  apply(snapshot);
  node('console').hidden = false;
  subscribe();
} catch (err) {
  node('connection').textContent = '无法连接控制台，请确认程序已启动后刷新页面。';
  error(err.message);
}

setInterval(() => { if(state?.automation?.status === "recruiting") render(); }, 1000);

node('avatar-test').addEventListener('click', async () => {
  node('avatar-test').disabled = true;
  try {
    const response = await fetch('/api/avatar/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw Error(result.error === 'AVATAR_TEST_COOLDOWN' ? '请等待 30 秒后再次试听。' : '角色暂时无法试听，请确认角色已连接且语音未静音。');
    error('');
  } catch (failure) { error(failure.message); }
  finally { render(); }
});
