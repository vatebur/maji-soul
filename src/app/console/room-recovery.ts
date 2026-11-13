import { setTimeout as delay } from 'node:timers/promises';
import { bridgeCall, type EgoPagePort } from '../../adapters/majsoul/ego-transport.ts';
import { installLiveBridge } from '../../adapters/majsoul/install.ts';
import { readLobbyScreen } from '../../adapters/majsoul/lobby-screen.ts';
import { dismissEndedGameNotice, hasEndedGameNoticeScope } from '../../adapters/majsoul/ended-game-notice.ts';
import type { FriendRoom } from '../../domain/game/types.ts';

/** Called only after the match worker has exited. Refresh invalidates every old
 * browser permit; room ownership is re-proven by the bridge before any RPC. */
export async function recoverAudienceRoom(page: EgoPagePort, _configured: FriendRoom, signal: AbortSignal,
  driver: { call: typeof bridgeCall; install: typeof installLiveBridge; sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    screen?: typeof readLobbyScreen; now?: () => number; dismissNotice?: typeof dismissEndedGameNotice } = {
    call: bridgeCall, install: installLiveBridge, screen: readLobbyScreen,
    dismissNotice: dismissEndedGameNotice,
    sleep: (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
  }) {
  signal.throwIfAborted();
  await driver.call(page, 'pause').catch(() => {});
  signal.throwIfAborted();
  await driver.install(page, true, { akagiEnabled: true });
  const now = driver.now ?? (() => performance.now()), until = now() + 60_000;
  let noticeDismissed = false;
  while (!signal.aborted) {
    try {
      const room = await driver.call(page, 'inspectRoom');
      signal.throwIfAborted();
      await driver.call(page, 'abandonOwnedRoom', { roomId: room.roomId });
      signal.throwIfAborted();
      await driver.install(page, true, { akagiEnabled: true });
      return;
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof Error ? error.message : '';
      // A generic fetch failure does not prove the old room disappeared. The
      // native lobby must visibly confirm that we're outside any room/game.
      if (code === 'ROOM_NOT_READY' && driver.screen) {
        const screen = await driver.screen(page);
        signal.throwIfAborted();
        if (['home', 'friend', 'create'].includes(screen.screen)) return;
        if (screen.screen === 'unknown' && !noticeDismissed && driver.dismissNotice) {
          const current = await driver.call(page, 'read');
          signal.throwIfAborted();
          if (hasEndedGameNoticeScope(current) && await driver.dismissNotice(page, signal)) {
            signal.throwIfAborted();
            noticeDismissed = true;
            continue;
          }
        }
      }
      if (now() >= until && ['LOBBY_NOT_READY', 'ROOM_NOT_READY'].includes(code)) {
        const current = await driver.call(page, 'read');
        if (current?.lobbyAuthenticated === false && !current.authSummary) throw Error('LOGIN_REQUIRED');
      }
      if (!['ROOM_NOT_READY', 'LOBBY_NOT_READY', 'BRIDGE_MISSING', 'RPC_CONNECTION_CLOSED', 'RPC_RECEIPT_TIMEOUT', 'ROOM_RECOVERY_NOT_FINISHED', 'ROOM_RECOVERY_GAME_UNVERIFIED'].includes(code) ||
          now() >= until) throw error;
      await driver.sleep(1_000, signal);
    }
  }
}
