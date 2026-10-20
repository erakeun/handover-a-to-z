// These are editable title suggestions, not semantic classification. Never
// remove or rewrite the source block when ignoring a footer in a title.
const MAX_TITLE = 80;
const PAGE_NUMBER = /^(?:(?:[-–—]\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?(?:\s*[-–—])?|제?\s*\d{1,4}\s*(?:쪽|페이지)|(?:page|p\.)\s*\d{1,4}(?:\s*(?:\/|of)\s*\d{1,4})?)$/iu;
const DATE = '(?:\\d{4}\\s*[./-]\\s*\\d{1,2}(?:\\s*[./-]\\s*\\d{1,2})?\\s*\\.?|\\d{4}\\s*년\\s*\\d{1,2}\\s*월(?:\\s*\\d{1,2}\\s*일)?)';
const REFERENCE_DATE = new RegExp(`^(?:${DATE}\\s*기준|(?:작성\\s*)?기준일?\\s*[:：]\\s*${DATE})$`, 'u');

function clip(text, maximum = MAX_TITLE) {
  if (text.length <= maximum) return text;
  let head = text.slice(0, maximum - 1);
  // Do not manufacture an invalid Unicode string while shortening a title.
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

function candidateLines(text) {
  const lines = text.split(/\r\n|\r|\n/u).map(line => line.trim().replace(/[ \t]+/gu, ' ')).filter(Boolean);
  let start = 0;
  while (start < lines.length && (PAGE_NUMBER.test(lines[start]) || REFERENCE_DATE.test(lines[start]))) start++;
  return lines.slice(start);
}

function contextualTitle(header, next) {
  const joined = `${header} — ${next}`;
  if (joined.length <= MAX_TITLE) return joined;
  // Keep both the context and the distinguishing subtitle when space is tight.
  const headerBudget = Math.min(header.length, Math.max(24, MAX_TITLE - 3 - next.length));
  return `${clip(header, headerBudget)} — ${clip(next, MAX_TITLE - 3 - headerBudget)}`;
}

/**
 * Return one title per input block. Page/slide headers repeated across two or
 * more blocks may gain the next short line as context. Paragraph imports and
 * pasted notes retain their first meaningful line rather than gaining a guessed
 * hierarchy. All proposals remain editable in the import review.
 */
export function proposeDraftTitles(blocks) {
  if (!Array.isArray(blocks)) throw new TypeError('초안 블록 배열이 필요합니다.');
  const candidates = blocks.map(block => {
    if (!block || typeof block.text !== 'string') throw new TypeError('초안 본문은 문자열이어야 합니다.');
    return { lines: candidateLines(block.text), paged: block.kind === 'page' || block.kind === 'slide' };
  });
  const repeated = new Map();
  for (const { lines, paged } of candidates) {
    if (paged && lines[0]) repeated.set(lines[0], (repeated.get(lines[0]) || 0) + 1);
  }
  return candidates.map(({ lines, paged }) => {
    const header = lines[0];
    if (!header) return '내용 확인 필요';
    const next = lines.slice(1).find(line => line !== header && !PAGE_NUMBER.test(line) && !REFERENCE_DATE.test(line));
    if (paged && repeated.get(header) >= 2 && header.length <= MAX_TITLE
        && next && next.length <= MAX_TITLE) return contextualTitle(header, next);
    return clip(header);
  });
}
