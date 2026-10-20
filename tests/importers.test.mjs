import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, unzipSync, strToU8, Zip, ZipDeflate } from 'fflate';
import { extractDocument, supportedFormats } from '../src/importers.js';

const fixture = async (name) => file(name, await readFile(new URL(`../fixtures/import/${name}`, import.meta.url)));
function file(name, bytes) {
  return {
    name, size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
function archive(entries, level = 6) {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) =>
    [name, typeof value === 'string' ? strToU8(value) : value])), { level });
}
const wordNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const word = (body) => `<w:document xmlns:w="${wordNS}"><w:body>${body}</w:body></w:document>`;
const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = (xml) => file('synthetic.docx', archive({ 'word/document.xml': xml }));
const base = () => archive({ 'word/document.xml': word(paragraph('Synthetic test')) });
function central(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(bytes.length - 6, true);
}
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

test('supported formats are explicit and exclude legacy HWP', () => {
  assert.deepEqual(supportedFormats, ['docx', 'pptx', 'hwpx', 'pdf']);
  assert.ok(Object.isFrozen(supportedFormats));
});

test('actual DOCX fixture preserves paragraph/table order and literal markup', async () => {
  const result = await extractDocument(await fixture('synthetic-body-table.docx'));
  assert.equal(result.format, 'docx');
  assert.deepEqual(result.blocks.map((b) => b.kind), ['paragraph', 'paragraph', 'table', 'paragraph']);
  assert.equal(result.blocks[1].text, '<img src=x onerror=alert(1)> 는 글자입니다.');
  assert.equal(result.blocks[2].text, '업무\t담당\n재고 확인\t가상 담당자');
  assert.ok(result.blocks.every((b) => b.id && b.source.includes('synthetic-body-table.docx')));
  assert.match(result.warnings.join(' '), /머리말.*주석/);
  assert.match(result.warnings.join(' '), /병합 셀/);
});

test('actual HWPX fixture follows manifest order and extracts nested tables once', async () => {
  const result = await extractDocument(await fixture('synthetic-sections-table.hwpx'));
  assert.deepEqual(result.blocks.map((b) => b.text), [
    '합성 테스트: 첫 번째 구역', '점검\t매주', '합성 테스트: 두 번째 구역',
  ]);
  assert.deepEqual(result.blocks.map((b) => b.kind), ['paragraph', 'table', 'paragraph']);
  assert.match(result.blocks[0].source, /구역 1.*section1/);
});

test('HWPX also resolves content.hpf-relative section hrefs', async () => {
  const source = await fixture('synthetic-sections-table.hwpx');
  const entries = unzipSync(new Uint8Array(await source.arrayBuffer()));
  entries['Contents/content.hpf'] = strToU8(new TextDecoder().decode(entries['Contents/content.hpf'])
    .replaceAll('href="Contents/section', 'href="section'));
  const result = await extractDocument(file('synthetic.hwpx', zipSync(entries)));
  assert.match(result.blocks[0].text, /첫 번째/);
});

test('HWPX accepts legitimate parent-relative manifest targets', async () => {
  const source = await fixture('synthetic-sections-table.hwpx');
  const entries = unzipSync(new Uint8Array(await source.arrayBuffer()));
  entries['Contents/content.hpf'] = strToU8(new TextDecoder().decode(entries['Contents/content.hpf'])
    .replaceAll('href="Contents/section', 'href="../Contents/section'));
  const result = await extractDocument(file('synthetic.hwpx', zipSync(entries)));
  assert.match(result.blocks[0].text, /첫 번째/);
});

test('HWPX header, footnote and textbox tables never become body blocks', async () => {
  const source = await fixture('synthetic-sections-table.hwpx');
  const entries = unzipSync(new Uint8Array(await source.arrayBuffer()));
  const section = new TextDecoder().decode(entries['Contents/section1.xml']);
  const table = section.match(/<hp:tbl[\s\S]*<\/hp:tbl>/u)[0];
  entries['Contents/section1.xml'] = strToU8(section.replace('</hp:t>', '</hp:t><hp:ctrl>'
    + `<hp:header>${table.replaceAll('점검', 'HEADER')}</hp:header>`
    + `<hp:footNote>${table.replaceAll('점검', 'FOOTNOTE')}</hp:footNote>`
    + `<hp:rect>${table.replaceAll('점검', 'TEXTBOX')}</hp:rect></hp:ctrl>`));
  const result = await extractDocument(file('synthetic.hwpx', zipSync(entries)));
  assert.deepEqual(result.blocks.map((b) => b.text), [
    '합성 테스트: 첫 번째 구역', '점검\t매주', '합성 테스트: 두 번째 구역',
  ]);
});

test('HWPX without a manifest uses numeric section order with an explicit warning', async () => {
  const sec = (text) => `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hs:sec>`;
  const result = await extractDocument(file('synthetic.hwpx', archive({
    'Contents/section10.xml': sec('ten'), 'Contents/section2.xml': sec('two'),
  })));
  assert.deepEqual(result.blocks.map((b) => b.text), ['two', 'ten']);
  assert.match(result.warnings.join(' '), /section 번호/);
});

test('actual PPTX fixture follows presentation relationship order, not filenames', async () => {
  const result = await extractDocument(await fixture('synthetic-slide-order.pptx'));
  assert.deepEqual(result.blocks.map((b) => b.text), ['합성 테스트: 첫 슬라이드', '합성 테스트: 마지막 슬라이드']);
  assert.ok(result.blocks.every((b) => b.kind === 'slide'));
  assert.match(result.blocks[0].source, /슬라이드 1.*slide2/);
  assert.match(result.warnings.join(' '), /발표자 노트/);
});

test('actual PDF bytes yield text from page 1 and an image-only page warning', async () => {
  const result = await extractDocument(await fixture('synthetic-text-and-scan.pdf'));
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].kind, 'page');
  assert.match(result.blocks[0].text, /SYNTHETIC TEST: monthly handover/);
  assert.match(result.blocks[0].text, /Check records, then confirm/);
  assert.match(result.blocks[0].source, /1쪽/);
  assert.match(result.warnings.join(' '), /2쪽.*OCR/);
});

test('HWP rejection happens before reading any bytes and gives conversion advice', async () => {
  let read = false;
  await assert.rejects(() => extractDocument({
    name: 'old.HWP', size: 1024,
    arrayBuffer: async () => { read = true; throw new Error('must not read'); },
  }), /HWPX.*DOCX.*붙여넣기/);
  assert.equal(read, false);
  await assert.rejects(() => fixture('synthetic-legacy.hwp').then(extractDocument), /구형 HWP/);
});

test('malformed ZIP and a renamed non-PDF are rejected', async () => {
  await assert.rejects(() => fixture('synthetic-malformed.docx').then(extractDocument), /ZIP/);
  await assert.rejects(() => extractDocument(file('fake.pdf', strToU8('not a PDF'))), /PDF 헤더/);
});

test('20 MiB upload limit is checked before and after reading', async () => {
  let read = false;
  await assert.rejects(() => extractDocument({
    name: 'large.docx', size: 20 * 1024 * 1024 + 1,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
  }), /20 MiB/);
  assert.equal(read, false);
  await assert.rejects(() => extractDocument({
    name: 'lying.docx', size: 1, arrayBuffer: async () => new ArrayBuffer(20 * 1024 * 1024 + 1),
  }), /실제 파일 크기/);
});

test('declared ZIP expanded size exceeding 30 MiB is rejected before inflation', async () => {
  const bytes = base();
  view(bytes).setUint32(central(bytes) + 24, 31 * 1024 * 1024, true);
  await assert.rejects(() => extractDocument(file('bomb.docx', bytes)), /30 MiB/);
});

test('lying small ZIP size is caught by bounded streaming inflation', async () => {
  const bytes = archive({ 'word/document.xml': word(paragraph('x'.repeat(1024 * 1024))) });
  const v = view(bytes);
  v.setUint32(22, 32, true);
  v.setUint32(central(bytes) + 24, 32, true);
  await assert.rejects(() => extractDocument(file('bomb.docx', bytes)), /실제 ZIP 압축 해제 크기/);
});

test('ZIP entry count limit is enforced', async () => {
  const bytes = base();
  const v = view(bytes);
  v.setUint16(bytes.length - 14, 1025, true);
  v.setUint16(bytes.length - 12, 1025, true);
  await assert.rejects(() => extractDocument(file('count.docx', bytes)), /1,024/);
});

test('streaming ZIP data descriptors are validated and supported', async () => {
  const pieces = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    pieces.push(chunk);
  });
  const entry = new ZipDeflate('word/document.xml');
  zip.add(entry);
  entry.push(strToU8(word(paragraph('descriptor test'))), true);
  zip.end();
  const bytes = new Uint8Array(pieces.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const piece of pieces) { bytes.set(piece, at); at += piece.length; }
  const result = await extractDocument(file('descriptor.docx', bytes));
  assert.equal(result.blocks[0].text, 'descriptor test');
  const v = view(bytes);
  const start = 30 + v.getUint16(26, true) + v.getUint16(28, true);
  const descriptor = start + v.getUint32(central(bytes) + 20, true);
  v.setUint32(descriptor + 4, 0, true);
  await assert.rejects(() => extractDocument(file('bad-descriptor.docx', bytes)), /설명자/);
});

test('duplicate ZIP paths are rejected without object-key ambiguity', async () => {
  const bytes = archive({ 'word/document.xml': word(paragraph('safe')), 'word/documenx.xml': 'duplicate' });
  const from = strToU8('word/documenx.xml');
  const to = strToU8('word/document.xml');
  for (let at = 0; at <= bytes.length - from.length; at++) {
    if (from.every((byte, index) => bytes[at + index] === byte)) bytes.set(to, at);
  }
  await assert.rejects(() => extractDocument(file('duplicate.docx', bytes)), /중복/);
});

test('bad CRC is rejected even when local and central headers agree', async () => {
  const bytes = base();
  const v = view(bytes);
  v.setUint32(14, 0, true);
  v.setUint32(central(bytes) + 16, 0, true);
  await assert.rejects(() => extractDocument(file('badcrc.docx', bytes)), /체크섬/);
});

test('ZIP path traversal, encryption, symlinks and ZIP64 are rejected', async () => {
  await assert.rejects(() => extractDocument(file('paths.docx', archive({
    '../escape': 'bad', 'word/document.xml': word(paragraph('safe')),
  }))), /내부 경로/);
  for (const [name, mutate, expected] of [
    ['encrypted', (b) => view(b).setUint16(central(b) + 8, 1, true), /암호화/],
    ['symlink', (b) => view(b).setUint32(central(b) + 38, (0xa1ff << 16) >>> 0, true), /심볼릭/],
    ['zip64', (b) => view(b).setUint32(central(b) + 24, 0xffffffff, true), /ZIP64/],
  ]) {
    const bytes = base(); mutate(bytes);
    await assert.rejects(() => extractDocument(file(`${name}.docx`, bytes)), expected);
  }
});

test('central/local mismatches and overlapping ranges are rejected', async () => {
  const bytes = base();
  view(bytes).setUint16(8, 0, true);
  await assert.rejects(() => extractDocument(file('mismatch.docx', bytes)), /헤더.*일치/);
  const overlap = archive({ 'word/document.xml': word(paragraph('safe')), 'word/secondxx.xml': 'more' });
  const v = view(overlap);
  const firstCentral = central(overlap);
  const secondCentral = firstCentral + 46 + v.getUint16(firstCentral + 28, true)
    + v.getUint16(firstCentral + 30, true) + v.getUint16(firstCentral + 32, true);
  v.setUint32(secondCentral + 42, 0, true);
  await assert.rejects(() => extractDocument(file('overlap.docx', overlap)), /일치|겹쳐/);
});

test('DOCTYPE and entities are rejected, including UTF-16 declarations', async () => {
  const dangerous = '<!DOCTYPE w:document [<!ENTITY x SYSTEM "https://example.invalid/secret">]>'
    + word(paragraph('&x;'));
  await assert.rejects(() => extractDocument(docx(dangerous)), /DOCTYPE/);
  const utf16 = Buffer.from('\ufeff' + dangerous, 'utf16le');
  await assert.rejects(() => extractDocument(file('utf16.docx', archive({ 'word/document.xml': utf16 }))), /DOCTYPE/);
});

test('XML maximum depth and malformed nesting are rejected before DOM use', async () => {
  await assert.rejects(() => extractDocument(docx(word('<w:sdt>'.repeat(100) + paragraph('x') + '</w:sdt>'.repeat(100)))), /깊이/);
  await assert.rejects(() => extractDocument(docx(word('<w:p><w:r><w:t>broken</w:p>'))), /XML/);
});

test('XML element count prevents oversized DOM construction', async () => {
  await assert.rejects(() => extractDocument(docx(word('<w:r/>'.repeat(150001)))), /요소 수/);
});

test('UTF-16 DOCX text and normal line breaks are supported', async () => {
  const xml = word('<w:p><w:r><w:t>한글</w:t><w:tab/><w:t>값</w:t><w:br/><w:t>다음</w:t></w:r></w:p>');
  const result = await extractDocument(file('utf16.docx', archive({ 'word/document.xml': Buffer.from('\ufeff' + xml, 'utf16le') })));
  assert.equal(result.blocks[0].text, '한글\t값\n다음');
});

test('hidden direction/control characters are rejected in XML and extracted entity text', async () => {
  await assert.rejects(() => extractDocument(docx(word(paragraph('x\u202ey')))), /제어 문자/);
  await assert.rejects(() => extractDocument(docx(word(paragraph('x&#x85;y')))), /제어 문자/);
});

test('external slide references are rejected without fetching', async () => {
  const source = await fixture('synthetic-slide-order.pptx');
  const entries = unzipSync(new Uint8Array(await source.arrayBuffer()));
  entries['ppt/_rels/presentation.xml.rels'] = strToU8(new TextDecoder().decode(entries['ppt/_rels/presentation.xml.rels'])
    .replace('Target="slides/slide2.xml"', 'TargetMode="External" Target="https://example.invalid/slide.xml"'));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
  try {
    await assert.rejects(() => extractDocument(file('external.pptx', zipSync(entries))), /외부 링크/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('image-only DOCX has zero invented blocks and explicit warnings', async () => {
  const result = await extractDocument(docx(word('<w:p><w:r><w:drawing/></w:r></w:p>')));
  assert.deepEqual(result.blocks, []);
  assert.match(result.warnings.join(' '), /이미지.*OCR/);
  assert.match(result.warnings.join(' '), /텍스트가 없습니다/);
});

test('deleted Word revision text and textbox text are not silently treated as body text', async () => {
  const xml = word('<w:p><w:del><w:r><w:t>deleted</w:t></w:r></w:del><w:r><w:t>kept</w:t>'
    + '<w:drawing><w:txbxContent><w:p><w:r><w:t>textbox</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>');
  const result = await extractDocument(docx(xml));
  assert.equal(result.blocks[0].text, 'kept');
});

test('all four fixture formats extract without a fetch request', async () => {
  const files = await Promise.all([
    'synthetic-body-table.docx', 'synthetic-sections-table.hwpx',
    'synthetic-slide-order.pptx', 'synthetic-text-and-scan.pdf',
  ].map(fixture));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
  try {
    for (const source of files) assert.ok((await extractDocument(source)).blocks.length);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
