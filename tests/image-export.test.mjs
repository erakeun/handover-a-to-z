import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { createDocument, createTask, createCase, stringifyDocument, parseImport } from '../src/model.js';
import { inspectImageBytes, encodeBase64, decodeBase64 } from '../src/image-data.js';
import { exportDocx, exportAIText } from '../src/exporters.js';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
};

async function attachment(filename, id, section, caption) {
  const bytes = new Uint8Array(await readFile(new URL(`../fixtures/images/${filename}`, import.meta.url)));
  const { mime, width, height } = inspectImageBytes(bytes);
  return { id, section, caption, mime, width, height, data: encodeBase64(bytes) };
}

async function fixture() {
  return createDocument({
    schemaVersion: 2, id: 'image-export-document', title: '합성 사진 포함 인수인계',
    tasks: [
      createTask({
        id: 'image-task-one', title: '화면을 보며 접수 확인',
        method: '방법 본문 고유 문장.\n원본 한글과 줄바꿈을 보존합니다.',
        steps: '단계 본문 고유 문장.\n1. 목록 확인\n2. 결과 저장',
        images: [
          await attachment('large-landscape.png', 'image-method', 'method', '가로 사진 설명\n두 번째 줄 & <script>문자 그대로</script>'),
          await attachment('large-portrait.jpg', 'image-step', 'steps', '세로 사진 설명 · 2단계 결과 확인'),
        ],
      }),
      createTask({
        id: 'image-task-two', title: '선택하지 않은 별도 업무', method: '',
        images: [await attachment('portrait.png', 'image-unselected', 'method', '선택하지 않은 사진 설명')],
      }),
    ],
    cases: [createCase({ id: 'image-case', title: '사진 없는 진행 건', nextAction: '다음 회신 확인' })],
  });
}

function xmlDocument(text) {
  const errors = [];
  const document = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) })
    .parseFromString(text, 'application/xml');
  assert.deepEqual(errors, []);
  return document;
}

function textOf(node) {
  if (node.nodeType === 1 && node.namespaceURI === NS.w) {
    if (node.localName === 't') return node.textContent;
    if (node.localName === 'br') return '\n';
    if (node.localName === 'tab') return '\t';
  }
  return Array.from(node.childNodes ?? []).map(textOf).join('');
}

async function reopen(document, options) {
  const bytes = await exportDocx(document, options);
  const entries = unzipSync(bytes);
  for (const [name, value] of Object.entries(entries)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) xmlDocument(strFromU8(value));
  }
  const dom = xmlDocument(strFromU8(entries['word/document.xml']));
  const paragraphs = Array.from(dom.getElementsByTagNameNS(NS.w, 'p'));
  const media = Object.entries(entries).filter(([name, value]) => /^word\/media\/[^/]+$/.test(name) && value.length);
  return { entries, dom, paragraphs, media, text: paragraphs.map(textOf).join('\n') };
}

test('DOCX embeds exact PNG and JPEG bytes and keeps photos beside their method or steps', async () => {
  const document = await fixture();
  const original = stringifyDocument(document);
  // Test the actual JSON transport path before document export.
  const restored = parseImport(original).document;
  const result = await reopen(restored);
  assert.equal(stringifyDocument(document), original, 'export does not mutate the source');
  assert.equal(result.media.length, 3);
  for (const image of document.tasks.flatMap(task => task.images ?? [])) {
    assert.ok(result.media.some(([, bytes]) => Buffer.from(bytes).equals(Buffer.from(decodeBase64(image.data)))));
  }
  assert.equal(result.dom.getElementsByTagNameNS(NS.wp, 'inline').length, 3);
  assert.equal(result.dom.getElementsByTagNameNS(NS.wp, 'anchor').length, 0);
  for (const rect of Array.from(result.dom.getElementsByTagNameNS(NS.a, 'srcRect'))) {
    for (const side of ['l', 'r', 't', 'b']) assert.equal(Number(rect.getAttribute(side) || 0), 0, 'photos are never cropped');
  }
  for (const task of document.tasks) {
    for (const image of task.images ?? []) {
      assert.ok(result.text.includes(image.caption));
      assert.ok(result.text.indexOf(task.title) < result.text.indexOf(image.caption));
    }
  }
  assert.ok(result.text.indexOf(document.tasks[0].method) < result.text.indexOf(document.tasks[0].images[0].caption));
  assert.ok(result.text.indexOf(document.tasks[0].images[0].caption) < result.text.indexOf(document.tasks[0].steps));
  assert.ok(result.text.indexOf(document.tasks[0].steps) < result.text.indexOf(document.tasks[0].images[1].caption));
  assert.equal(result.dom.getElementsByTagName('script').length, 0, 'caption markup remains literal text');
  assert.ok(!strFromU8(result.entries['word/_rels/document.xml.rels']).includes('TargetMode="External"'));
  const types = strFromU8(result.entries['[Content_Types].xml']);
  assert.ok(types.includes('image/png'));
  assert.ok(types.includes('image/jpeg'));
});

test('large landscape and portrait photos fit A4, preserve proportions and stay with captions', async () => {
  const document = await fixture();
  const result = await reopen(document, { taskIds: ['image-task-one'], caseIds: [] });
  const images = document.tasks[0].images;
  const drawings = Array.from(result.dom.getElementsByTagNameNS(NS.wp, 'inline'));
  assert.equal(drawings.length, 2);
  drawings.forEach((drawing, index) => {
    const extent = drawing.getElementsByTagNameNS(NS.wp, 'extent')[0];
    const width = Number(extent.getAttribute('cx')) / 9525;
    const height = Number(extent.getAttribute('cy')) / 9525;
    assert.ok(width <= 640 && height <= 650);
    assert.ok(Math.abs(width / height - images[index].width / images[index].height) < 0.00001);
    const properties = drawing.getElementsByTagNameNS(NS.wp, 'docPr')[0];
    // XML attribute whitespace is normalized; the visible caption paragraph
    // separately preserves its complete line breaks and literal markup.
    assert.equal(properties.getAttribute('descr'), images[index].caption.replace(/[\n\r\t]/g, ' '));
    assert.equal(properties.getAttribute('name'), images[index].id);
    assert.ok(properties.getAttribute('title').includes(document.tasks[0].title));
  });
  result.paragraphs.forEach((paragraph, index) => {
    if (!paragraph.getElementsByTagNameNS(NS.wp, 'inline').length) return;
    assert.equal(paragraph.getElementsByTagNameNS(NS.w, 'keepNext').length, 1);
    const spacing = paragraph.getElementsByTagNameNS(NS.w, 'spacing')[0];
    assert.equal(spacing.getAttribute('w:lineRule'), 'auto');
    const caption = result.paragraphs[index + 1];
    assert.match(textOf(caption), /^(방법|단계) 사진 \d+/);
    assert.equal(caption.getElementsByTagNameNS(NS.w, 'keepNext')[0]?.getAttribute('w:val'), 'false');
    assert.equal(caption.getElementsByTagNameNS(NS.w, 'keepLines')[0]?.getAttribute('w:val'), 'false');
  });
});

test('selection excludes other task photos and a case-only export contains no photos', async () => {
  const document = await fixture();
  const selected = await reopen(document, { taskIds: ['image-task-two'], caseIds: [] });
  assert.equal(selected.media.length, 1);
  assert.ok(selected.text.includes('선택하지 않은 사진 설명'));
  assert.ok(!selected.text.includes('가로 사진 설명'));
  assert.ok(!selected.text.includes('세로 사진 설명'));
  const cases = await reopen(document, { taskIds: [], caseIds: ['image-case'] });
  assert.equal(cases.media.length, 0);
  assert.equal(cases.dom.getElementsByTagNameNS(NS.wp, 'inline').length, 0);
  assert.ok(cases.text.includes(document.cases[0].nextAction));
});

test('photo-only method and steps sections are present even without text or captions', async () => {
  const document = await fixture();
  const task = document.tasks[0];
  task.method = '';
  task.steps = '';
  task.images.forEach(image => { image.caption = ''; });
  document.tasks = [task];
  const result = await reopen(document);
  assert.equal(result.media.length, 2);
  assert.ok(result.text.includes('어떤 방식으로 하나요'));
  assert.ok(result.text.includes('수행 절차'));
  assert.ok(result.text.includes('방법 사진 1'));
  assert.ok(result.text.includes('단계 사진 1'));
  assert.ok(!result.text.split('\n').find(line => line.startsWith('미입력 항목:'))?.includes('수행 절차'));
});

test('AI export excludes photo binary and captions even with all sensitive-text options enabled', async () => {
  const document = await fixture();
  const result = exportAIText(document, { includeContacts: true, includeMaterials: true, includeEvidence: true });
  assert.ok(result.includes('첨부 사진과 사진 설명은 이 AI 텍스트에서 제외됩니다.'));
  for (const image of document.tasks.flatMap(task => task.images)) {
    assert.ok(!result.includes(image.data));
    assert.ok(!result.includes(image.caption));
  }
  assert.ok(result.includes(document.tasks[0].method));
  assert.ok(result.includes(document.tasks[0].steps));
});
