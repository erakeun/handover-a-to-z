import { Inflate } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

export const supportedFormats = Object.freeze(['docx', 'pptx', 'hwpx', 'pdf']);

const MiB = 1024 * 1024;
const LIMITS = Object.freeze({
  upload: 20 * MiB,
  expanded: 30 * MiB,
  xml: 8 * MiB,
  entries: 1024,
  elements: 150000,
  depth: 96,
  blocks: 10000,
  pages: 500,
});
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const WORD = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const DRAWING = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const HWP = new Set(['http://www.hancom.co.kr/hwpml/2011/paragraph']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const EXCLUDED_CONTENT = new Set([
  'drawing', 'pict', 'object', 'del', 'pic', 'shape', 'textart', 'textBox', 'txbxContent',
  'header', 'footer', 'footNote', 'endNote', 'rect', 'ellipse', 'arc', 'polygon',
  'curve', 'line', 'connectLine', 'container', 'ole', 'video', 'chart', 'eqEdit',
]);
const excludedContent = (node) => EXCLUDED_CONTENT.has(node.localName);

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function warn(state, message) {
  state.warnings.add(message);
}

function addBlock(state, text, source, kind) {
  text = text.replace(/\r\n?/g, '\n').trim();
  check(!CONTROL.test(text), '문서에 허용하지 않는 제어 문자가 있습니다.');
  if (!text) return;
  state.textBytes += encoder.encode(text).length;
  check(state.textBytes <= LIMITS.expanded, '추출 텍스트가 30 MiB 제한을 넘었습니다.');
  check(state.blocks.length < LIMITS.blocks, '문단 수가 안전 제한(10,000개)을 넘었습니다.');
  state.blocks.push({ id: `import-${state.format}-${state.blocks.length + 1}`, text, source, kind });
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inspect the entire central directory before inflating anything. We intentionally
 * support ordinary non-encrypted ZIP only. No files are written to disk.
 * Do not replace the bounded Inflate loop with unzipSync: central sizes can lie.
 */
function inspectZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bound = (start, length, end = bytes.length) =>
    check(Number.isSafeInteger(start + length) && start >= 0 && start + length <= end,
      'ZIP 구조가 잘렸거나 잘못된 위치를 가리킵니다.');
  const u16 = (at) => { bound(at, 2); return view.getUint16(at, true); };
  const u32 = (at) => { bound(at, 4); return view.getUint32(at, true); };
  check(bytes.length >= 22 && u32(0) === 0x04034b50, '정상적인 문서 ZIP 파일이 아닙니다.');
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) {
      eocd = at;
      break;
    }
  }
  check(eocd >= 0, 'ZIP 중앙 디렉터리를 찾을 수 없습니다.');
  check(u16(eocd + 4) === 0 && u16(eocd + 6) === 0, '분할 ZIP 문서는 지원하지 않습니다.');
  const count = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralStart = u32(eocd + 16);
  check(count !== 65535 && centralSize !== 0xffffffff && centralStart !== 0xffffffff,
    'ZIP64 문서는 지원하지 않습니다.');
  check(count === u16(eocd + 8) && count > 0 && count <= LIMITS.entries,
    'ZIP 항목 수가 안전 제한(1,024개)을 넘었거나 올바르지 않습니다.');
  check(centralStart + centralSize === eocd, 'ZIP 중앙 디렉터리 크기가 일치하지 않습니다.');
  bound(centralStart, centralSize, eocd);
  const entries = new Map();
  const spans = [];
  let declaredTotal = 0;
  let cursor = centralStart;

  function extraFields(start, length, end) {
    bound(start, length, end);
    for (let at = start; at < start + length;) {
      bound(at, 4, start + length);
      const tag = u16(at);
      const size = u16(at + 2);
      check(tag !== 1, 'ZIP64 문서는 지원하지 않습니다.');
      bound(at + 4, size, start + length);
      at += 4 + size;
    }
  }
  function zipName(start, size) {
    bound(start, size);
    let name;
    try { name = decoder.decode(bytes.subarray(start, start + size)); }
    catch { fail('ZIP 파일 이름의 문자 인코딩을 읽을 수 없습니다.'); }
    check(name.length > 0 && name.length <= 1024 && !CONTROL.test(name)
      && !/[\t\n\r\\]/u.test(name) && !name.startsWith('/') && !name.includes(':')
      && !name.split('/').some((part, i, all) => part === '..' || part === '.'
        || (!part && i !== all.length - 1)), 'ZIP 내부 경로가 올바르지 않습니다.');
    return name;
  }
  for (let i = 0; i < count; i++) {
    bound(cursor, 46, eocd);
    check(u32(cursor) === 0x02014b50, 'ZIP 항목 헤더가 올바르지 않습니다.');
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const compressed = u32(cursor + 20);
    const expanded = u32(cursor + 24);
    const nameSize = u16(cursor + 28);
    const extraSize = u16(cursor + 30);
    const commentSize = u16(cursor + 32);
    const local = u32(cursor + 42);
    check((flags & ~0x080e) === 0, '암호화되었거나 지원하지 않는 ZIP 문서입니다.');
    check(method === 0 || method === 8, '지원하지 않는 ZIP 압축 방식입니다.');
    check(compressed !== 0xffffffff && expanded !== 0xffffffff && local !== 0xffffffff,
      'ZIP64 문서는 지원하지 않습니다.');
    check(u16(cursor + 34) === 0, '분할 ZIP 문서는 지원하지 않습니다.');
    check(((u32(cursor + 38) >>> 16) & 0xf000) !== 0xa000, 'ZIP 심볼릭 링크는 허용하지 않습니다.');
    bound(cursor + 46, nameSize + extraSize + commentSize, eocd);
    const name = zipName(cursor + 46, nameSize);
    check(!entries.has(name), '중복된 ZIP 내부 경로가 있습니다.');
    check(!name.endsWith('/') || (compressed === 0 && expanded === 0),
      'ZIP 디렉터리 항목의 크기가 올바르지 않습니다.');
    extraFields(cursor + 46 + nameSize, extraSize, eocd);
    declaredTotal += expanded;
    check(declaredTotal <= LIMITS.expanded, 'ZIP 압축 해제 크기가 30 MiB 제한을 넘습니다.');
    check(method !== 0 || compressed === expanded, 'ZIP 저장 항목의 크기가 일치하지 않습니다.');
    bound(local, 30, centralStart);
    check(u32(local) === 0x04034b50 && u16(local + 6) === flags && u16(local + 8) === method,
      'ZIP 로컬 헤더와 중앙 디렉터리가 일치하지 않습니다.');
    const localNameSize = u16(local + 26);
    const localExtraSize = u16(local + 28);
    bound(local + 30, localNameSize + localExtraSize, centralStart);
    check(zipName(local + 30, localNameSize) === name, 'ZIP 내부 파일 이름이 일치하지 않습니다.');
    extraFields(local + 30 + localNameSize, localExtraSize, centralStart);
    for (const [offset, value] of [[14, crc], [18, compressed], [22, expanded]]) {
      const actual = u32(local + offset);
      check(actual === value || ((flags & 8) && actual === 0),
        'ZIP 로컬 크기 또는 체크섬이 일치하지 않습니다.');
    }
    const dataStart = local + 30 + localNameSize + localExtraSize;
    bound(dataStart, compressed, centralStart);
    let end = dataStart + compressed;
    if (flags & 8) {
      if (u32(end) === 0x08074b50) end += 4;
      bound(end, 12, centralStart);
      check(u32(end) === crc && u32(end + 4) === compressed && u32(end + 8) === expanded,
        'ZIP 데이터 설명자가 일치하지 않습니다.');
      end += 12;
    }
    entries.set(name, { name, method, crc, compressed, expanded, dataStart });
    spans.push([local, end]);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  check(cursor === eocd, 'ZIP 항목 수와 중앙 디렉터리가 일치하지 않습니다.');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    check(spans[i - 1][1] <= spans[i][0], 'ZIP 내부 항목이 겹쳐 있습니다.');
  }
  let actualTotal = 0;
  const cache = new Map();
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      if (cache.has(name)) return cache.get(name);
      const entry = entries.get(name);
      check(entry, `문서에 필요한 파일이 없습니다: ${name}`);
      check(entry.expanded <= LIMITS.xml, 'XML 항목이 안전 제한(8 MiB)을 넘었습니다.');
      const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
      let result;
      if (entry.method === 0) {
        result = compressed;
        actualTotal += result.length;
      } else {
        const parts = [];
        let length = 0;
        const inflater = new Inflate((chunk) => {
          length += chunk.length;
          actualTotal += chunk.length;
          check(length <= entry.expanded && actualTotal <= LIMITS.expanded,
            '실제 ZIP 압축 해제 크기가 선언된 크기 또는 30 MiB 제한을 넘습니다.');
          parts.push(chunk);
        });
        try {
          if (!compressed.length) inflater.push(compressed, true);
          for (let at = 0; at < compressed.length; at += 512) {
            inflater.push(compressed.subarray(at, Math.min(at + 512, compressed.length)),
              at + 512 >= compressed.length);
          }
        } catch (error) {
          fail(`ZIP 압축 데이터를 안전하게 읽을 수 없습니다: ${error.message}`);
        }
        result = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
      }
      check(actualTotal <= LIMITS.expanded && result.length === entry.expanded,
        '실제 ZIP 압축 해제 크기가 일치하지 않습니다.');
      check(crc32(result) === entry.crc, 'ZIP 체크섬이 일치하지 않아 손상된 파일로 판단했습니다.');
      cache.set(name, result);
      return result;
    },
  };
}

function decodeXML(bytes) {
  try {
    let text;
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    } else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    } else {
      text = decoder.decode(bytes);
    }
    check(!CONTROL.test(text), 'XML에 허용하지 않는 제어 문자가 있습니다.');
    check(!/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text), 'DOCTYPE·ENTITY가 있는 XML은 허용하지 않습니다.');
    return text;
  } catch (error) {
    if (error instanceof TypeError) fail('XML 문자 인코딩을 읽을 수 없습니다.');
    throw error;
  }
}

// Bound nesting/node count before constructing a DOM. Quoted attributes, comments,
// CDATA and processing instructions do not contribute to the element count.
function inspectXML(text, state) {
  let depth = 0;
  let at = 0;
  while ((at = text.indexOf('<', at)) !== -1) {
    const special = text.startsWith('<!--', at) ? ['-->', 4]
      : text.startsWith('<![CDATA[', at) ? [']]>', 9]
        : text.startsWith('<?', at) ? ['?>', 2] : null;
    if (special) {
      const end = text.indexOf(special[0], at + special[1]);
      check(end >= 0, 'XML 주석 또는 특수 구문이 닫히지 않았습니다.');
      at = end + special[0].length;
      continue;
    }
    let end = at + 1;
    let quote = '';
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else check(c !== '<', 'XML 태그 구문이 올바르지 않습니다.');
    }
    check(end < text.length, 'XML 태그가 닫히지 않았습니다.');
    if (text[at + 1] === '/') depth--;
    else {
      state.xmlElements++;
      check(state.xmlElements <= LIMITS.elements, 'XML 요소 수가 안전 제한을 넘었습니다.');
      if (text[end - 1] !== '/') depth++;
    }
    check(depth >= 0 && depth <= LIMITS.depth, 'XML 중첩 깊이가 안전 제한을 넘었거나 올바르지 않습니다.');
    at = end + 1;
  }
  check(depth === 0, 'XML 요소가 올바르게 닫히지 않았습니다.');
}

function readXML(zip, path, state) {
  const text = decodeXML(zip.read(path));
  inspectXML(text, state);
  try {
    return new DOMParser({
      onError(level, message) { throw new Error(`${level}: ${message}`); },
    }).parseFromString(text, 'application/xml');
  } catch {
    fail(`문서 XML이 손상되었거나 지원하지 않는 구문입니다: ${path}`);
  }
}

function children(node) {
  const result = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child);
  }
  return result;
}
function *walk(node, skip = () => false) {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current.nodeType !== 1 || skip(current)) continue;
    yield current;
    const nodes = children(current);
    for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]);
  }
}
function named(node, name, namespaces) {
  return node.localName === name && (!namespaces || namespaces.has(node.namespaceURI));
}
function descendants(node, name, namespaces) {
  return [...walk(node)].filter((n) => named(n, name, namespaces));
}
function first(node, name, namespaces) {
  for (const n of walk(node)) if (named(n, name, namespaces)) return n;
  return undefined;
}
function textWithin(node) {
  let result = '';
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType === 3 || n.nodeType === 4) result += n.nodeValue;
    else if (n.nodeType === 1 && ['br', 'lineBreak'].includes(n.localName)) result += '\n';
    else if (n.nodeType === 1 && n.localName === 'tab') result += '\t';
    else {
      for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
    }
  }
  return result;
}
function paragraphText(node, namespaces) {
  let result = '';
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n !== node && (['tbl', 'p'].includes(n.localName) || excludedContent(n))) continue;
    if (named(n, 't', namespaces)) result += textWithin(n);
    else if (namespaces.has(n.namespaceURI) && ['tab'].includes(n.localName)) result += '\t';
    else if (namespaces.has(n.namespaceURI) && ['br', 'cr', 'lineBreak'].includes(n.localName)) result += '\n';
    else {
      const nodes = children(n);
      for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]);
    }
  }
  return result;
}

function tableText(table, namespaces, state) {
  warn(state, '표는 셀을 탭으로 구분한 텍스트로 가져옵니다. 병합 셀·열 너비·복잡한 표 구조는 원본과 대조하세요.');
  const rows = [...walk(table, (n) => excludedContent(n) || (n !== table && named(n, 'tbl', namespaces)))]
    .filter((n) => named(n, 'tr', namespaces));
  const text = rows.map((row) => {
    const cells = [...walk(row, (n) => excludedContent(n) || (n !== row && named(n, 'tbl', namespaces)))]
      .filter((n) => named(n, 'tc', namespaces));
    return cells.map((cell) => {
      const ps = [...walk(cell, (n) => excludedContent(n) || named(n, 'tbl', namespaces))]
        .filter((n) => named(n, 'p', namespaces));
      return ps.map((p) => paragraphText(p, namespaces)).filter(Boolean).join(' / ');
    }).join('\t');
  }).join('\n');
  if ([...walk(table, excludedContent)].filter((n) => named(n, 'tbl', namespaces)).length > 1) {
    warn(state, '표 안의 중첩 표는 읽지 못했습니다. 원본에서 확인해 직접 붙여 넣으세요.');
  }
  if (!text.trim()) warn(state, '텍스트를 읽지 못한 표가 있습니다. 이미지 표 또는 지원하지 않는 구조일 수 있습니다.');
  return text;
}

function extractFlow(root, namespaces, state, source) {
  let paragraph = 0;
  let table = 0;
  const stack = [...children(root)].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (named(node, 'tbl', namespaces)) {
      addBlock(state, tableText(node, namespaces, state), `${source} · 표 ${++table}`, 'table');
    } else if (named(node, 'p', namespaces)) {
      addBlock(state, paragraphText(node, namespaces), `${source} · 문단 ${++paragraph}`, 'paragraph');
      // HWPX tables are commonly inside a paragraph run. Collect top-level tables
      // without collecting their paragraphs for a second time.
      const nested = [...walk(node, excludedContent)].filter((n) => named(n, 'tbl', namespaces));
      for (const candidate of nested) {
        let parent = candidate.parentNode;
        let inTable = false;
        while (parent && parent !== node) {
          if (named(parent, 'tbl', namespaces)) { inTable = true; break; }
          parent = parent.parentNode;
        }
        if (!inTable) addBlock(state, tableText(candidate, namespaces, state), `${source} · 표 ${++table}`, 'table');
      }
    } else if (!excludedContent(node)) {
      const nodes = children(node);
      for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]);
    }
  }
}

function readDocx(zip, state) {
  const path = 'word/document.xml';
  const doc = readXML(zip, path, state);
  check(named(doc.documentElement, 'document', WORD), 'DOCX 본문 XML 형식이 아닙니다.');
  const body = first(doc.documentElement, 'body', WORD);
  check(body, 'DOCX 본문을 찾을 수 없습니다.');
  extractFlow(body, WORD, state, `${state.name} · 본문`);
  warn(state, 'DOCX 본문 문단과 표만 읽었습니다. 머리말·꼬리말·주석·각주·텍스트 상자·페이지 배치는 포함하지 않습니다.');
  if (zip.names.some((name) => name.startsWith('word/media/')) || first(body, 'drawing', WORD) || first(body, 'pict', WORD)) {
    warn(state, 'DOCX의 이미지·도형 속 글자는 읽지 못했습니다. OCR은 실행하지 않습니다.');
  }
}

function resolvePart(base, target) {
  check(typeof target === 'string' && target.length > 0 && target.length <= 2048
    && !/^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith('//')
    && !/[\\?#\u0000-\u0020\u007f]/u.test(target), '문서 내부 참조 경로가 올바르지 않습니다.');
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { fail('문서 참조 경로 인코딩이 올바르지 않습니다.'); }
  check(!/[\\:#?\u0000-\u001f\u007f]/u.test(decoded), '문서 내부 참조 경로가 올바르지 않습니다.');
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      check(parts.length > 0, '문서 내부 참조가 ZIP 바깥을 가리킵니다.');
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function readPptx(zip, state) {
  const path = 'ppt/presentation.xml';
  const doc = readXML(zip, path, state);
  check(doc.documentElement.localName === 'presentation', 'PPTX 프레젠테이션 XML 형식이 아닙니다.');
  const rels = readXML(zip, 'ppt/_rels/presentation.xml.rels', state);
  const relationships = new Map();
  for (const rel of descendants(rels.documentElement, 'Relationship')) {
    const id = rel.getAttribute('Id');
    check(id && !relationships.has(id), 'PPTX 관계 ID가 없거나 중복되었습니다.');
    relationships.set(id, rel);
  }
  const list = first(doc.documentElement, 'sldIdLst');
  check(list, 'PPTX 슬라이드 순서를 찾을 수 없습니다.');
  const ids = children(list).filter((node) => node.localName === 'sldId');
  check(ids.length <= LIMITS.pages, '슬라이드가 안전 제한(500장)을 넘었습니다.');
  for (let i = 0; i < ids.length; i++) {
    const rid = [...Array(ids[i].attributes.length)].map((_, at) => ids[i].attributes[at])
      .find((attribute) => attribute.localName === 'id' && attribute.namespaceURI)?.value;
    const rel = relationships.get(rid);
    check(rel && /\/slide$/u.test(rel.getAttribute('Type')), 'PPTX 슬라이드 관계가 올바르지 않습니다.');
    check(rel.getAttribute('TargetMode') !== 'External', '외부 링크 슬라이드는 가져올 수 없습니다.');
    const slidePath = resolvePart(path, rel.getAttribute('Target'));
    const slide = readXML(zip, slidePath, state);
    check(slide.documentElement.localName === 'sld', 'PPTX 슬라이드 XML 형식이 아닙니다.');
    const tree = first(slide.documentElement, 'spTree');
    check(tree, 'PPTX 슬라이드의 도형 트리를 찾을 수 없습니다.');
    const texts = [];
    const stack = [tree];
    while (stack.length) {
      const node = stack.pop();
      if (named(node, 'tbl', DRAWING)) texts.push(tableText(node, DRAWING, state));
      else if (named(node, 'p', DRAWING)) texts.push(paragraphText(node, DRAWING));
      else {
        const nodes = children(node);
        for (let at = nodes.length - 1; at >= 0; at--) stack.push(nodes[at]);
      }
    }
    const source = `${state.name} · 슬라이드 ${i + 1} (${slidePath})`;
    const text = texts.filter((value) => value.trim()).join('\n');
    if (!text.trim()) warn(state, `슬라이드 ${i + 1}에서 텍스트를 읽지 못했습니다. 이미지·차트·빈 슬라이드는 원본에서 확인하세요.`);
    addBlock(state, text, source, 'slide');
    if (slide.documentElement.getAttribute('show') === '0') warn(state, '숨겨진 슬라이드의 텍스트도 포함했습니다.');
  }
  warn(state, 'PPTX는 프레젠테이션의 슬라이드 순서로 읽습니다. 슬라이드 안은 XML 도형 순서이며, 시각적 배치·발표자 노트·마스터·차트·SmartArt·이미지 글자는 재현하지 않습니다.');
}

function readHwpx(zip, state) {
  let sections = [];
  if (zip.has('Contents/content.hpf')) {
    const packagePath = 'Contents/content.hpf';
    const doc = readXML(zip, packagePath, state);
    const manifest = new Map();
    for (const item of descendants(doc.documentElement, 'item')) {
      const id = item.getAttribute('id');
      check(id && !manifest.has(id), 'HWPX 항목 ID가 없거나 중복되었습니다.');
      manifest.set(id, item.getAttribute('href'));
    }
    const spine = first(doc.documentElement, 'spine');
    if (spine) {
      sections = descendants(spine, 'itemref').map((item) => {
        const href = manifest.get(item.getAttribute('idref'));
        check(href, 'HWPX 본문 순서의 참조를 찾을 수 없습니다.');
        // HWPX writers use both archive-root and content.hpf-relative hrefs.
        const relative = resolvePart(packagePath, href);
        if (zip.has(relative) || /^(?:\.{1,2})\//u.test(href)) return relative;
        const rooted = resolvePart('', href);
        return zip.has(rooted) ? rooted : relative;
      }).filter((name) => /(?:^|\/)section\d+\.xml$/iu.test(name));
    }
  }
  if (!sections.length) {
    sections = zip.names.filter((name) => /^Contents\/section\d+\.xml$/iu.test(name))
      .sort((a, b) => Number(a.match(/section(\d+)/iu)[1]) - Number(b.match(/section(\d+)/iu)[1]));
    warn(state, 'HWPX 본문 순서 정보를 확인하지 못해 section 번호 순서로 읽었습니다. 원본 순서를 확인하세요.');
  }
  check(sections.length > 0, 'HWPX 본문 section XML을 찾을 수 없습니다.');
  check(sections.length <= LIMITS.pages, 'HWPX 구역 수가 안전 제한(500개)을 넘었습니다.');
  for (let i = 0; i < sections.length; i++) {
    const doc = readXML(zip, sections[i], state);
    check(doc.documentElement.localName === 'sec', 'HWPX 구역 XML 형식이 아닙니다.');
    extractFlow(doc.documentElement, HWP, state, `${state.name} · 구역 ${i + 1} (${sections[i]})`);
  }
  warn(state, 'HWPX는 본문 문단과 표를 가능한 범위에서 읽습니다. 글상자·수식·개체·머리말·꼬리말·이미지 글자·복잡한 배치와 표의 위치는 원본과 대조하세요.');
  if (zip.names.some((name) => /^(?:BinData|Preview)\//iu.test(name))) {
    warn(state, 'HWPX 이미지·미리보기는 텍스트로 변환하지 않았습니다. OCR은 실행하지 않습니다.');
  }
}

async function readPdf(bytes, state) {
  check([0x25, 0x50, 0x44, 0x46, 0x2d].every((value, i) => bytes[i] === value),
    '정상적인 PDF 헤더가 아닙니다.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
  }
  // pdf.js 6 uses this factory for optional CMaps/fonts/WASM. Never fetch assets
  // named by a document. The sole browser worker is packaged beside the app.
  class NoNetworkBinaryData {
    async fetch() { throw new Error('외부 PDF 보조 리소스는 불러오지 않습니다.'); }
  }
  const task = pdfjs.getDocument({
    data: bytes,
    BinaryDataFactory: NoNetworkBinaryData,
    useWorkerFetch: false,
    useWasm: false,
    useSystemFonts: true,
    disableFontFace: true,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 0,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    check(pdf.numPages <= LIMITS.pages, 'PDF 페이지가 안전 제한(500쪽)을 넘었습니다.');
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      const parts = [];
      let pageBytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const piece = item.str + (item.hasEOL ? '\n' : ' ');
            pageBytes += encoder.encode(piece).length;
            check(pageBytes + state.textBytes <= LIMITS.expanded, 'PDF 추출 텍스트가 30 MiB 제한을 넘었습니다.');
            parts.push(piece);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      const text = parts.join('').replace(/[ \t]+\n/gu, '\n').trim();
      if (!text) warn(state, `PDF ${pageNumber}쪽에서 텍스트를 읽지 못했습니다. 스캔·이미지 또는 빈 페이지일 수 있으며 OCR은 실행하지 않습니다.`);
      else if (/^(?:[-–—]\s*)?(?:page\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?(?:\s*[-–—])?$/iu.test(text)) {
        // Some image/table pages still have a text-layer page number. Retain it
        // verbatim, but do not present it as evidence that the body was extracted.
        // This text-only heuristic does not inspect or decode PDF image streams.
        warn(state, `PDF ${pageNumber}쪽은 쪽번호로 보이는 짧은 글만 읽었습니다. 이미지·표 안의 본문이 빠졌을 수 있으므로 원본을 확인하세요. 사진은 자동 첨부하지 않으며 OCR은 실행하지 않습니다.`);
      }
      addBlock(state, text, `${state.name} · ${pageNumber}쪽`, 'page');
    }
    warn(state, 'PDF의 텍스트 레이어만 페이지별로 읽었습니다. 표·다단 편집·읽기 순서·줄바꿈은 원본과 다를 수 있고, 사진·화면 캡처·이미지 안의 글자와 주석은 포함하지 않습니다. 사진은 업무에 자동으로 연결되지 않습니다. 일부 문자·폰트는 누락될 수 있습니다.');
  } catch (error) {
    if (error.name === 'PasswordException') fail('암호가 걸린 PDF는 읽을 수 없습니다. 로컬 프로그램에서 암호를 해제한 사본을 사용하세요.');
    throw new Error(`PDF를 읽지 못했습니다: ${error.message}`);
  } finally {
    await task.destroy();
  }
}

export async function extractDocument(file) {
  check(file && typeof file.name === 'string' && typeof file.arrayBuffer === 'function', '가져올 파일을 선택하세요.');
  check(file.name.length > 0 && file.name.length <= 255 && !CONTROL.test(file.name) && !/[\r\n\t]/u.test(file.name),
    '파일 이름이 올바르지 않습니다.');
  const format = file.name.split('.').pop().toLowerCase();
  if (format === 'hwp') {
    fail('구형 HWP(.hwp)는 직접 읽지 않습니다. 한컴오피스에서 HWPX 또는 DOCX로 저장하거나, 본문을 복사해 텍스트 붙여넣기를 사용하세요. 외부 변환 서버로 전송하지 않습니다.');
  }
  check(supportedFormats.includes(format), 'DOCX, PPTX, HWPX, 텍스트 PDF 파일을 선택하세요.');
  check(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= LIMITS.upload,
    '업로드 파일은 비어 있지 않은 20 MiB 이하 파일이어야 합니다.');
  const buffer = await file.arrayBuffer();
  check(buffer instanceof ArrayBuffer, '파일의 바이트 데이터를 읽을 수 없습니다.');
  check(buffer.byteLength > 0 && buffer.byteLength <= LIMITS.upload, '실제 파일 크기가 20 MiB 제한을 넘었거나 비어 있습니다.');
  check(buffer.byteLength === file.size, '선택한 파일 크기와 실제 읽은 크기가 다릅니다.');
  const bytes = new Uint8Array(buffer);
  const state = {
    name: file.name, format, blocks: [], warnings: new Set(), textBytes: 0, xmlElements: 0,
  };
  if (format === 'pdf') await readPdf(bytes, state);
  else {
    const zip = inspectZip(bytes);
    if (format === 'docx') readDocx(zip, state);
    else if (format === 'pptx') readPptx(zip, state);
    else readHwpx(zip, state);
  }
  if (!state.blocks.length) warn(state, '가져올 수 있는 텍스트가 없습니다. 원본을 확인한 뒤 필요한 내용을 직접 붙여 넣으세요.');
  warn(state, '추출 결과는 초안입니다. 문단을 분리·병합하고 원본과 대조한 뒤 업무에 반영하세요.');
  return { format, blocks: state.blocks, warnings: [...state.warnings] };
}
