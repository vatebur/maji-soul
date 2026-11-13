import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomClockSeconds, identifyRoomTimeSetting } from '../src/domain/game/room-clock.ts';
import { validateRoom } from '../src/schemas/game.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';

test('room clocks accept exactly the supported seconds-based settings', () => {
  for (const [setting, fixed, add] of [['5+20', 5, 20], ['60+0', 60, 0], ['300+0', 300, 0]] as const) {
    assert.deepEqual(roomClockSeconds(setting), [fixed, add]);
    assert.equal(identifyRoomTimeSetting(fixed, add), setting);
    const room = structuredClone(buildPhase1Fixture().events.find(event => event.type === 'RoomVerified')!.payload.room);
    room.rules.displayTimeSetting = setting;
    assert.doesNotThrow(() => validateRoom(room));
  }
  for (const [fixed, add] of [[10, 20], [20, 0], [60, 20], [60000, 0], ['60', 0], [60, undefined]])
    assert.equal(identifyRoomTimeSetting(fixed, add), undefined);
  assert.throws(() => roomClockSeconds('10+20' as any), /FRIEND_ROOM_CLOCK_UNSUPPORTED/);
});

test('changing a returned clock tuple cannot change subsequent room verification', () => {
  const values = roomClockSeconds('60+0');
  Reflect.set(values, 0, 300);
  assert.deepEqual(roomClockSeconds('60+0'), [60, 0]);
  assert.equal(identifyRoomTimeSetting(60, 0), '60+0');
});
