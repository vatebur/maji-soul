const openings=[
  '牌桌已经摆好了，欢迎直播间的朋友来坐坐', '想把观战变成亲自上场吗，这一桌正在等你',
  '刚来的朋友也能一起玩，今天就从这桌友人局认识吧', '不用只在弹幕里猜出牌，欢迎来桌上分享你的选择',
  '有空打个半庄的朋友，可以准备进房啦', '这局留了位置给屏幕前的你，一起切磋牌技吧',
  '新手老手都欢迎，放轻松来打一桌', '看牌看得手痒了吗，来友人房和我们一起玩吧',
  '把你喜欢的打法带来牌桌，欢迎一起交流', '观众朋友们，下一桌的同伴正在招募中',
  '这里有一张等你落座的牌桌，欢迎来玩', '来和直播间的小伙伴交个牌友吧',
];
const endings=[
  '在雀魂友人场选择加入房间，输入号码就能找到我们。',
  '默认是四人半庄，每次出牌五秒，另有二十秒长考。',
  '进房后记得准备，我们会在招募结束后一起开局。',
  '招募时间结束才会用电脑补空位，想参加的朋友抓紧入座。',
  '一起享受摸牌和思考的过程，输赢之外也有交流的乐趣。',
  '可以一边看直播一边来切磋，进房后别忘了点准备。',
];
/** Every combination is used at most once per room campaign; no model is needed to keep invitations varied. */
export function invitation(roomId:string,index:number){
  const opening=openings[index%openings.length]!,ending=endings[(index+Math.floor(index/openings.length))%endings.length]!;
  return `${opening}。房间号是${roomId.split('').join('，')}。${ending}`;
}
export const invitationCount=openings.length*endings.length;
