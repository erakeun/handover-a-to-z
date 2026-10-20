import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument } from '../src/importers.js';

// Generated in memory: one synthetic image and a text footer, never real files.
function syntheticPdf(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const contents = `q 180 0 0 180 60 300 cm /Im0 Do Q\nBT /F1 12 Tf 70 40 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n245e91>\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const bytes = Buffer.from(pdf);
  return {
    name: 'synthetic-image-and-page-number.pdf',
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('image page with a page-number text layer retains text and warns that body may be missing', async () => {
  const result = await extractDocument(syntheticPdf('- 24 -'));
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].text, '- 24 -');
  assert.match(result.blocks[0].source, /1쪽/);
  assert.match(result.warnings.join('\n'), /PDF 1쪽은 쪽번호.*본문이 빠졌을 수/);
  assert.match(result.warnings.join('\n'), /사진은 자동 첨부하지 않으며 OCR은 실행하지 않습니다/);
});

test('English page footer is also flagged without claiming image contents were inspected', async () => {
  const result = await extractDocument(syntheticPdf('Page 2 / 6'));
  assert.match(result.warnings.join('\n'), /쪽번호로 보이는/);
  assert.equal(result.blocks[0].text, 'Page 2 / 6');
});

test('body text near an image is retained with the general image-omission notice', async () => {
  const result = await extractDocument(syntheticPdf('Step 24: Confirm the preview.'));
  assert.equal(result.blocks[0].text, 'Step 24: Confirm the preview.');
  assert.doesNotMatch(result.warnings.join('\n'), /쪽번호로 보이는/);
  assert.match(result.warnings.join('\n'), /사진·화면 캡처/);
  assert.match(result.warnings.join('\n'), /사진은 업무에 자동으로 연결되지 않습니다/);
  assert.ok(result.blocks.every(block => !Object.hasOwn(block, 'images')));
});
