import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import {
  PDF_LIMITS, createDocument, createTask, createCase, inspectPdfEvidence,
  validateDocument, stringifyDocument, parseImport, importAsCopy,
} from '../src/model.js';
import { attachPdfEvidence, openPdfEvidence, verifyDocumentPdfs } from '../src/pdf-evidence.js';

// All content below is generated for tests. No real institution's PDF is read.
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
const padded = (value) => Buffer.concat([Buffer.from(value, 'ascii'), padding]).subarray(0, 32);
function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0; j = 0;
  return Buffer.from(input.map(byte => { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; return byte ^ state[(state[i] + state[j]) & 255]; }));
}

function syntheticPdf({ pages = 2, activeContent = false, encrypted = false, emptyPassword = false, xfa = false, extraBytes = 0 } = {}) {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageIds = [];
  let encryption;
  if (encrypted) {
    const identifier = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const user = padded(emptyPassword ? '' : 'synthetic-only');
    const owner = rc4(md5(padded('synthetic-owner')).subarray(0, 5), user);
    const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
    const key = md5(user, owner, permissions, identifier).subarray(0, 5);
    encryption = { key, identifier, owner, user: rc4(key, padding) };
  }
  for (let index = 0; index < pages; index++) {
    const pageId = objects.length + 1, contentId = pageId + 1;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R${activeContent && index === 0 ? ' /Annots [<< /Type /Annot /Subtype /Link /Rect [20 20 180 60] /A << /S /URI /URI (https://no-network.invalid/pdf-evidence) >> >>]' : ''} >>`);
    let contents = Buffer.from(`0.1 0.5 0.7 rg 30 100 200 250 re f\nBT /F1 18 Tf 30 450 Td (SYNTHETIC PAGE ${index + 1}) Tj ET`, 'ascii');
    if (encryption) {
      const suffix = Buffer.from([contentId & 255, (contentId >> 8) & 255, (contentId >> 16) & 255, 0, 0]);
      contents = rc4(md5(encryption.key, suffix).subarray(0, 10), contents);
    }
    objects.push(`<< /Length ${contents.length} >>\nstream\n${contents.toString('latin1')}\nendstream`);
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${activeContent ? ' /OpenAction << /S /JavaScript /JS (globalThis.__pdfEvidenceScriptExecuted = true;) >>' : ''}${xfa ? ' /AcroForm << /XFA [(xdp) (synthetic xfa)] /Fields [] >>' : ''} >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  if (extraBytes) objects.push(`<< /Length ${extraBytes} >>\nstream\n${' '.repeat(extraBytes)}\nendstream`);
  let encryptionTrailer = '';
  if (encryption) {
    const id = objects.length + 1;
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${encryption.owner.toString('hex')}> /U <${encryption.user.toString('hex')}> /P -4 >>`);
    encryptionTrailer = ` /Encrypt ${id} 0 R /ID [<${encryption.identifier.toString('hex')}> <${encryption.identifier.toString('hex')}>]`;
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionTrailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
const asFile = (bytes, overrides = {}) => ({ name: 'synthetic-evidence.pdf', size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), ...overrides });
const envelope = (bytes = syntheticPdf(), pageCount = 2) => ({ data: bytes.toString('base64'), pageCount });
const empty = () => createDocument({ title: '합성 PDF 검토', tasks: [createTask({ title: '가상 업무' })] });
const withPdf = (pdf = envelope()) => {
  const doc = empty(); doc.schemaVersion = 3;
  doc.sourceFiles = [{ id: 'synthetic-source', name: 'synthetic.pdf', format: 'pdf', importedAt: doc.createdAt, excerpt: '', warnings: [], pdf }];
  doc.tasks[0].sourceRefs = [doc.sourceFiles[0].id];
  return doc;
};

function syntheticCMapPdf(pages = 1) {
  // The last page contains only the synthetic word '안녕'. Its predefined
  // Korean CMap is not embedded, reproducing PDF.js's swallowed-font failure.
  const objects = ['', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /DW 1000 >>',
  ];
  const pageIds = [];
  for (let index = 0; index < pages; index++) {
    const pageId = objects.length + 1, contentId = pageId + 1;
    pageIds.push(pageId);
    const text = index === pages - 1 ? 'BT /F2 20 Tf 20 200 Td <C548B155> Tj ET' : 'BT /F1 20 Tf 20 200 Td (SYNTHETIC SAFE PAGE) Tj ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF bytes and page count are bounded, strict base64, and must have a real header', () => {
  assert.deepEqual(PDF_LIMITS, { bytes: 10 * 1024 * 1024, pages: 200 });
  assert.equal(Object.isFrozen(PDF_LIMITS), true);
  const pdf = envelope();
  assert.deepEqual(inspectPdfEvidence(pdf), { bytes: syntheticPdf().length, pageCount: 2 });
  for (const data of ['', pdf.data + '\n', 'data:application/pdf;base64,' + pdf.data, pdf.data.slice(0, -1) + '-', Buffer.from('not a pdf').toString('base64')]) {
    assert.throws(() => inspectPdfEvidence({ data, pageCount: 2 }), /PDF|base64/);
  }
  for (const pageCount of [0, -1, 201, 1.5, '2', null]) assert.throws(() => inspectPdfEvidence({ ...pdf, pageCount }), /1~200/);
  const short = Buffer.from('%PDF-1.4\n').toString('base64');
  assert.throws(() => inspectPdfEvidence({ data: short, pageCount: 1, url: 'https://no-network.invalid' }), /data와 pageCount/);
  const withGetter = { pageCount: 1, get data() { throw new Error('should not invoke'); } };
  assert.throws(() => inspectPdfEvidence(withGetter), /data와 pageCount/);
  const canonical = Buffer.from('%PDF-1.4\na').toString('base64');
  assert.ok(canonical.endsWith('=='));
  assert.throws(() => inspectPdfEvidence({ data: canonical.slice(0, -3) + 'R==', pageCount: 1 }), /정규 base64/);
});

test('PDF attachments require v3, survive byte-exact JSON, and retain remapped references', () => {
  const doc = withPdf();
  doc.cases.push(createCase({ taskId: doc.tasks[0].id, sourceRefs: [doc.sourceFiles[0].id] }));
  const json = stringifyDocument(doc);
  assert.deepEqual(parseImport(json).document, doc);
  const copy = importAsCopy(doc);
  assert.equal(copy.sourceFiles[0].pdf.data, doc.sourceFiles[0].pdf.data);
  assert.deepEqual(copy.sourceFiles[0].pdf, doc.sourceFiles[0].pdf);
  assert.equal(copy.tasks[0].sourceRefs[0], copy.sourceFiles[0].id);
  assert.equal(copy.cases[0].sourceRefs[0], copy.sourceFiles[0].id);
  assert.equal(copy.cases[0].taskId, copy.tasks[0].id);
  assert.notEqual(copy.sourceFiles[0].id, doc.sourceFiles[0].id);
  copy.sourceFiles[0].pdf.pageCount = 1;
  assert.equal(doc.sourceFiles[0].pdf.pageCount, 2);
  for (const version of [1, 2]) {
    doc.schemaVersion = version;
    assert.match(validateDocument(doc).errors.join(' '), /pdf.*알 수 없는/);
  }
});

test('PDF 10 MiB envelope allowance cannot enlarge unrelated strings or the 24 MiB file budget', () => {
  const bytes = Buffer.alloc(PDF_LIMITS.bytes, 32); bytes.write('%PDF-1.4\n');
  const pdf = envelope(bytes, 1), doc = withPdf(pdf);
  assert.equal(inspectPdfEvidence(pdf).bytes, PDF_LIMITS.bytes);
  assert.equal(validateDocument(doc).ok, true);
  const unrelated = withPdf(); unrelated.provenance = { unbounded: pdf.data };
  assert.match(validateDocument(unrelated).errors.join(' '), /문자열 길이/);
  doc.sourceFiles.push({ ...doc.sourceFiles[0], id: 'second-pdf' });
  assert.match(validateDocument(doc).errors.join(' '), /24 MiB/);
  const tooLarge = Buffer.alloc(PDF_LIMITS.bytes + 1, 32); tooLarge.write('%PDF-1.4\n');
  assert.throws(() => inspectPdfEvidence(envelope(tooLarge, 1)), /10 MiB/);
});

test('a valid synthetic PDF attaches atomically and all stored PDFs can be verified', async () => {
  const doc = empty(), task = doc.tasks[0], bytes = syntheticPdf();
  const source = await attachPdfEvidence(doc, task, asFile(bytes));
  assert.equal(doc.schemaVersion, 3);
  assert.equal(doc.sourceFiles.length, 1);
  assert.deepEqual(task.sourceRefs, [source.id]);
  assert.equal(source.pdf.data, bytes.toString('base64'));
  assert.equal(source.pdf.pageCount, 2);
  assert.deepEqual(await verifyDocumentPdfs(parseImport(stringifyDocument(doc)).document), { count: 1 });
});

test('adding PDF evidence upgrades a valid legacy document to v3 without backfilling or changing its old content', async () => {
  for (const schemaVersion of [1, 2]) {
    const doc = empty(); doc.schemaVersion = schemaVersion;
    delete doc.tasks[0].firstAction;
    const item = createCase({ status: 'done', notes: '가상 기존 기록\r\n그대로' });
    delete item.statusConfirmed; delete item.taskId;
    doc.cases.push(item);
    assert.equal(validateDocument(doc).ok, true);
    const before = structuredClone(doc);
    await attachPdfEvidence(doc, doc.tasks[0], asFile(syntheticPdf()));
    assert.equal(doc.schemaVersion, 3);
    assert.equal(Object.hasOwn(doc.tasks[0], 'firstAction'), false);
    assert.equal(Object.hasOwn(doc.cases[0], 'statusConfirmed'), false);
    assert.equal(Object.hasOwn(doc.cases[0], 'taskId'), false);
    const oldContent = structuredClone(doc);
    oldContent.schemaVersion = before.schemaVersion;
    oldContent.updatedAt = before.updatedAt;
    oldContent.sourceFiles = before.sourceFiles;
    oldContent.tasks[0].sourceRefs = before.tasks[0].sourceRefs;
    assert.deepEqual(oldContent, before);
  }
});

test('bad, oversized, cancelled, or over-page PDF input leaves the original document unchanged', async () => {
  const doc = empty(), task = doc.tasks[0], before = structuredClone(doc);
  let read = false;
  await assert.rejects(attachPdfEvidence(doc, task, asFile(syntheticPdf(), { size: PDF_LIMITS.bytes + 1, arrayBuffer: async () => { read = true; } })), /10 MiB/);
  assert.equal(read, false);
  await assert.rejects(attachPdfEvidence(doc, task, asFile(Buffer.from('not-pdf'))), /헤더/);
  await assert.rejects(attachPdfEvidence(doc, task, asFile(Buffer.from('%PDF-1.4\nbroken'))), /손상|읽을 수 없는/);
  await assert.rejects(attachPdfEvidence(doc, task, asFile(syntheticPdf({ pages: 201 }))), /1~200/);
  await assert.rejects(attachPdfEvidence(doc, task, asFile(syntheticPdf()), { isCurrent: () => false }), { name: 'AbortError' });
  await assert.rejects(attachPdfEvidence(doc, task, asFile(syntheticPdf(), { size: 1 })), /실제 PDF 파일 크기/);
  assert.deepEqual(doc, before);
});

test('password-protected and permission-encrypted PDFs give an explicit refusal', async () => {
  for (const emptyPassword of [false, true]) {
    const doc = empty(), before = structuredClone(doc);
    await assert.rejects(attachPdfEvidence(doc, doc.tasks[0], asFile(syntheticPdf({ encrypted: true, emptyPassword }))), /암호 또는 권한/);
    assert.deepEqual(doc, before);
  }
});

test('unsupported XFA forms and an oversized aggregate fail before any attachment is committed', async () => {
  const doc = empty(), before = structuredClone(doc);
  await assert.rejects(attachPdfEvidence(doc, doc.tasks[0], asFile(syntheticPdf({ xfa: true }))), /XFA/);
  assert.deepEqual(doc, before);
  const large = syntheticPdf({ extraBytes: 9 * 1024 * 1024 });
  const existing = withPdf(envelope(large));
  assert.equal(validateDocument(existing).ok, true);
  const snapshot = stringifyDocument(existing);
  await assert.rejects(attachPdfEvidence(existing, existing.tasks[0], asFile(large)), /24 MiB/);
  assert.equal(stringifyDocument(existing), snapshot);
});

test('switching the document or deleting a task during async reading cannot commit a PDF', async () => {
  const bytes = syntheticPdf();
  const doc = empty(), task = doc.tasks[0];
  let active = true;
  const switchedFile = asFile(bytes, { arrayBuffer: async () => { active = false; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } });
  const before = structuredClone(doc);
  await assert.rejects(attachPdfEvidence(doc, task, switchedFile, { isCurrent: () => active }), { name: 'AbortError' });
  assert.deepEqual(doc, before);
  const deletedFile = asFile(bytes, { arrayBuffer: async () => { doc.tasks = []; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } });
  await assert.rejects(attachPdfEvidence(doc, task, deletedFile), /업무가 바뀌어/);
  assert.equal(doc.sourceFiles.length, 0);
  assert.deepEqual(task.sourceRefs, []);
});

test('actual page count is checked instead of trusting stored metadata', async () => {
  await assert.rejects(openPdfEvidence(envelope(syntheticPdf(), 1)), /실제 쪽수/);
  await assert.rejects(verifyDocumentPdfs(withPdf(envelope(syntheticPdf(), 3))), /실제 쪽수/);
});

test('required Korean CMap failures cannot become successful blank pages on open, attach, or import', async () => {
  const previousFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error('no network permitted'); };
  const missingResource = (error) => error.code === 'PDF_RESOURCE_UNSUPPORTED' && /CMap.*표시를 중단/.test(error.message);
  try {
    for (const pageCount of [1, 2]) {
      const bytes = syntheticCMapPdf(pageCount), pdf = envelope(bytes, pageCount);
      // The stored envelope is structurally valid; only the real PDF parser's
      // resource requests reveal this missing decoding dependency.
      assert.equal(validateDocument(withPdf(pdf)).ok, true);
      await assert.rejects(openPdfEvidence(pdf), missingResource);
      const doc = empty(), before = structuredClone(doc);
      await assert.rejects(attachPdfEvidence(doc, doc.tasks[0], asFile(bytes)), missingResource);
      assert.deepEqual(doc, before);
      const imported = parseImport(stringifyDocument(withPdf(pdf))).document;
      const stored = structuredClone(imported);
      await assert.rejects(verifyDocumentPdfs(imported), missingResource);
      assert.deepEqual(imported, stored);
    }
    assert.equal(networkRequests, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('canvas rendering paints synthetic content without following PDF URLs or executing document JavaScript', async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('network must not run'); };
  globalThis.__pdfEvidenceScriptExecuted = false;
  let handle;
  try {
    handle = await openPdfEvidence(envelope(syntheticPdf({ activeContent: true })));
    await handle.verifyPages();
    const canvas = createCanvas(1, 1);
    const rendered = await handle.renderPage(canvas, 1, { width: 400 });
    assert.equal(rendered.pageNumber, 1);
    assert.equal(canvas.width, 400); assert.equal(canvas.height, 500);
    const pixel = [...canvas.getContext('2d').getImageData(100, 250, 1, 1).data];
    assert.ok(pixel[0] < 100 && pixel[1] > 100 && pixel[2] > 100, `expected painted synthetic rectangle: ${pixel}`);
    assert.equal(requests, 0);
    assert.equal(globalThis.__pdfEvidenceScriptExecuted, false);
    await assert.rejects(handle.renderPage(canvas, 0), /1~2/);
    await assert.rejects(handle.renderPage(canvas, 3), /1~2/);
    await handle.renderPage(canvas, 2, { width: 1200, pixelRatio: 2 });
    assert.ok(canvas.width * canvas.height <= 16_000_000);
  } finally { await handle?.destroy(); globalThis.fetch = previousFetch; delete globalThis.__pdfEvidenceScriptExecuted; }
  await assert.rejects(handle.renderPage(createCanvas(1, 1), 1), { name: 'AbortError' });
});
