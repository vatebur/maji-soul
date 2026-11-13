import type { RoomTimeSetting } from './types.ts';
import { requireThat } from './value.ts';

const clocks: Record<RoomTimeSetting, readonly [number, number]> = {
  '5+20': [5, 20], '60+0': [60, 0], '300+0': [300, 0],
};

/** Room configuration uses seconds; live operation windows use milliseconds. */
export function roomClockSeconds(setting: RoomTimeSetting): readonly [number, number] {
  requireThat(Object.hasOwn(clocks, setting), 'FRIEND_ROOM_CLOCK_UNSUPPORTED');
  return [...clocks[setting]];
}

export function identifyRoomTimeSetting(fixedSeconds: unknown, addSeconds: unknown): RoomTimeSetting | undefined {
  return (Object.keys(clocks) as RoomTimeSetting[]).find(setting => {
    const [fixed, add] = clocks[setting];
    return fixedSeconds === fixed && addSeconds === add;
  });
}
