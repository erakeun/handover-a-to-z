// Entirely synthetic fixtures. Never contains real handover or personal data.
// Reproduce: node fixtures/import/generate.mjs
import { writeFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';

const out = new URL('./', import.meta.url);
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const enc = (entries) => Object.fromEntries(Object.entries(entries).map(([name, text]) =>
  [name, typeof text === 'string' ? strToU8(text) : text]));
const zip = async (name, entries) => writeFile(new URL(name, out), zipSync(enc(entries), {
  level: 6, mtime: new Date('2026-01-01T00:00:00Z'),
}));
const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rels = (body) => xml(`<Relationships xmlns="${relNS}">${body}</Relationships>`);
const ctNS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const wNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const aNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const pNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const rNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
await zip('synthetic-body-table.docx', {
  '[Content_Types].xml': xml(`<Types xmlns="${ctNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
  '_rels/.rels': rels(`<Relationship Id="rId1" Type="${rNS}/officeDocument" Target="word/document.xml"/>`),
  'word/document.xml': xml(`<w:document xmlns:w="${wNS}"><w:body>${p('합성 테스트: 월간 점검')}${p('&lt;img src=x onerror=alert(1)&gt; 는 글자입니다.')}<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr>${cell('업무')}${cell('담당')}</w:tr><w:tr>${cell('재고 확인')}${cell('가상 담당자')}</w:tr></w:tbl>${p('끝 문단')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`),
});

const hpNS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
const hp = (text) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`;
const hcell = (text, column) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${hp(text)}</hp:subList><hp:cellAddr colAddr="${column}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="2000"/></hp:tc>`;
const section = (body) => xml(`<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="${hpNS}">${body}</hs:sec>`);
await zip('synthetic-sections-table.hwpx', {
  mimetype: [strToU8('application/hwp+zip'), { level: 0 }],
  'version.xml': xml('<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" targetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.3" application="Synthetic test fixture" appVersion="1.0"/>'),
  'META-INF/container.xml': xml('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>'),
  'Contents/content.hpf': xml('<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version="" unique-identifier="" id=""><opf:metadata/><opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section1" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'),
  'Contents/section0.xml': section(hp('합성 테스트: 두 번째 구역')),
  'Contents/section1.xml': section(hp('합성 테스트: 첫 번째 구역') + `<hp:p id="1" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="2" cellSpacing="0" borderFillIDRef="0" noAdjust="0"><hp:tr>${hcell('점검', 0)}${hcell('매주', 1)}</hp:tr></hp:tbl></hp:run></hp:p>`),
});

const slide = (text) => xml(`<p:sld xmlns:p="${pNS}" xmlns:a="${aNS}" xmlns:r="${rNS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Synthetic text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
await zip('synthetic-slide-order.pptx', {
  '[Content_Types].xml': xml(`<Types xmlns="${ctNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`),
  '_rels/.rels': rels(`<Relationship Id="rId1" Type="${rNS}/officeDocument" Target="ppt/presentation.xml"/>`),
  'ppt/presentation.xml': xml(`<p:presentation xmlns:p="${pNS}" xmlns:r="${rNS}"><p:sldIdLst><p:sldId id="257" r:id="rSecond"/><p:sldId id="256" r:id="rFirst"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
  'ppt/_rels/presentation.xml.rels': rels(`<Relationship Id="rFirst" Type="${rNS}/slide" Target="slides/slide1.xml"/><Relationship Id="rSecond" Type="${rNS}/slide" Target="slides/slide2.xml"/>`),
  'ppt/slides/slide1.xml': slide('합성 테스트: 마지막 슬라이드'),
  'ppt/slides/slide2.xml': slide('합성 테스트: 첫 슬라이드'),
});

// Real PDF syntax with xref offsets: page 1 text, page 2 image-only (one pixel).
const content1 = 'BT /F1 12 Tf 72 720 Td (SYNTHETIC TEST: monthly handover) Tj 0 -20 Td (Check records, then confirm.) Tj ET';
const content2 = 'q 100 0 0 100 72 620 cm /Im0 Do Q';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
  `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream',
];
let pdf = '%PDF-1.4\n% Synthetic fixture\n';
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(new URL('synthetic-text-and-scan.pdf', out), pdf);
await writeFile(new URL('synthetic-malformed.docx', out), Buffer.from('PK\x03\x04truncated synthetic ZIP'));
await writeFile(new URL('synthetic-legacy.hwp', out), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
console.log('Wrote six synthetic importer fixtures.');
