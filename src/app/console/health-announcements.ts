import type { AutomationView } from './automation.ts';
import type { RelayView } from './relay.ts';
import type { SpeechContent } from '../../application/live/speech.ts';

type Incident = { source: string; key: string; text: string };
const cooldownMs = 60_000;

/** Fixed, bounded notices keep recovery audible even when the model is unavailable. */
export class HealthAnnouncements {
  #seen = new Map<string, string>();
  #lastSpokenAt = new Map<string, number>();
  #pending = new Map<string, Incident>();

  observe(automation: AutomationView | undefined, relay: RelayView | undefined, storageError: string | null, now: number) {
    const code = automation?.lastErrorCode ?? automation?.errorCode;
    if (code) {
      const manual = ['LOGIN_REQUIRED', 'BROWSER_CONTROL_WITH_USER', 'ROOM_OWNER_REQUIRED', 'DEFAULT_ROOM_RULES_MISMATCH'].includes(code);
      const retrying = automation?.enabled && automation.status !== 'faulted';
      const recovered = retrying && ['playing', 'waiting', 'recruiting'].includes(automation.status);
      this.#record({ source: 'automation',
        key: `${code}/${automation?.lastErrorAt ?? ''}/${automation?.recoveryCount ?? ''}`,
        text: manual ? '[无奈]对局需要人工处理。[平静]请查看控制台提示。' : recovered
          ? '[无奈]刚才出牌发生异常。[平静]对局已自动恢复。' : retrying
          ? '[无奈]自动出牌遇到异常。[平静]正在重建房间重试。'
          : '[无奈]自动出牌已暂停。[平静]请查看控制台提示。' });
    } else this.#reset('automation');
    if (relay?.errorCode) this.#record({ source: 'relay', key: `${relay.errorCode}/${relay.recoveryCount ?? ''}`,
      text: relay.enabled ? '[无奈]转播画面暂时中断。[平静]正在自动恢复。' : '[无奈]转播画面已停止。[平静]请查看控制台提示。' });
    else this.#reset('relay');
    if (storageError) this.#record({ source: 'storage', key: storageError,
      text: '[无奈]直播记录发生异常。[平静]已暂停，请检查控制台。' });
    else this.#reset('storage');

    const cards: SpeechContent[] = [];
    for (const [source, incident] of this.#pending) {
      if (now - (this.#lastSpokenAt.get(source) ?? -Infinity) < cooldownMs) continue;
      this.#pending.delete(source);
      this.#lastSpokenAt.set(source, now);
      cards.push({ contentId: `health-${source}-${now}`, handId: null, text: incident.text, priority: 'system',
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + cooldownMs).toISOString() });
    }
    return cards;
  }

  #record(incident: Incident) {
    if (this.#seen.get(incident.source) === incident.key) {
      if (this.#pending.has(incident.source)) this.#pending.set(incident.source, incident);
      return;
    }
    this.#seen.set(incident.source, incident.key);
    this.#pending.set(incident.source, incident);
  }
  #reset(source: string) { this.#seen.delete(source); this.#pending.delete(source); }
}
