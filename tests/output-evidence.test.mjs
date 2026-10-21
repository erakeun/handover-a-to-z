import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { reviewExampleDocument } from '../src/review-example.js';
import { createDocument, createTask, makeId, stringifyDocument, parseImport, importAsCopy, CURRENT_SCHEMA_VERSION } from '../src/model.js';
import { inspectImageBytes, decodeBase64 } from '../src/image-data.js';
import { linkedPdfSources, parseEvidencePages, prepareOutputEvidence, storedOutputPages, outputEvidencePlan, fullSourceOutputPlan, applyEvidencePageGroups, OUTPUT_EVIDENCE_LIMITS } from '../src/output-evidence.js';

// Synthetic fixtures and Node canvases only. These are output logic checks,
// not browser interaction, Word layout, or human usability measurements.
const dom = { createElement: tag => { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };
const oneTask = doc => ({ taskIds: [doc.tasks[0].id], caseIds: [] });

test('linked sources use the selected tasks/cases only, and do not infer same-source task dependencies', () => {
  const doc = reviewExampleDocument();
  const second = { ...doc.sourceFiles[0], id: makeId(), name: 'second-synthetic.pdf' };
  doc.sourceFiles.push(second);
  doc.tasks[1].sourceRefs = [second.id];
  doc.cases[0].sourceRefs = [second.id];
  assert.deepEqual(linkedPdfSources(doc, oneTask(doc)).map(s => s.id), [doc.sourceFiles[0].id]);
  assert.deepEqual(linkedPdfSources(doc, { taskIds: [], caseIds: [doc.cases[0].id] }).map(s => s.id), [second.id]);
  assert.equal(linkedPdfSources(doc).length, 2);
  assert.deepEqual(linkedPdfSources(doc, { taskIds: [], caseIds: [] }), []);
  assert.throws(() => linkedPdfSources(doc, { taskIds: ['missing'], caseIds: [] }), /찾을 수 없습니다/);
  assert.throws(() => linkedPdfSources(doc, { taskIds: 'all' }), /찾을 수 없습니다/);
  doc.tasks[0].sourceRefs.push('absent-source');
  assert.throws(() => linkedPdfSources(doc, oneTask(doc)), /근거 파일/);
});

test('page choices are explicit, strict, bounded, sorted and deduplicated', () => {
  assert.deepEqual(parseEvidencePages(' 4, 1, 2 - 4, 1 ', 5), [1, 2, 3, 4]);
  assert.deepEqual(parseEvidencePages('1-20, 2', 200), Array.from({ length: 20 }, (_, i) => i + 1));
  for (const value of ['', ' ', undefined, '0', '-1', '01', '1.5', '1e1', '1,', '1,,2', '3-2', '1-6', '1 2', '1–2']) {
    assert.throws(() => parseEvidencePages(value, 5), /쪽/);
  }
  assert.throws(() => parseEvidencePages('1-21', 200), /20쪽/);
  assert.throws(() => parseEvidencePages('1-20,21', 200), /20쪽/);
  assert.throws(() => parseEvidencePages('1', 0), /쪽수/);
  assert.throws(() => parseEvidencePages('1', 201), /쪽수/);
});

test('stored page choices are reused only when every selected item has a page relation, with single-page automatic choice', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id;
  for (const item of [...doc.tasks, ...doc.cases]) delete item.sourcePages;
  assert.deepEqual(storedOutputPages(doc, oneTask(doc)), {});
  doc.tasks[0].sourcePages = [{ sourceId, pages: [1] }];
  assert.deepEqual(storedOutputPages(doc, oneTask(doc)), { [sourceId]: '1' });
  const twoTasks = { taskIds: [doc.tasks[0].id, doc.tasks[1].id], caseIds: [] };
  assert.deepEqual(storedOutputPages(doc, twoTasks), {}, 'one task must not borrow another task’s selected pages');
  doc.tasks[1].sourcePages = [{ sourceId, pages: [2, 1] }];
  assert.deepEqual(storedOutputPages(doc, twoTasks), { [sourceId]: '1, 2' });
  assert.deepEqual(storedOutputPages(doc, { taskIds: [], caseIds: [doc.cases[0].id] }), {});
  doc.cases[0].sourcePages = [{ sourceId, pages: [2] }];
  assert.deepEqual(storedOutputPages(doc, { taskIds: [], caseIds: [doc.cases[0].id] }), { [sourceId]: '2' });
  doc.sourceFiles[0].pdf.pageCount = 1;
  delete doc.tasks[0].sourcePages;
  assert.deepEqual(storedOutputPages(doc, oneTask(doc)), { [sourceId]: '1' });
});

test('page planning asks only unconfirmed relations and never infers case pages from its linked task', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id;
  doc.tasks[0].sourcePages = [{ sourceId, pages: [1] }];
  const before = JSON.stringify(doc), plan = outputEvidencePlan(doc);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].records.length, 8);
  assert.deepEqual(plan[0].records[0], { itemId: doc.tasks[0].id, kind: 'task', title: doc.tasks[0].title, pages: [1], state: 'confirmed' });
  assert.equal(plan[0].records.filter(record => record.state === 'unconfirmed').length, 7);
  const linkedCase = plan[0].records.find(record => record.itemId === doc.cases[0].id);
  assert.equal(doc.cases[0].taskId, doc.tasks[0].id);
  assert.equal(linkedCase.kind, 'case');
  assert.equal(linkedCase.state, 'unconfirmed');
  assert.deepEqual(linkedCase.pages, []);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(outputEvidencePlan(doc, oneTask(doc))[0].records.length, 1);
  doc.sourceFiles[0].pdf.pageCount = 1;
  const singlePage = outputEvidencePlan(doc)[0].records;
  assert.equal(singlePage.filter(record => record.state === 'unconfirmed').length, 0);
  assert.equal(singlePage.filter(record => record.state === 'single-page').length, 7);
  assert.ok(singlePage.every(record => record.pages.join(',') === '1'));
  assert.equal(doc.cases[0].sourcePages, undefined, 'automatic single-page output must not write a relation');
});

test('two explicit page groups preserve all eight selected relations and content through file round trip', () => {
  const doc = reviewExampleDocument(); doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  const sourceId = doc.sourceFiles[0].id, before = stringifyDocument(doc);
  const pageOne = [doc.tasks[0].id, doc.tasks[4].id, doc.cases[0].id];
  const pageTwo = [doc.tasks[1].id, doc.tasks[2].id, doc.tasks[3].id, doc.tasks[5].id, doc.cases[1].id];
  const groups = [{ sourceId, itemIds: pageOne, pages: '1' }, { sourceId, itemIds: pageTwo, pages: '2' }];
  const input = JSON.stringify(groups), candidate = applyEvidencePageGroups(doc, {}, groups);
  for (const item of [...candidate.tasks, ...candidate.cases]) {
    assert.deepEqual(item.sourcePages, [{ sourceId, pages: pageOne.includes(item.id) ? [1] : [2] }]);
  }
  assert.deepEqual(storedOutputPages(candidate), { [sourceId]: '1, 2' });
  assert.equal(outputEvidencePlan(candidate)[0].records.filter(record => record.state === 'unconfirmed').length, 0);
  assert.equal(JSON.stringify(groups), input);
  assert.equal(stringifyDocument(doc), before);
  const restored = parseImport(stringifyDocument(candidate));
  assert.deepEqual(restored.document, candidate);
  const copied = importAsCopy(restored.document);
  for (let index = 0; index < copied.tasks.length; index++) assert.deepEqual(copied.tasks[index].sourcePages, [{ sourceId: copied.sourceFiles[0].id, pages: candidate.tasks[index].sourcePages[0].pages }]);
  assert.deepEqual(copied.tasks[0].images, candidate.tasks[0].images.map(image => ({ ...image, id: copied.tasks[0].images[0].id })));
  assert.deepEqual(copied.sourceFiles[0].pdf, doc.sourceFiles[0].pdf);
  const contentOnly = structuredClone(candidate);
  for (const item of [...contentOnly.tasks, ...contentOnly.cases]) delete item.sourcePages;
  assert.deepEqual(contentOnly, doc, 'only the explicit page relations are added');
});

test('whole-source appendix plan needs one source choice without inventing eight page relations', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id;
  const before = stringifyDocument(doc);
  assert.deepEqual(fullSourceOutputPlan(doc), { pageChoices: { [sourceId]: '1, 2' }, wholeSourceIds: [sourceId], totalPages: 2 });
  assert.deepEqual(fullSourceOutputPlan(doc, oneTask(doc)), { pageChoices: { [sourceId]: '1, 2' }, wholeSourceIds: [sourceId], totalPages: 2 });
  assert.equal(stringifyDocument(doc), before);
  assert.ok([...doc.tasks, ...doc.cases].every(item => !item.sourcePages));
  assert.deepEqual(parseImport(stringifyDocument(doc)).document, doc);
});

test('appendix plan keeps confirmed ranges and single-page sources without unnecessarily adding whole originals', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id;
  doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  doc.tasks[0].sourcePages = [{ sourceId, pages: [2] }];
  assert.deepEqual(fullSourceOutputPlan(doc, oneTask(doc)), { pageChoices: { [sourceId]: '2' }, wholeSourceIds: [], totalPages: 1 });
  const second = { ...structuredClone(doc.sourceFiles[0]), id: makeId(), name: 'single-page-synthetic.pdf' };
  second.pdf.pageCount = 1;
  doc.sourceFiles.push(second); doc.tasks[0].sourceRefs.push(second.id);
  const before = JSON.stringify(doc);
  assert.deepEqual(fullSourceOutputPlan(doc, oneTask(doc)), { pageChoices: { [sourceId]: '2', [second.id]: '1' }, wholeSourceIds: [], totalPages: 2 });
  assert.equal(JSON.stringify(doc), before);
  assert.deepEqual(fullSourceOutputPlan(doc, { taskIds: [], caseIds: [] }), { pageChoices: {}, wholeSourceIds: [], totalPages: 0 });
});

test('appendix plan refuses too many original pages atomically and excludes unselected sources', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id;
  const second = { ...structuredClone(doc.sourceFiles[0]), id: makeId(), name: 'long-synthetic.pdf' };
  second.pdf.pageCount = 19;
  doc.sourceFiles.push(second); doc.tasks[1].sourceRefs = [second.id];
  const before = JSON.stringify(doc);
  assert.equal(fullSourceOutputPlan(doc, oneTask(doc)).totalPages, 2);
  assert.throws(() => fullSourceOutputPlan(doc), /총 20쪽/);
  assert.equal(JSON.stringify(doc), before);
  second.pdf.pageCount = 18;
  assert.equal(fullSourceOutputPlan(doc).totalPages, 20);
  second.pdf.pageCount = 21;
  assert.throws(() => fullSourceOutputPlan(doc), /20쪽/);
  assert.throws(() => fullSourceOutputPlan(doc, { taskIds: ['missing'] }), /찾을 수 없습니다/);
  doc.tasks[0].sourceRefs.push('missing');
  assert.throws(() => fullSourceOutputPlan(doc, oneTask(doc)), /근거 파일/);
  assert.equal(sourceId, doc.sourceFiles[0].id);
});

test('99-page synthetic metadata blocks whole appendices but permits explicitly selected necessary pages', async () => {
  // Metadata-only boundary fixture, not a real 99-page PDF or personal source.
  // The renderer below is a controlled fake; this does not claim PDF import QA.
  const doc = reviewExampleDocument(); doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  const source = doc.sourceFiles[0];
  source.name = '[synthetic metadata only] 99-page-original.pdf';
  source.pdf.pageCount = 99;
  const before = stringifyDocument(doc);
  assert.throws(() => fullSourceOutputPlan(doc), /20쪽/);
  assert.throws(() => fullSourceOutputPlan(doc, oneTask(doc)), /20쪽/);
  assert.equal(stringifyDocument(doc), before, 'refusing a long appendix must not trim or rewrite the source');

  const candidate = applyEvidencePageGroups(doc, oneTask(doc), [{
    sourceId: source.id, itemIds: [doc.tasks[0].id], pages: '8, 13, 99',
  }]);
  const plan = fullSourceOutputPlan(candidate, oneTask(candidate));
  assert.deepEqual(plan, { pageChoices: { [source.id]: '8, 13, 99' }, wholeSourceIds: [], totalPages: 3 });
  assert.throws(() => fullSourceOutputPlan(candidate), /20쪽/, 'one task’s explicit pages must not be inferred for other tasks');
  const candidateBefore = stringifyDocument(candidate), rendered = [];
  let opened = 0, destroyed = 0;
  const pages = await prepareOutputEvidence(candidate, oneTask(candidate), plan.pageChoices, {
    dom, openEvidence: fakeOpen({ opened: () => opened++, destroyed: () => destroyed++, render: (_canvas, number) => rendered.push(number) }),
  });
  assert.deepEqual(rendered, [8, 13, 99]);
  assert.deepEqual(pages.map(page => page.pageNumber), [8, 13, 99]);
  assert.equal(opened, 1); assert.equal(destroyed, 1);
  assert.equal(stringifyDocument(candidate), candidateBefore);
  assert.equal(stringifyDocument(doc), before);
  assert.deepEqual(candidate.sourceFiles, doc.sourceFiles);
});

test('eight guides sharing a long original render each explicitly chosen page once, not once per guide', async () => {
  const doc = reviewExampleDocument(); doc.schemaVersion = CURRENT_SCHEMA_VERSION;
  const source = doc.sourceFiles[0];
  source.name = '[synthetic metadata only] shared-99-page-original.pdf';
  source.pdf.pageCount = 99;
  const before = stringifyDocument(doc), itemIds = [...doc.tasks, ...doc.cases].map(item => item.id);
  assert.equal(itemIds.length, 8);
  const candidate = applyEvidencePageGroups(doc, {}, [{ sourceId: source.id, itemIds, pages: '8-13' }]);
  const plan = fullSourceOutputPlan(candidate);
  assert.deepEqual(plan, { pageChoices: { [source.id]: '8, 9, 10, 11, 12, 13' }, wholeSourceIds: [], totalPages: 6 });
  const rendered = []; let opened = 0, destroyed = 0;
  const pages = await prepareOutputEvidence(candidate, {}, plan.pageChoices, {
    dom, openEvidence: fakeOpen({ opened: () => opened++, destroyed: () => destroyed++, render: (_canvas, number) => rendered.push(number) }),
  });
  assert.deepEqual(rendered, [8, 9, 10, 11, 12, 13]);
  assert.equal(pages.length, 6, 'six source pages must not become 48 repeated pages for eight guides');
  assert.equal(new Set(pages.map(page => `${page.sourceId}:${page.pageNumber}`)).size, 6);
  assert.equal(opened, 1); assert.equal(destroyed, 1);
  assert.equal(stringifyDocument(doc), before);
  assert.deepEqual(candidate.sourceFiles, doc.sourceFiles);
  const contentOnly = structuredClone(candidate);
  for (const item of [...contentOnly.tasks, ...contentOnly.cases]) delete item.sourcePages;
  assert.deepEqual(contentOnly, doc, 'explicit relations are the only saved change');
});

test('partial batch leaves other relations unconfirmed, protects saved choices, and allows explicit review', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id;
  doc.tasks[0].sourcePages = [{ sourceId, pages: [2, 1] }];
  const before = JSON.stringify(doc);
  const candidate = applyEvidencePageGroups(doc, {}, [{ sourceId, itemIds: [doc.tasks[1].id, doc.tasks[2].id], pages: '2' }]);
  assert.deepEqual(candidate.tasks[0].sourcePages, doc.tasks[0].sourcePages);
  assert.equal(outputEvidencePlan(candidate)[0].records.filter(record => record.state === 'unconfirmed').length, 5);
  assert.deepEqual(storedOutputPages(candidate), {}, 'partial groups do not silently omit unresolved evidence');
  assert.throws(() => applyEvidencePageGroups(doc, {}, [{ sourceId, itemIds: [doc.tasks[0].id], pages: '1' }]), /이미 확인한/);
  const unchanged = applyEvidencePageGroups(doc, {}, [{ sourceId, itemIds: [doc.tasks[0].id], pages: '1, 2' }]);
  assert.deepEqual(unchanged, doc, 'reusing the same range preserves the original confirmed order');
  const reviewed = applyEvidencePageGroups(doc, {}, [{ sourceId, itemIds: [doc.tasks[0].id], pages: '1' }], { replaceConfirmed: true });
  assert.deepEqual(reviewed.tasks[0].sourcePages, [{ sourceId, pages: [1] }]);
  assert.equal(JSON.stringify(doc), before);
});

test('invalid batch selections are rejected atomically without changing the original', () => {
  const doc = reviewExampleDocument(), sourceId = doc.sourceFiles[0].id, before = JSON.stringify(doc);
  const valid = { sourceId, itemIds: [doc.tasks[0].id], pages: '1' };
  for (const groups of [null, [{}], [{ ...valid, itemIds: [] }], [{ ...valid, itemIds: 'all' }], [{ ...valid, itemIds: ['missing'] }], [{ ...valid, sourceId: 'missing' }], [{ ...valid, pages: '3' }], [valid, { ...valid, pages: '2' }], [{ ...valid, itemIds: [doc.tasks[0].id, doc.tasks[0].id] }], [valid, { ...valid, itemIds: [doc.tasks[1].id], pages: '0' }]]) {
    assert.throws(() => applyEvidencePageGroups(doc, {}, groups));
    assert.equal(JSON.stringify(doc), before);
  }
  assert.throws(() => applyEvidencePageGroups(doc, oneTask(doc), [{ ...valid, itemIds: [doc.tasks[1].id] }]), /연결되지 않은/);
  const second = { ...doc.sourceFiles[0], id: makeId() };
  doc.sourceFiles.push(second); doc.tasks[1].sourceRefs = [second.id];
  assert.throws(() => applyEvidencePageGroups(doc, {}, [{ ...valid, itemIds: [doc.tasks[1].id] }]), /연결되지 않은/);
  assert.equal(doc.tasks[0].sourcePages, undefined);
});

test('actual synthetic PDF page is included as PNG while original document, photos and PDF remain unchanged', async () => {
  const doc = reviewExampleDocument();
  const before = stringifyDocument(doc);
  const selection = oneTask(doc);
  const choices = { [doc.sourceFiles[0].id]: '1' };
  const input = JSON.stringify({ selection, choices });
  const result = await prepareOutputEvidence(doc, selection, choices, { dom });
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceId, doc.sourceFiles[0].id);
  assert.equal(result[0].pageNumber, 1);
  assert.equal(result[0].width, 1400);
  assert.ok(result[0].height > result[0].width);
  assert.equal(inspectImageBytes(decodeBase64(result[0].data)).mime, 'image/png');
  assert.equal(stringifyDocument(doc), before);
  assert.equal(JSON.stringify({ selection, choices }), input);
});

test('missing, unrelated and excessive evidence choices fail before rendering any page', async () => {
  const doc = reviewExampleDocument();
  let opened = 0;
  const options = { dom, openEvidence: async () => { opened++; throw new Error('should not open'); } };
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), {}, options), /근거 쪽/);
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { unrelated: '1' }, options), /연결되지 않은/);
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { [doc.sourceFiles[0].id]: '3' }, options), /1~2/);
  doc.sourceFiles[0].pdf.pageCount = 20;
  const second = { ...doc.sourceFiles[0], id: makeId() };
  doc.sourceFiles.push(second); doc.tasks[0].sourceRefs.push(second.id);
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { [doc.sourceFiles[0].id]: '1-20', [second.id]: '1' }, options), /총 20쪽/);
  assert.equal(opened, 0);
  assert.deepEqual(OUTPUT_EVIDENCE_LIMITS, { pages: 20, pageBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
});

test('PDF-free legacy-compatible output needs no page choices or canvas', async () => {
  const doc = createDocument({ tasks: [createTask({ title: '가상 텍스트 업무', method: '안내를 읽습니다.' })] });
  const before = stringifyDocument(doc);
  assert.deepEqual(await prepareOutputEvidence(doc), []);
  assert.equal(stringifyDocument(doc), before);
});

function fakeOpen({ render, opened = () => {}, destroyed = () => {} }) {
  return async () => {
    opened();
    return { renderPage: async (canvas, pageNumber, options) => {
      assert.deepEqual(options, { width: 1400, pixelRatio: 1 });
      canvas.width = 60; canvas.height = 80;
      const context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, 60, 80);
      context.fillStyle = 'black'; context.fillRect(10, 10, 30, 30);
      await render?.(canvas, pageNumber);
    }, destroy: async () => { destroyed(); } };
  };
}

test('later render failure returns no partial output, destroys handle and preserves source', async () => {
  const doc = reviewExampleDocument(), before = stringifyDocument(doc);
  let destroyed = 0, rendered = 0;
  const canvases = [];
  const openEvidence = fakeOpen({ render: (canvas, pageNumber) => {
    rendered++; canvases.push(canvas);
    if (pageNumber === 2) throw new Error('synthetic render failure');
  }, destroyed: () => destroyed++ });
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { [doc.sourceFiles[0].id]: '1-2' }, { dom, openEvidence }), /synthetic render failure/);
  assert.equal(rendered, 2); assert.equal(destroyed, 1);
  // napi-rs resets a zero-sized canvas to its default size, unlike browser
  // canvas. It still releases the previous render surface.
  assert.ok(canvases.every(canvas => canvas.width !== 60 && canvas.height !== 80));
  assert.equal(stringifyDocument(doc), before);
});

test('cancelled render never returns evidence and releases the opened handle', async () => {
  const doc = reviewExampleDocument();
  let active = true, destroyed = 0;
  const openEvidence = fakeOpen({ render: () => { active = false; }, destroyed: () => destroyed++ });
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { [doc.sourceFiles[0].id]: '1' }, { dom, openEvidence, isCurrent: () => active }), { name: 'AbortError' });
  assert.equal(destroyed, 1);
});

test('blank or invalid PNG pages fail rather than becoming missing evidence in an output', async () => {
  const doc = reviewExampleDocument();
  let destroyed = 0;
  const blank = fakeOpen({ render: canvas => {
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  }, destroyed: () => destroyed++ });
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { [doc.sourceFiles[0].id]: '1' }, { dom, openEvidence: blank }), /표시된 내용이 없습니다/);
  const invalid = fakeOpen({ render: canvas => { canvas.toDataURL = () => 'data:image/png;base64,bm90LXBuZw=='; }, destroyed: () => destroyed++ });
  await assert.rejects(prepareOutputEvidence(doc, oneTask(doc), { [doc.sourceFiles[0].id]: '1' }, { dom, openEvidence: invalid }), /실제 PNG/);
  assert.equal(destroyed, 2);
});
