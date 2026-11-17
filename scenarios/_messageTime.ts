/** Wyłącznie prefiks emitowany przez messageTime; usuwamy najwyżej jedną linię. */
export const messageTimePrefix = /^\[(?:czas wiadomości: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, (?:poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela)|message time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}, (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)), UTC[+-]\d{2}:\d{2}\]\n/;

export function withoutMessageTime(content: string): string {
  return content.replace(messageTimePrefix, '');
}
