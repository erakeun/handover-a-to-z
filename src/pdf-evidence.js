import { CURRENT_SCHEMA_VERSION, PDF_LIMITS, inspectPdfEvidence, makeId, validateDocument } from './model.js';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const abort = () => Object.assign(new Error('PDF 확인을 취소했습니다.'), { name: 'AbortError' });
const current = (isCurrent) => { if (!isCurrent()) throw abort(); };
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_CANVAS_SIDE = 8_192;

function readableError(error) {
  if (error?.name === 'AbortError' || error?.name === 'RenderingCancelledException') return abort();
  if (error?.code === 'PDF_RESOURCE_UNSUPPORTED') return error;
  if (error?.name === 'PasswordException') return new Error('암호 또는 권한으로 보호된 PDF는 지원하지 않습니다. 기관에서 허용한 암호 없는 검토용 PDF를 사용해 주세요.');
  if (error?.name === 'InvalidPDFException' || error?.name === 'FormatError') return new Error('손상되었거나 읽을 수 없는 PDF입니다. 원본에서 검토용 PDF를 다시 저장해 주세요.');
  return new Error(`PDF를 읽을 수 없습니다. ${error?.message || '파일을 확인해 주세요.'}`);
}

function pdfBytes(pdf) {
  const { bytes: expected } = inspectPdfEvidence(pdf);
  let binary;
  try { binary = atob(pdf.data); } catch { throw new Error('PDF base64 데이터를 읽을 수 없습니다.'); }
  check(binary.length === expected, 'PDF 데이터 길이가 일치하지 않습니다.');
  return Uint8Array.from(binary, (letter) => letter.charCodeAt(0));
}

function encodePdf(bytes) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= PDF_LIMITS.bytes, 'PDF 한 파일은 10 MiB 이하여야 합니다.');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function loadBytes(bytes, isCurrent = () => true) {
  current(isCurrent);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  current(isCurrent);
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
  }
  // PDF.js can swallow a rejected resource request and return an empty page.
  // Track actual requests independently of its promises, then reject the whole
  // document at every acceptance/render boundary instead of claiming success.
  const unavailableResources = new Set();
  const requireResources = () => {
    if (!unavailableResources.size) return;
    const names = [...unavailableResources].map(kind => ({
      cMapUrl: '글자 매핑 자료(CMap)', standardFontDataUrl: '글꼴 자료', wasmUrl: '그림 해석 자료',
    })[kind] || '추가 표시 자료');
    throw Object.assign(new Error(`이 PDF에 필요한 ${names.join('·')}가 이 검토본에 없어 표시를 중단했습니다. 원본 프로그램에서 글꼴을 포함한 일반 PDF로 다시 저장하고 확인해 주세요.`), { code: 'PDF_RESOURCE_UNSUPPORTED' });
  };
  // PDF.js 6 funnels optional CMap/font/WASM requests through this factory.
  // Only the app's bundled worker is loaded. PDF data never supplies a URL.
  class NoNetworkBinaryData {
    async fetch({ kind } = {}) {
      unavailableResources.add(kind);
      requireResources();
    }
  }
  const loading = pdfjs.getDocument({
    data: bytes,
    BinaryDataFactory: NoNetworkBinaryData,
    useWorkerFetch: false,
    useWasm: false,
    useSystemFonts: true,
    disableFontFace: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
    stopAtErrors: true,
    verbosity: 0,
  });
  let proxy;
  let destroyed = false;
  let destruction;
  let rendering;
  let verification;
  let serial = 0;
  const destroy = () => {
    if (destruction) return destruction;
    destroyed = true; serial++;
    rendering?.cancel();
    destruction = loading.destroy().catch(() => {});
    return destruction;
  };
  const active = () => { current(isCurrent); if (destroyed) throw abort(); };
  try {
    proxy = await loading.promise;
    active();
    check(Number.isInteger(proxy.numPages) && proxy.numPages >= 1 && proxy.numPages <= PDF_LIMITS.pages, 'PDF는 1~200쪽까지 지원합니다.');
    const permissions = await proxy.getPermissions();
    active();
    check(permissions === null, '암호 또는 권한으로 보호된 PDF는 지원하지 않습니다. 기관에서 허용한 암호 없는 검토용 PDF를 사용해 주세요.');
    const metadata = await proxy.getMetadata();
    active();
    check(!metadata.info?.IsXFAPresent, 'XFA 방식의 PDF 양식은 이 보기에서 정확히 표시할 수 없습니다. 원본 프로그램에서 일반 PDF로 인쇄해 검토한 뒤 사용해 주세요.');
  } catch (error) {
    await destroy();
    throw readableError(error);
  }
  const checkPage = (pageNumber) => {
    check(Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= proxy.numPages, `PDF 쪽은 1~${proxy.numPages} 사이로 선택해 주세요.`);
  };
  return {
    pageCount: proxy.numPages,
    async verifyPages() {
      active(); requireResources();
      if (verification) return verification;
      verification = (async () => {
        for (let number = 1; number <= proxy.numPages; number++) {
          active();
          let page;
          let reader;
          try {
            page = await proxy.getPage(number);
            active();
            // Parse visual and textual content before accepting an attachment.
            // Neither path executes links, actions, forms, or JavaScript.
            await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
            active(); requireResources();
            reader = page.streamTextContent().getReader();
            for (;;) {
              const { done } = await reader.read();
              active(); requireResources();
              if (done) break;
            }
          } catch (error) { requireResources(); throw readableError(error); }
          finally {
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            page?.cleanup();
          }
        }
        requireResources();
        return { pageCount: proxy.numPages };
      })();
      return verification;
    },
    async renderPage(canvas, pageNumber, { width = 760, pixelRatio = 1 } = {}) {
      active(); requireResources(); checkPage(pageNumber);
      check(canvas && typeof canvas.getContext === 'function', 'PDF를 표시할 canvas가 필요합니다.');
      check(Number.isFinite(width) && width > 0 && width <= MAX_CANVAS_SIDE, 'PDF 표시 너비가 지원 범위를 벗어났습니다.');
      check(Number.isFinite(pixelRatio) && pixelRatio >= 1 && pixelRatio <= 2, 'PDF 표시 배율이 지원 범위를 벗어났습니다.');
      const request = ++serial;
      if (rendering) {
        rendering.cancel();
        await rendering.promise.catch(() => {});
      }
      active();
      let page;
      let ownRender;
      try {
        page = await proxy.getPage(pageNumber);
        active(); if (request !== serial) throw abort();
        const original = page.getViewport({ scale: 1 });
        check(Number.isFinite(original.width) && Number.isFinite(original.height) && original.width > 0 && original.height > 0, 'PDF 페이지 크기를 읽을 수 없습니다.');
        const desired = width / original.width * pixelRatio;
        const scale = Math.min(desired, MAX_CANVAS_SIDE / original.width, MAX_CANVAS_SIDE / original.height,
          Math.sqrt(MAX_CANVAS_PIXELS / (original.width * original.height)));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        if (canvas.style) { canvas.style.maxWidth = '100%'; canvas.style.height = 'auto'; }
        canvas.setAttribute?.('role', 'img');
        canvas.setAttribute?.('aria-label', `PDF ${pageNumber}쪽. 페이지의 시각적 내용이며 텍스트 검색을 제공하지 않습니다.`);
        const context = canvas.getContext('2d', { alpha: false });
        check(context, '이 브라우저에서 PDF 페이지를 그릴 수 없습니다.');
        // Canvas paints annotation appearances only. No HTML annotation layer,
        // native PDF plug-in, href, iframe, JS sandbox or attachment opener exists.
        ownRender = page.render({ canvasContext: context, canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE, background: '#ffffff' });
        rendering = ownRender;
        await ownRender.promise;
        active(); if (request !== serial) throw abort();
        requireResources();
        return { pageNumber, width: canvas.width, height: canvas.height, reduced: scale < desired };
      } catch (error) {
        // Do not leave a partial/blank render that could be mistaken for a
        // successfully read page after PDF.js swallowed a resource failure.
        if (unavailableResources.size) { canvas.width = 0; canvas.height = 0; requireResources(); }
        throw readableError(error);
      }
      finally { if (rendering === ownRender) rendering = null; page?.cleanup(); }
    },
    destroy,
  };
}

/** Open validated stored bytes; callers must destroy the handle on close. */
export async function openPdfEvidence(pdf, { isCurrent = () => true } = {}) {
  const handle = await loadBytes(pdfBytes(pdf), isCurrent);
  try {
    check(handle.pageCount === pdf.pageCount, 'PDF의 실제 쪽수와 저장된 쪽수가 다릅니다. 원본 PDF를 다시 확인해 주세요.');
    await handle.verifyPages();
    return handle;
  } catch (error) {
    await handle.destroy();
    throw error;
  }
}

/** Verify every stored PDF before accepting an imported portable document. */
export async function verifyDocumentPdfs(doc, { isCurrent = () => true } = {}) {
  const validation = validateDocument(doc);
  check(validation.ok, `PDF가 포함된 문서를 확인할 수 없습니다. ${validation.errors.join(' ')}`);
  let count = 0;
  for (const source of doc.sourceFiles) {
    if (!source.pdf) continue;
    current(isCurrent);
    const handle = await openPdfEvidence(source.pdf, { isCurrent });
    try { await handle.verifyPages(); count++; }
    finally { await handle.destroy(); }
  }
  current(isCurrent);
  return { count };
}

/**
 * Only commit after file parsing and full document size validation succeed.
 * isCurrent prevents attaching to a deleted task or a closed/switched editor.
 */
export async function attachPdfEvidence(doc, task, file, { isCurrent = () => true } = {}) {
  check(Array.isArray(doc?.tasks) && doc.tasks.includes(task), 'PDF를 연결할 업무를 찾을 수 없습니다.');
  check(file && typeof file.name === 'string' && /\.pdf$/iu.test(file.name), '검토한 PDF 파일을 선택해 주세요.');
  check(Number.isInteger(file.size) && file.size > 0 && file.size <= PDF_LIMITS.bytes, 'PDF 한 파일은 10 MiB 이하여야 합니다.');
  current(isCurrent);
  const bytes = new Uint8Array(await file.arrayBuffer());
  current(isCurrent);
  check(bytes.byteLength > 0 && bytes.byteLength <= PDF_LIMITS.bytes && bytes.byteLength === file.size, '실제 PDF 파일 크기가 다르거나 10 MiB 제한을 넘었습니다.');
  const data = encodePdf(bytes);
  // Envelope validation checks the header before invoking PDF.js.
  inspectPdfEvidence({ data, pageCount: 1 });
  const handle = await loadBytes(bytes, isCurrent);
  let pageCount;
  try { await handle.verifyPages(); pageCount = handle.pageCount; }
  finally { await handle.destroy(); }
  current(isCurrent);
  check(doc.tasks.includes(task), '확인하는 동안 업무가 바뀌어 PDF를 연결하지 않았습니다.');
  const source = {
    id: makeId(), name: file.name, format: 'pdf', importedAt: new Date().toISOString(),
    excerpt: '', warnings: ['검토용 PDF의 정적 페이지 보기입니다. 링크·첨부 열기·양식 입력·스크립트는 실행하지 않습니다. 내용의 현행성은 별도 확인이 필요합니다.'],
    pdf: { data, pageCount },
  };
  const candidate = structuredClone(doc);
  candidate.schemaVersion = CURRENT_SCHEMA_VERSION;
  candidate.sourceFiles.push(source);
  candidate.tasks.find((item) => item.id === task.id).sourceRefs.push(source.id);
  candidate.updatedAt = source.importedAt;
  const validation = validateDocument(candidate);
  check(validation.ok, `PDF를 저장할 수 없습니다. ${validation.errors.join(' ')}`);
  current(isCurrent);
  doc.sourceFiles.push(source);
  task.sourceRefs.push(source.id);
  doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  doc.updatedAt = candidate.updatedAt;
  return source;
}

/** Small canvas-only viewer. Returns { destroy, showPage, pageCount }. */
export async function createPdfEvidenceViewer(pdf, container, { initialPage = 1, isCurrent = () => true } = {}) {
  check(container?.ownerDocument && typeof container.append === 'function', 'PDF를 표시할 영역이 필요합니다.');
  const dom = container.ownerDocument;
  const wrapper = dom.createElement('section'); wrapper.className = 'pdf-evidence-viewer';
  const toolbar = dom.createElement('div'); toolbar.className = 'actions pdf-evidence-toolbar';
  const makeButton = (label) => { const button = dom.createElement('button'); button.type = 'button'; button.textContent = label; button.className = 'quiet'; return button; };
  const previous = makeButton('이전 쪽'), next = makeButton('다음 쪽');
  const pageLabel = dom.createElement('label'); pageLabel.textContent = '쪽 ';
  const pageInput = dom.createElement('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.step = '1'; pageInput.value = String(initialPage); pageInput.setAttribute('aria-label', 'PDF 쪽 번호');
  const pageTotal = dom.createElement('span'); pageLabel.append(pageInput, pageTotal);
  const go = makeButton('이 쪽 보기');
  const zoomLabel = dom.createElement('label'); zoomLabel.textContent = '확대 ';
  const zoom = dom.createElement('select'); zoom.setAttribute('aria-label', 'PDF 확대');
  for (const [value, label] of [['1', '기본'], ['1.5', '150%'], ['2', '200%']]) { const option = dom.createElement('option'); option.value = value; option.textContent = label; zoom.append(option); }
  zoomLabel.append(zoom);
  const note = dom.createElement('p'); note.className = 'helper'; note.textContent = 'PDF의 정적 페이지를 봅니다. 링크·첨부·양식·스크립트는 실행하지 않습니다. 본문·표·사진이 원본과 같은지 확인해 주세요.';
  const status = dom.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'PDF를 확인하고 있습니다…';
  const scroll = dom.createElement('div'); scroll.className = 'pdf-evidence-page'; scroll.style.overflow = 'auto';
  const canvas = dom.createElement('canvas'); canvas.textContent = 'PDF 페이지를 볼 수 없는 경우 원본의 읽을 수 있는 내용을 확인해 주세요.'; scroll.append(canvas);
  toolbar.append(previous, pageLabel, go, next, zoomLabel); wrapper.append(toolbar, note, status, scroll); container.append(wrapper);
  let disposed = false, handle, pageNumber = initialPage, request = 0;
  const active = () => !disposed && isCurrent();
  const controls = (busy) => { previous.disabled = busy || pageNumber <= 1; next.disabled = busy || pageNumber >= (handle?.pageCount || 1); go.disabled = busy; zoom.disabled = busy; pageInput.disabled = busy; };
  controls(true);
  const destroy = async () => { if (disposed) return; disposed = true; request++; wrapper.remove(); await handle?.destroy(); };
  const showPage = async (value) => {
    if (!active() || !handle) return;
    const ownRequest = ++request;
    const selected = Number(value);
    if (!Number.isInteger(selected) || selected < 1 || selected > handle.pageCount) {
      status.textContent = `1~${handle.pageCount}쪽 사이로 입력해 주세요.`; return;
    }
    controls(true); status.textContent = `${selected}쪽을 읽고 있습니다…`;
    try {
      const baseWidth = Math.max(320, Math.min(1200, container.clientWidth || 760));
      const result = await handle.renderPage(canvas, selected, { width: baseWidth * Number(zoom.value), pixelRatio: 1 });
      if (!active() || ownRequest !== request) return;
      pageNumber = selected; pageInput.value = String(selected);
      // Zoom is scrollable rather than shrinking the enlarged canvas to fit.
      canvas.style.maxWidth = zoom.value === '1' ? '100%' : 'none';
      status.textContent = `${pageNumber} / ${handle.pageCount}쪽${result.reduced ? ' · 큰 페이지는 화면 한도에 맞춰 표시했습니다.' : ''}`;
    } catch (error) {
      if (active() && ownRequest === request && error.name !== 'AbortError') {
        canvas.width = 0; canvas.height = 0;
        status.textContent = error.message;
      }
    } finally { if (active() && ownRequest === request) controls(false); }
  };
  previous.addEventListener('click', () => { void showPage(pageNumber - 1); });
  next.addEventListener('click', () => { void showPage(pageNumber + 1); });
  go.addEventListener('click', () => { void showPage(pageInput.value); });
  pageInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void showPage(pageInput.value); } });
  zoom.addEventListener('change', () => { void showPage(pageNumber); });
  try {
    handle = await openPdfEvidence(pdf, { isCurrent: active });
    if (!active()) { await handle.destroy(); throw abort(); }
    pageInput.max = String(handle.pageCount); pageTotal.textContent = ` / ${handle.pageCount}`;
    await showPage(initialPage);
    return { destroy, showPage, pageCount: handle.pageCount };
  } catch (error) {
    if (active()) { status.textContent = error.message; controls(true); }
    await handle?.destroy();
    throw error;
  }
}
