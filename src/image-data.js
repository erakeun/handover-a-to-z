import { Inflate } from "fflate";

/** Portable documents store only PNG/JPEG. WebP is accepted at the upload boundary. */
export const IMAGE_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  perTask: 20,
  perDocument: 100,
  maxPixels: 16_000_000,
  maxDimension: 8_192,
  caption: 400,
});

const IMAGE_KEYS = ["id", "section", "caption", "mime", "width", "height", "data"];
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BAD_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const BAD_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const u16be = (bytes, at) => bytes[at] * 256 + bytes[at + 1];
const u32be = (bytes, at) => (bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
const u24le = (bytes, at) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
const u32le = (bytes, at) => (u24le(bytes, at) + bytes[at + 3] * 0x1000000) >>> 0;
const tag = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));

function dimensions(width, height) {
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= IMAGE_LIMITS.maxDimension && height <= IMAGE_LIMITS.maxDimension
    && width * height <= IMAGE_LIMITS.maxPixels,
  "이미지 크기는 한 변 8,192px, 전체 16,000,000픽셀 이내여야 합니다.");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let at = start; at < end; at++) crc = CRC_TABLE[(crc ^ bytes[at]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPNG(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  check(signature.every((value, index) => bytes[index] === value), "PNG 서명이 올바르지 않습니다.");
  let cursor = 8;
  let width, height, depth, color, interlace;
  let header = false, palette = false, transparency = false, dataEnded = false, ended = false;
  let chunks = 0, dataBytes = 0;
  const compressed = [];
  while (cursor < bytes.length) {
    check(++chunks <= 10_000 && cursor + 12 <= bytes.length, "PNG 청크가 잘렸거나 개수 제한을 초과했습니다.");
    const length = u32be(bytes, cursor);
    const end = cursor + 12 + length;
    check(end <= bytes.length, "PNG 청크가 잘렸습니다.");
    const type = tag(bytes, cursor + 4);
    check(/^[A-Za-z]{4}$/.test(type) && !(bytes[cursor + 6] & 32), "PNG 청크 이름이 올바르지 않습니다.");
    check(crc32(bytes, cursor + 4, end - 4) === u32be(bytes, end - 4), "PNG CRC 체크섬이 일치하지 않습니다.");
    check(header || type === "IHDR", "PNG 첫 청크는 IHDR이어야 합니다.");
    check(!["acTL", "fcTL", "fdAT"].includes(type), "움직이는 PNG(APNG)는 지원하지 않습니다.");
    const at = cursor + 8;
    if (type === "IHDR") {
      check(!header && length === 13, "PNG IHDR 헤더가 올바르지 않습니다.");
      width = u32be(bytes, at); height = u32be(bytes, at + 4);
      dimensions(width, height);
      depth = bytes[at + 8]; color = bytes[at + 9]; interlace = bytes[at + 12];
      check(({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[color]?.includes(depth)
        && bytes[at + 10] === 0 && bytes[at + 11] === 0 && interlace <= 1, "PNG 색상·압축 헤더가 올바르지 않습니다.");
      header = true;
    } else if (type === "PLTE") {
      check(!palette && !compressed.length && color !== 0 && color !== 4 && length > 0 && length % 3 === 0
        && length <= 768 && (color !== 3 || length / 3 <= 2 ** depth), "PNG 팔레트가 올바르지 않습니다.");
      palette = length / 3;
    } else if (type === "tRNS") {
      check(!transparency && !compressed.length
        && ((color === 0 && length === 2) || (color === 2 && length === 6)
          || (color === 3 && palette && length > 0 && length <= palette)), "PNG 투명도 청크가 올바르지 않습니다.");
      transparency = true;
    } else if (type === "IDAT") {
      check(!dataEnded && (color !== 3 || palette), "PNG 이미지 데이터의 순서 또는 팔레트가 올바르지 않습니다.");
      compressed.push(bytes.subarray(at, at + length));
      dataBytes += length;
    } else if (type === "IEND") {
      check(length === 0 && dataBytes > 0 && end === bytes.length, "PNG IEND가 없거나 뒤에 추가 데이터가 있습니다.");
      ended = true;
      cursor = end;
      break;
    } else {
      check((bytes[cursor + 4] & 32) !== 0, "지원하지 않는 PNG 필수 청크가 있습니다.");
    }
    if (compressed.length && type !== "IDAT") dataEnded = true;
    cursor = end;
  }
  check(header && ended && cursor === bytes.length, "PNG 이미지가 잘렸거나 IEND가 없습니다.");
  const zlib = new Uint8Array(dataBytes);
  let offset = 0;
  for (const part of compressed) { zlib.set(part, offset); offset += part.length; }
  check(zlib.length >= 6 && (zlib[0] & 15) === 8 && (zlib[0] >>> 4) <= 7
    && (zlib[1] & 32) === 0 && (zlib[0] * 256 + zlib[1]) % 31 === 0, "PNG zlib 헤더가 올바르지 않습니다.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rowLengths = [];
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (columns) for (let row = 0; row < rows; row++) rowLengths.push(1 + Math.ceil(columns * channels * depth / 8));
  }
  const expected = rowLengths.reduce((total, length) => total + length, 0);
  let actual = 0, row = 0, inRow = 0, adlerA = 1, adlerB = 0;
  const inflater = new Inflate((chunk) => {
    check(actual + chunk.length <= expected, "PNG 압축 해제 크기가 선언된 픽셀 크기를 초과했습니다.");
    for (const byte of chunk) {
      if (inRow === 0) check(byte <= 4, "PNG 스캔라인 필터가 올바르지 않습니다.");
      if (++inRow === rowLengths[row]) { inRow = 0; row++; }
      adlerA = (adlerA + byte) % 65521;
      adlerB = (adlerB + adlerA) % 65521;
    }
    actual += chunk.length;
  });
  const deflate = zlib.subarray(2, -4);
  try {
    for (let at = 0; at < deflate.length; at += 512) inflater.push(deflate.subarray(at, at + 512), at + 512 >= deflate.length);
    check(deflate.length > 0 && actual === expected && row === rowLengths.length && inRow === 0,
      "PNG 스캔라인 데이터가 잘렸거나 크기가 일치하지 않습니다.");
    check(((adlerB * 65536 + adlerA) >>> 0) === u32be(zlib, zlib.length - 4), "PNG Adler 체크섬이 일치하지 않습니다.");
  } catch (error) {
    throw new Error(`PNG 압축 데이터가 손상되었습니다: ${error.message}`);
  }
  return { mime: "image/png", width, height };
}

function inspectJPEG(bytes) {
  check(bytes[0] === 255 && bytes[1] === 216, "JPEG 서명이 올바르지 않습니다.");
  let cursor = 2, width, height, frame, scanCount = 0, markers = 0;
  const components = new Map(), scanned = new Set(), quantization = new Set(), huffman = new Set();
  while (cursor < bytes.length) {
    check(++markers <= 10_000 && bytes[cursor++] === 255, "JPEG 마커가 올바르지 않습니다.");
    while (bytes[cursor] === 255) cursor++;
    check(cursor < bytes.length, "JPEG 마커가 잘렸습니다.");
    const marker = bytes[cursor++];
    if (marker === 217) {
      check(frame && scanCount && scanned.size === components.size && cursor === bytes.length,
        "JPEG 이미지 데이터가 없거나 EOI 뒤에 추가 데이터가 있습니다.");
      return { mime: "image/jpeg", width, height };
    }
    check(marker !== 0 && marker !== 216 && !(marker >= 208 && marker <= 215), "JPEG 마커 순서가 올바르지 않습니다.");
    check(cursor + 2 <= bytes.length, "JPEG 세그먼트가 잘렸습니다.");
    const length = u16be(bytes, cursor), end = cursor + length, start = cursor + 2;
    check(length >= 2 && end <= bytes.length, "JPEG 세그먼트 길이가 올바르지 않습니다.");
    if ([192, 193, 194].includes(marker)) {
      check(!frame && length >= 11 && bytes[start] === 8, "JPEG 프레임 헤더가 올바르지 않습니다.");
      height = u16be(bytes, start + 1); width = u16be(bytes, start + 3);
      dimensions(width, height);
      const count = bytes[start + 5];
      check([1, 3, 4].includes(count) && length === 8 + 3 * count, "JPEG 색상 요소가 올바르지 않습니다.");
      for (let at = start + 6; at < end; at += 3) {
        const sampling = bytes[at + 1];
        check(!components.has(bytes[at]) && (sampling >> 4) >= 1 && (sampling >> 4) <= 4
          && (sampling & 15) >= 1 && (sampling & 15) <= 4 && bytes[at + 2] <= 3, "JPEG 색상 샘플링이 올바르지 않습니다.");
        components.set(bytes[at], bytes[at + 2]);
      }
      frame = marker;
    } else if (marker === 219) {
      let at = start;
      while (at < end) {
        const info = bytes[at++], precision = info >> 4, number = info & 15;
        check(precision <= 1 && number <= 3 && at + 64 * (precision + 1) <= end, "JPEG 양자화 테이블이 잘렸습니다.");
        for (let index = 0; index < 64; index++, at += precision + 1) {
          check((precision ? u16be(bytes, at) : bytes[at]) > 0, "JPEG 양자화 테이블이 올바르지 않습니다.");
        }
        quantization.add(number);
      }
      check(at === end && at > start, "JPEG 양자화 테이블이 올바르지 않습니다.");
    } else if (marker === 196) {
      let at = start;
      while (at < end) {
        const info = bytes[at++];
        check((info >> 4) <= 1 && (info & 15) <= 3 && at + 16 <= end, "JPEG Huffman 테이블이 올바르지 않습니다.");
        let count = 0, slots = 1;
        for (let index = 0; index < 16; index++) {
          const codes = bytes[at++];
          count += codes; slots = 2 * slots - codes;
          check(slots >= 0, "JPEG Huffman 코드 길이가 올바르지 않습니다.");
        }
        check(count > 0 && count <= 256 && at + count <= end, "JPEG Huffman 테이블이 잘렸습니다.");
        at += count; huffman.add(info);
      }
      check(at === end && at > start, "JPEG Huffman 테이블이 올바르지 않습니다.");
    } else if (marker === 218) {
      const count = bytes[start];
      check(frame && count > 0 && count <= components.size && length === 6 + 2 * count, "JPEG 스캔 헤더가 올바르지 않습니다.");
      const spectralStart = bytes[end - 3], spectralEnd = bytes[end - 2], approximation = bytes[end - 1];
      check(frame === 194
        ? spectralStart <= spectralEnd && spectralEnd <= 63 && (spectralStart !== 0 || spectralEnd === 0)
          && (count === 1 || spectralStart === 0) && (approximation >> 4) <= 13 && (approximation & 15) <= 13
          && ((approximation >> 4) === 0 || (approximation >> 4) === (approximation & 15) + 1)
        : spectralStart === 0 && spectralEnd === 63 && approximation === 0, "JPEG 스캔 설정이 올바르지 않습니다.");
      const seen = new Set();
      for (let at = start + 1; at < end - 3; at += 2) {
        const component = bytes[at], tables = bytes[at + 1];
        check(components.has(component) && !seen.has(component) && (tables >> 4) <= 3 && (tables & 15) <= 3
          && quantization.has(components.get(component)), "JPEG 스캔 색상·양자화 테이블이 올바르지 않습니다.");
        check((spectralStart !== 0 || (approximation >> 4) !== 0 || huffman.has(tables >> 4))
          && (spectralEnd === 0 || huffman.has(16 + (tables & 15))), "JPEG 스캔에 필요한 Huffman 테이블이 없습니다.");
        seen.add(component); scanned.add(component);
      }
      cursor = end;
      let dataLength = 0;
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 255) { dataLength++; cursor++; continue; }
        let next = cursor + 1;
        while (bytes[next] === 255) next++;
        check(next < bytes.length, "JPEG 스캔 데이터가 잘렸습니다.");
        const following = bytes[next];
        if (following === 0 || (following >= 208 && following <= 215)) {
          dataLength++; cursor = next + 1;
        } else break;
      }
      check(dataLength > 0, "JPEG 스캔 데이터가 없습니다.");
      scanCount++;
      continue;
    } else if (marker === 221) {
      check(length === 4, "JPEG 재시작 간격이 올바르지 않습니다.");
    } else {
      check((marker >= 224 && marker <= 239) || marker === 254, "지원하지 않는 JPEG 세그먼트입니다.");
    }
    cursor = end;
  }
  throw new Error("JPEG 이미지가 잘렸거나 EOI가 없습니다.");
}

function inspectWebP(bytes) {
  check(bytes.length >= 20 && tag(bytes, 0) === "RIFF" && tag(bytes, 8) === "WEBP"
    && u32le(bytes, 4) + 8 === bytes.length, "WebP RIFF 헤더가 잘렸거나 길이가 일치하지 않습니다.");
  let cursor = 12, chunks = 0, extended, image, alpha = false;
  while (cursor < bytes.length) {
    check(++chunks <= 10_000 && cursor + 8 <= bytes.length, "WebP 청크가 잘렸습니다.");
    const type = tag(bytes, cursor), length = u32le(bytes, cursor + 4), start = cursor + 8, end = start + length;
    check(end + (length & 1) <= bytes.length && (!(length & 1) || bytes[end] === 0), "WebP 청크 길이·패딩이 올바르지 않습니다.");
    check(!["ANIM", "ANMF"].includes(type), "움직이는 WebP는 지원하지 않습니다.");
    if (type === "VP8X") {
      check(!extended && cursor === 12 && length === 10 && (bytes[start] & 0xc1) === 0
        && bytes[start + 1] === 0 && bytes[start + 2] === 0 && bytes[start + 3] === 0, "WebP 확장 헤더가 올바르지 않습니다.");
      check((bytes[start] & 2) === 0, "움직이는 WebP는 지원하지 않습니다.");
      extended = { width: u24le(bytes, start + 4) + 1, height: u24le(bytes, start + 7) + 1, flags: bytes[start] };
      dimensions(extended.width, extended.height);
    } else if (type === "VP8 " || type === "VP8L") {
      check(!image && (extended || cursor === 12), "WebP 이미지 청크 순서가 올바르지 않습니다.");
      let width, height;
      if (type === "VP8 ") {
        const frameTag = u24le(bytes, start);
        check(length >= 10 && (frameTag & 1) === 0 && ((frameTag >> 1) & 7) <= 3
          && (frameTag & 16) !== 0 && (frameTag >>> 5) <= length - 10
          && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42, "WebP VP8 프레임 헤더가 올바르지 않습니다.");
        width = (bytes[start + 6] + bytes[start + 7] * 256) & 0x3fff;
        height = (bytes[start + 8] + bytes[start + 9] * 256) & 0x3fff;
      } else {
        check(length > 5 && bytes[start] === 47 && (u32le(bytes, start + 1) >>> 29) === 0 && !alpha, "WebP VP8L 프레임 헤더가 올바르지 않습니다.");
        const bits = u32le(bytes, start + 1);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      dimensions(width, height);
      check(!extended || (extended.width === width && extended.height === height), "WebP 캔버스와 이미지 크기가 일치하지 않습니다.");
      image = { mime: "image/webp", width, height };
    } else if (type === "ALPH") {
      check(extended && (extended.flags & 16) !== 0 && !alpha && !image && length > 0
        && (bytes[start] & 0xc0) === 0 && (bytes[start] & 3) <= 1 && ((bytes[start] >> 4) & 3) <= 1,
      "WebP 알파 청크가 올바르지 않습니다.");
      alpha = true;
    } else {
      check(extended, "WebP 확장 헤더가 없습니다.");
    }
    cursor = end + (length & 1);
  }
  check(image && cursor === bytes.length, "WebP 이미지 데이터가 없거나 잘렸습니다.");
  return image;
}

/** Structural validation is synchronous; browser decoding validates the actual codec. */
export function inspectImageBytes(bytes, { allowWebP = false } = {}) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= IMAGE_LIMITS.inputBytes,
    "이미지 입력 파일은 8 MiB 이내의 비어 있지 않은 바이트 배열이어야 합니다.");
  if (bytes[0] === 137 && bytes[1] === 80) return inspectPNG(bytes);
  if (bytes[0] === 255 && bytes[1] === 216) return inspectJPEG(bytes);
  if (allowWebP && tag(bytes, 0) === "RIFF") return inspectWebP(bytes);
  throw new Error(allowWebP ? "실제 PNG·JPEG·정적 WebP 이미지 파일만 지원합니다." : "문서에는 실제 PNG·JPEG 이미지 파일만 저장할 수 있습니다.");
}

function base64Size(data) {
  check(typeof data === "string" && data.length > 0 && data.length % 4 === 0
    && data.length <= 4 * Math.ceil(IMAGE_LIMITS.inputBytes / 3), "이미지 base64 길이가 올바르지 않습니다.");
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function decodeBase64(data) {
  const size = base64Size(data);
  check(/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    && (!data.endsWith("==") || (BASE64.indexOf(data.at(-3)) & 15) === 0)
    && (!data.endsWith("=") || data.endsWith("==") || (BASE64.indexOf(data.at(-2)) & 3) === 0),
  "이미지는 data URL·공백이 없는 정규 base64 문자열이어야 합니다.");
  let decoded;
  try { decoded = atob(data); } catch { throw new Error("이미지 base64 데이터를 해석할 수 없습니다."); }
  check(decoded.length === size, "이미지 base64 크기가 일치하지 않습니다.");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function encodeBase64(bytes) {
  check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= IMAGE_LIMITS.inputBytes,
    "이미지는 8 MiB 이내의 비어 있지 않은 바이트 배열이어야 합니다.");
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

// Keys are immutable string contents, never mutable image objects. A hit still
// checks MIME/dimensions and every editable field. Both entry count and retained
// data are bounded, including after switching among many documents.
const validated = new Map();
let cachedCharacters = 0;
function remember(data, details) {
  const maximum = 4 * Math.ceil(IMAGE_LIMITS.totalBytes / 3);
  while (validated.size >= IMAGE_LIMITS.perDocument || cachedCharacters + data.length > maximum) {
    const oldest = validated.keys().next().value;
    if (oldest === undefined) break;
    cachedCharacters -= oldest.length; validated.delete(oldest);
  }
  validated.set(data, details); cachedCharacters += data.length;
}

export function validateImage(image) {
  check(image && typeof image === "object" && !Array.isArray(image)
    && [Object.prototype, null].includes(Object.getPrototypeOf(image)), "이미지 객체가 필요합니다.");
  const properties = Object.getOwnPropertyDescriptors(image);
  check(Reflect.ownKeys(properties).length === IMAGE_KEYS.length && IMAGE_KEYS.every((key) => properties[key]?.enumerable
    && Object.prototype.hasOwnProperty.call(properties[key], "value")), "이미지 속성이 없거나 알 수 없는 속성이 있습니다.");
  check(typeof image.id === "string" && image.id.trim().length > 0 && image.id.length <= 128
    && !["__proto__", "prototype", "constructor"].includes(image.id), "이미지 ID가 올바르지 않습니다.");
  check(image.section === "method" || image.section === "steps", "이미지는 처리 방법 또는 진행 순서에만 첨부할 수 있습니다.");
  check(typeof image.caption === "string" && image.caption.length <= IMAGE_LIMITS.caption
    && !BAD_CONTROLS.test(image.caption) && !BAD_CONTROLS.test(image.id)
    && !BAD_UNICODE.test(image.caption) && !BAD_UNICODE.test(image.id),
  "이미지 설명은 제어문자 없는 올바른 문자열로 최대 400자까지 지원합니다.");
  check(image.mime === "image/png" || image.mime === "image/jpeg", "문서 이미지 MIME은 image/png 또는 image/jpeg여야 합니다.");
  dimensions(image.width, image.height);
  const size = base64Size(image.data);
  check(size <= IMAGE_LIMITS.imageBytes, "v2 문서 이미지 한 장은 2 MiB 이하여야 합니다.");
  let details = validated.get(image.data);
  if (!details) {
    details = { ...inspectImageBytes(decodeBase64(image.data)), bytes: size };
    remember(image.data, details);
  }
  check(details.mime === image.mime, "이미지 MIME과 실제 파일 형식이 일치하지 않습니다.");
  check(details.width === image.width && details.height === image.height, "이미지 너비·높이가 실제 파일과 일치하지 않습니다.");
  return { ...details };
}

export function imageDataURL(image) {
  validateImage(image);
  return `data:${image.mime};base64,${image.data}`;
}

/** Fast accounting for a document; validateDocument enforces aggregate limits. */
export function imageStats(document) {
  let count = 0, bytes = 0;
  for (const task of document.tasks ?? []) {
    for (const image of task.images ?? []) { count++; bytes += base64Size(image.data); }
  }
  return { count, bytes };
}
