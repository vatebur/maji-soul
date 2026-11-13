const status = document.querySelector('#status');
const scores = document.querySelector('#scores');
let current = null, online = false;
const winds = { '1z': '东', '2z': '南', '3z': '西', '4z': '北' };

function render() {
  const state = current?.state, game = state?.game;
  document.body.dataset.theme = state?.theme ?? 'dark';
  const room=state?.automation;
  status.textContent = online && room?.enabled && room.status==='recruiting' ? `欢迎加入友人房 ${room.roomId} · 招募剩余 ${Math.max(0,Math.ceil((Date.parse(room.recruitUntil)-Date.now())/1000))} 秒` : !online ? '输出连接中断 · 等待更新' : game
    ? `${winds[game.roundWind] ?? ''}${game.handNumber}局 · ${game.honba}本场 · ${game.handStatus === 'finished' ? '已结算' : game.handStatus === 'interrupted' ? '已中断' : game.trust === 'trusted' ? '已同步' : '状态待同步'}`
    : '等待对局';
  scores.textContent = online && game?.scores ? Object.values(game.scores).join('　·　') : '';
  for (const key of ['subtitle', 'interaction']) {
    const node = document.getElementById(key), card = state?.[key];
    const visible = online && card && (!card.expiresAt || Date.parse(card.expiresAt) > Date.now());
    node.textContent = visible ? card.text : '';
    node.hidden = !visible;
  }
}

const stream = new EventSource('/api/obs/events');
for (const event of ['snapshot','reset']) stream.addEventListener(event, message => {
  const next = JSON.parse(message.data);
  if (current?.projection.epoch === next.projection.epoch && current.projection.revision >= next.projection.revision) return;
  current = next;
  online = true;
  render();
});
stream.onopen = () => { online = true; render(); };
stream.onerror = () => { online = false; render(); };
setInterval(render, 1000);
