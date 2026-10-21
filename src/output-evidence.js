import { openPdfEvidence } from './pdf-evidence.js';
import { decodeBase64, inspectImageBytes } from './image-data.js';

// Output-only limits. Rendered images never enter the saved document; this
// module reads confirmed page relations without changing the original data.
export const OUTPUT_EVIDENCE_LIMITS = Object.freeze({ pages: 20, pageBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
const check = (value, message) => { if (!value) throw new Error(message); };
const current = isCurrent => {
  if (!isCurrent()) throw Object.assign(new Error('근거 쪽 준비를 취소했습니다.'), { name: 'AbortError' });
};

function selectedItems(doc, selection) {
  check(doc && Array.isArray(doc.tasks) && Array.isArray(doc.cases) && Array.isArray(doc.sourceFiles), '출력할 문서가 올바르지 않습니다.');
  check(selection && typeof selection === 'object' && !Array.isArray(selection), '출력할 업무 선택을 확인해 주세요.');
  const selected = (items, ids) => {
    if (ids === undefined) return items;
    check(Array.isArray(ids) && ids.every(id => typeof id === 'string' && items.some(item => item.id === id)), '출력할 업무 또는 진행 건을 찾을 수 없습니다.');
    const wanted = new Set(ids);
    return items.filter(item => wanted.has(item.id));
  };
  return [...selected(doc.tasks, selection.taskIds), ...selected(doc.cases, selection.caseIds)];
}

export function linkedPdfSources(doc, selection = {}) {
  const refs = new Set(selectedItems(doc, selection).flatMap(item => item.sourceRefs || []));
  check([...refs].every(id => doc.sourceFiles.some(source => source.id === id)), '연결된 근거 파일을 찾을 수 없어 출력을 중단했습니다.');
  return doc.sourceFiles.filter(source => refs.has(source.id) && source.pdf);
}

/** Reuse confirmed item-to-page relations; a different item's choice is not a substitute. */
export function storedOutputPages(doc, selection = {}) {
  const items = selectedItems(doc, selection);
  const choices = [];
  for (const source of linkedPdfSources(doc, selection)) {
    const pages = new Set();
    let complete = true;
    for (const item of items.filter(item => item.sourceRefs?.includes(source.id))) {
      const entry = item.sourcePages?.find(link => link.sourceId === source.id);
      const chosen = entry?.pages?.length ? entry.pages : source.pdf.pageCount === 1 ? [1] : null;
      if (!chosen) { complete = false; break; }
      check(Array.isArray(chosen) && chosen.every(page => Number.isInteger(page)), '저장된 근거 쪽을 확인해 주세요.');
      for (const page of parseEvidencePages(chosen.join(','), source.pdf.pageCount)) pages.add(page);
    }
    if (complete) choices.push([source.id, [...pages].sort((a, b) => a - b).join(', ')]);
  }
  return Object.fromEntries(choices);
}

export function parseEvidencePages(text, pageCount) {
  check(Number.isInteger(pageCount) && pageCount >= 1 && pageCount <= 200, 'PDF의 쪽수를 확인할 수 없습니다.');
  check(typeof text === 'string' && text.trim() && text.length <= 2000, '함께 넣을 근거 쪽을 선택해 주세요. 예: 1, 3-4');
  const pages = new Set();
  for (const part of text.split(',')) {
    const match = /^\s*([1-9]\d*)(?:\s*-\s*([1-9]\d*))?\s*$/u.exec(part);
    check(match, '쪽 번호는 1, 3-4처럼 쉼표와 범위로 적어 주세요.');
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    check(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && end <= pageCount, `근거 쪽은 1~${pageCount}쪽 사이로 선택해 주세요.`);
    check(end - start + 1 <= OUTPUT_EVIDENCE_LIMITS.pages, '근거 쪽은 한 번에 총 20쪽까지 넣을 수 있습니다.');
    for (let page = start; page <= end; page++) pages.add(page);
    check(pages.size <= OUTPUT_EVIDENCE_LIMITS.pages, '근거 쪽은 한 번에 총 20쪽까지 넣을 수 있습니다.');
  }
  return [...pages].sort((a, b) => a - b);
}

function readCanvas(canvas) {
  check(Number.isInteger(canvas.width) && Number.isInteger(canvas.height) && canvas.width > 0 && canvas.height > 0, '근거 쪽이 비어 있어 출력을 중단했습니다.');
  const context = canvas.getContext('2d');
  check(context && typeof context.getImageData === 'function', '근거 쪽의 표시 결과를 확인할 수 없습니다.');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let visible = false;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] !== 0 && (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255)) { visible = true; break; }
  }
  check(visible, '선택한 근거 쪽에 표시된 내용이 없습니다. 원문 쪽을 확인해 주세요.');
  const url = canvas.toDataURL('image/png');
  check(typeof url === 'string' && url.startsWith('data:image/png;base64,'), '근거 쪽을 PNG로 만들지 못했습니다.');
  const data = url.slice('data:image/png;base64,'.length);
  const bytes = decodeBase64(data);
  check(bytes.length <= OUTPUT_EVIDENCE_LIMITS.pageBytes, '근거 한 쪽의 이미지가 8 MiB를 넘습니다. 원문 쪽을 확인해 주세요.');
  const image = inspectImageBytes(bytes);
  check(image.mime === 'image/png' && image.width === canvas.width && image.height === canvas.height, '근거 쪽의 실제 이미지와 표시 크기가 일치하지 않습니다.');
  return { data, width: image.width, height: image.height, bytes: bytes.length };
}

/** Render only explicitly chosen pages. Reject instead of returning partial evidence. */
export async function prepareOutputEvidence(doc, selection = {}, pageChoices = {}, {
  dom = globalThis.document, isCurrent = () => true, openEvidence = openPdfEvidence,
} = {}) {
  current(isCurrent);
  const sources = linkedPdfSources(doc, selection);
  check(pageChoices && typeof pageChoices === 'object' && !Array.isArray(pageChoices), '함께 넣을 근거 쪽을 확인해 주세요.');
  const allowed = new Set(sources.map(source => source.id));
  check(Object.keys(pageChoices).every(id => allowed.has(id)), '선택한 업무에 연결되지 않은 근거 쪽이 있습니다.');
  const plan = sources.map(source => ({ source, pages: parseEvidencePages(Object.hasOwn(pageChoices, source.id) ? pageChoices[source.id] : '', source.pdf.pageCount) }));
  check(plan.reduce((total, item) => total + item.pages.length, 0) <= OUTPUT_EVIDENCE_LIMITS.pages, '근거 쪽은 한 번에 총 20쪽까지 넣을 수 있습니다.');
  if (!plan.length) return [];
  check(dom && typeof dom.createElement === 'function', '이 환경에서는 근거 쪽 이미지를 만들 수 없습니다.');
  const result = [];
  let totalBytes = 0;
  for (const { source, pages } of plan) {
    current(isCurrent);
    const handle = await openEvidence(source.pdf, { isCurrent });
    try {
      current(isCurrent);
      for (const pageNumber of pages) {
        current(isCurrent);
        const canvas = dom.createElement('canvas');
        try {
          await handle.renderPage(canvas, pageNumber, { width: 1400, pixelRatio: 1 });
          current(isCurrent);
          const image = readCanvas(canvas);
          totalBytes += image.bytes;
          check(totalBytes <= OUTPUT_EVIDENCE_LIMITS.totalBytes, '선택한 근거 이미지가 총 32 MiB를 넘습니다. 필요한 쪽을 나누어 출력해 주세요.');
          result.push({ sourceId: source.id, pageNumber, data: image.data, width: image.width, height: image.height });
        } finally {
          // Release the decoded pixel buffer; only the validated PNG remains.
          canvas.width = 0; canvas.height = 0;
        }
      }
    } finally { await handle.destroy(); }
  }
  current(isCurrent);
  return result;
}
