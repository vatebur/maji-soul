import { normalizeText } from './config.ts';

export const SPOKEN_SENTENCE_MAX_CHARS = 19;
export const SPOKEN_MOODS = ['犹豫', '纠结', '开心', '难受', '紧张', '放松', '无奈', '好奇', '期待', '得意', '惊讶', '平静'] as const;
const moodPrefix = new RegExp(`^\\[(${SPOKEN_MOODS.join('|')})\\]`);

export function spokenSentences(text: string): string[] {
  return text.match(/[^。！？!?\r\n]+[。！？!?]*|[。！？!?]+/gu)?.map(part => part.trim()).filter(Boolean) ?? [];
}

/** Count the mood cue and punctuation too, so each complete sentence fits a danmaku. */
export function validSpokenText(text: string, maxSentences: number): boolean {
  const sentences = spokenSentences(text);
  return sentences.length > 0 && sentences.length <= maxSentences && sentences.every(sentence => {
    const cue = moodPrefix.exec(sentence)?.[0];
    return cue !== undefined && [...sentence].length <= SPOKEN_SENTENCE_MAX_CHARS &&
      /^[^\[\]。！？!?\r\n]+[。！？!?]$/u.test(sentence.slice(cue.length));
  });
}

/** Legacy factual answers and fixed invitations also need short, expressive delivery. */
export function formatSpokenText(input: string): string {
  const result: string[] = [];
  for (const sentence of spokenSentences(normalizeText(input))) {
    const cue = moodPrefix.exec(sentence)?.[0] ?? '[平静]';
    let body = sentence.replace(moodPrefix, '').replace(/\[[^\]]*\]/g, '').trim();
    const ending = /[。！？!?]$/.exec(body)?.[0] ?? '。';
    body = body.replace(/[。！？!?]+$/, '').trim();
    const capacity = SPOKEN_SENTENCE_MAX_CHARS - [...cue].length - 1;
    while (body) {
      const chars = [...body];
      let count = Math.min(capacity, chars.length);
      if (chars.length > capacity) {
        const pause = chars.slice(0, capacity).join('').search(/[,，、;；:：][^,，、;；:：]*$/u);
        if (pause > 0) count = pause + 1;
      }
      const fragment = chars.slice(0, count).join('').replace(/[,，、;；:：]+$/, '').trim();
      body = chars.slice(count).join('').trim();
      if (fragment) result.push(`${cue}${fragment}${body ? '。' : ending}`);
    }
  }
  return result.join('');
}
