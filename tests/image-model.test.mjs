import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zlibSync, unzlibSync } from "fflate";
import {
  IMAGE_LIMITS, inspectImageBytes, decodeBase64, encodeBase64, validateImage, imageDataURL, imageStats,
} from "../src/image-data.js";
import { LIMITS, createDocument, createTask, createCase, makeId, validateDocument, stringifyDocument, parseImport, importAsCopy } from "../src/model.js";

const file = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url)));
const png = file("landscape.png"), jpeg = file("portrait.jpg"), webp = file("landscape.webp");
const copy = (value) => JSON.parse(JSON.stringify(value));
const image = (bytes = png, overrides = {}) => ({
  id: makeId(), section: "method", caption: "가상 화면 설명 🐻\r\n순서\t확인",
  ...inspectImageBytes(bytes), data: encodeBase64(bytes), ...overrides,
});
const document = (images = [image()]) => createDocument({
  schemaVersion: 2, title: "가상 이미지 인수인계", tasks: [createTask({ title: "가상 업무", images })],
});
const valid = (value) => assert.deepEqual(validateDocument(value).errors, []);
const invalid = (value, pattern) => {
  const result = validateDocument(value);
  assert.equal(result.ok, false);
  if (pattern) assert.match(result.errors.join("\n"), pattern);
};
const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
const set32 = (bytes, offset, value) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value);
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const result = new Uint8Array(data.length + 12);
  set32(result, 0, data.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  set32(result, result.length - 4, crc32(result.subarray(4, -4)));
  return result;
}
const concatenate = (...parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
function pngChunks(bytes = png) {
  const result = [];
  for (let offset = 8; offset < bytes.length;) {
    const end = offset + 12 + u32(bytes, offset);
    result.push({ type: new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)), data: bytes.slice(offset + 8, end - 4) });
    offset = end;
  }
  return result;
}
const rebuild = (parts) => concatenate(png.subarray(0, 8), ...parts.map(({ type, data }) => chunk(type, data)));
function paddedPNG(size) {
  const padding = new Uint8Array(size - png.length - 12).fill(65);
  padding.set([112, 97, 100, 0]);
  return concatenate(png.subarray(0, -12), chunk("tEXt", padding), png.subarray(-12));
}

test("image limits allow readable screenshots while v1/v2 JSON budgets remain distinct", () => {
  assert.deepEqual(IMAGE_LIMITS, {
    inputBytes: 8 * 1024 * 1024, imageBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024,
    perTask: 20, perDocument: 100, maxPixels: 16_000_000, maxDimension: 8192, caption: 400,
  });
  assert.equal(4 * Math.ceil(IMAGE_LIMITS.imageBytes / 3), 2_796_204);
  assert.equal(LIMITS.jsonBytes, 5 * 1024 * 1024);
  assert.equal(LIMITS.imageJsonBytes, 24 * 1024 * 1024);
  assert.equal(LIMITS.excerpt, 1_048_576);
  assert.equal(Object.isFrozen(IMAGE_LIMITS), true);
});

test("legacy v1 exact JSON and omitted optional properties remain unchanged", () => {
  const legacy = createDocument({ title: "기존 문서", tasks: [createTask({ method: "한글 🐻\r\n표\t그대로" })] });
  delete legacy.groups;
  for (const key of ["groupId", "ownerRole", "supportRole", "accessStatus"]) delete legacy.tasks[0][key];
  const json = JSON.stringify(legacy, null, 2);
  valid(legacy);
  assert.equal(createDocument().schemaVersion, 1);
  assert.equal(Object.hasOwn(createTask(), "images"), false);
  assert.equal(stringifyDocument(legacy), json);
  assert.equal(stringifyDocument(parseImport(json).document), json);
  assert.equal(Object.hasOwn(parseImport(json).document.tasks[0], "images"), false);
});

test("v2 image JSON preserves all bytes, IDs, captions, section order, and unrelated text exactly", () => {
  const source = document([image(png), image(jpeg, { section: "steps", caption: "<script>문자 그대로</script> e\u0301 🧩" })]);
  source.tasks[0].method = "원문\r\n그대로";
  const json = JSON.stringify(source, null, 2);
  const restored = parseImport(stringifyDocument(source)).document;
  assert.deepEqual(restored, source);
  assert.equal(stringifyDocument(restored), json);
  assert.deepEqual(decodeBase64(restored.tasks[0].images[0].data), png);
  assert.deepEqual(decodeBase64(restored.tasks[0].images[1].data), jpeg);
  assert.equal(imageDataURL(source.tasks[0].images[0]), `data:image/png;base64,${encodeBase64(png)}`);
  assert.deepEqual(imageStats(source), { count: 2, bytes: png.length + jpeg.length });
  assert.deepEqual(imageStats(createDocument()), { count: 0, bytes: 0 });
});

test("v2 images are optional and v1 rejects the images key even when empty", () => {
  for (const tasks of [[], [createTask()], [createTask({ images: [] })]]) valid(createDocument({ schemaVersion: 2, tasks }));
  for (const images of [[], [image()]]) invalid(createDocument({ tasks: [createTask({ images })] }), /알 수 없는 속성/);
  for (const version of ["2", 0, 3]) invalid(createDocument({ schemaVersion: version }), /스키마/);
});

test("copying remaps image IDs, references and provenance while preserving image content", () => {
  const source = document([image(png), image(jpeg, { section: "steps" })]);
  source.groups = [{ id: makeId(), title: "가상 영역" }];
  source.sourceFiles = [{ id: makeId(), name: "가상.txt", format: "text", importedAt: source.createdAt, excerpt: "가상 출처", warnings: [] }];
  source.tasks[0].groupId = source.groups[0].id;
  source.tasks[0].sourceRefs = [source.sourceFiles[0].id];
  source.cases = [createCase({ sourceRefs: [source.sourceFiles[0].id] })];
  const original = copy(source), result = importAsCopy(source);
  valid(result);
  assert.deepEqual(source, original);
  const oldIds = new Set([source.id, source.tasks[0].id, source.groups[0].id, source.sourceFiles[0].id, source.cases[0].id, ...source.tasks[0].images.map((item) => item.id)]);
  const newIds = [result.id, result.tasks[0].id, result.groups[0].id, result.sourceFiles[0].id, result.cases[0].id, ...result.tasks[0].images.map((item) => item.id)];
  assert.equal(new Set(newIds).size, newIds.length);
  newIds.forEach((id) => assert.equal(oldIds.has(id), false));
  source.tasks[0].images.forEach((item, index) => {
    const mapped = result.tasks[0].images[index];
    assert.deepEqual({ ...mapped, id: item.id }, item);
    assert.equal(result.provenance.copyHistory[0].idMap[item.id], mapped.id);
  });
  const again = importAsCopy(result);
  assert.notEqual(again.tasks[0].images[0].id, result.tasks[0].images[0].id);
  assert.equal(again.tasks[0].images[0].data, source.tasks[0].images[0].data);
});

test("image IDs participate in global uniqueness across every model collection", () => {
  for (const target of ["document", "task", "case", "group", "source", "image"]) {
    const source = document([image(), image()]);
    source.cases = [createCase()];
    source.groups = [{ id: makeId(), title: "영역" }];
    source.sourceFiles = [{ id: makeId(), name: "가상.txt", format: "text", importedAt: source.createdAt, excerpt: "", warnings: [] }];
    source.tasks[0].images[0].id = ({
      document: source.id, task: source.tasks[0].id, case: source.cases[0].id,
      group: source.groups[0].id, source: source.sourceFiles[0].id, image: source.tasks[0].images[1].id,
    })[target];
    invalid(source, /중복 ID/);
  }
});

test("image objects require exact fields, safe controls, supported sections and captions <=400", () => {
  for (const mutate of [
    (item) => { item.filename = "extra.png"; },
    (item) => { delete item.caption; },
    (item) => { item.section = "purpose"; },
    (item) => { item.caption = "a".repeat(401); },
    (item) => { item.caption = "\u202e"; },
    (item) => { item.caption = "\ud800"; },
    (item) => { item.id = "constructor"; },
    (item) => { item.mime = "image/webp"; },
    (item) => { item.width = "480"; },
    (item) => { item.width = 0; },
    (item) => { item.height = -1; },
    (item) => { item.width = 8193; },
    (item) => { item.width = 8192; item.height = 8192; },
  ]) {
    const source = document();
    mutate(source.tasks[0].images[0]);
    invalid(source);
  }
  valid(document([image(png, { caption: "가".repeat(400) })]));
  for (const images of [null, {}, ""]) invalid(document(images));
  let invoked = false;
  const accessor = image();
  Object.defineProperty(accessor, "caption", { enumerable: true, get() { invoked = true; return ""; } });
  assert.throws(() => validateImage(accessor), /속성/);
  invalid(document([accessor]), /접근자/);
  assert.equal(invoked, false);
});

test("canonical base64 rejects data URLs, whitespace, invalid alphabet and nonzero padding bits", () => {
  for (const bytes of [Uint8Array.of(0), Uint8Array.of(0, 1), Uint8Array.of(255, 255, 255), png, jpeg]) {
    assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
  }
  for (const data of ["", "AA", "AA=", "A===", "AA==\n", " AA==", "AA-_", "AB==", "AAB=", "AA==AA==", "data:image/png;base64,AA==", 123]) {
    assert.throws(() => decodeBase64(data), /base64/);
  }
  assert.throws(() => encodeBase64(new Uint8Array(IMAGE_LIMITS.inputBytes + 1)), /8 MiB/);
});

test("PNG/JPEG/static WebP fixtures pass actual signatures and dimensions; WebP is input-only", () => {
  for (const [name, width, height] of [
    ["landscape.png", 480, 300], ["portrait.png", 300, 480], ["landscape.jpg", 480, 300], ["portrait.jpg", 300, 480],
    ["landscape.webp", 480, 300], ["portrait.webp", 300, 480], ["large-landscape.png", 1600, 900], ["large-portrait.jpg", 900, 1600],
  ]) {
    const expectedMime = name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : "image/webp";
    assert.deepEqual(inspectImageBytes(file(name), { allowWebP: true }), { mime: expectedMime, width, height });
  }
  assert.throws(() => inspectImageBytes(webp), /PNG·JPEG/);
  assert.throws(() => validateImage({ ...image(), mime: "image/webp", data: encodeBase64(webp) }), /MIME/);
  for (const text of ["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "<html><script>alert(1)</script></html>", "GIF89a"]) {
    assert.throws(() => inspectImageBytes(new TextEncoder().encode(text), { allowWebP: true }), /실제/);
  }
});

test("PNG rejects bad CRC, truncated chunks, missing IEND, trailing bytes, APNG and impossible headers", () => {
  const badCRC = png.slice(); badCRC[40] ^= 1;
  const duplicateIHDR = pngChunks(); duplicateIHDR.splice(1, 0, duplicateIHDR[0]);
  const animated = pngChunks(); animated.splice(1, 0, { type: "acTL", data: Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0) });
  const huge = pngChunks(); set32(huge[0].data, 0, 8193);
  const excessivePixels = pngChunks(); set32(excessivePixels[0].data, 0, 8192); set32(excessivePixels[0].data, 4, 8192);
  const badDepth = pngChunks(); badDepth[0].data[8] = 3;
  for (const bytes of [badCRC, png.subarray(0, 30), png.subarray(0, -1), png.subarray(0, -12),
    concatenate(png, Uint8Array.of(0)), rebuild(duplicateIHDR), rebuild(animated), rebuild(huge), rebuild(excessivePixels), rebuild(badDepth)]) {
    assert.throws(() => inspectImageBytes(bytes), /PNG|이미지 크기/);
    invalid(document([image(png, { data: encodeBase64(bytes) })]));
  }
});

test("PNG rejects corrupt IDAT even with recomputed chunk CRCs and bounded decompression bombs", () => {
  const parts = pngChunks();
  const compressed = concatenate(...parts.filter(({ type }) => type === "IDAT").map(({ data }) => data));
  const raw = unzlibSync(compressed);
  const changeIDAT = (data) => rebuild([
    ...parts.filter(({ type }) => type !== "IDAT" && type !== "IEND"),
    { type: "IDAT", data }, parts.at(-1),
  ]);
  const badAdler = compressed.slice(); badAdler[badAdler.length - 1] ^= 1;
  const badFilter = raw.slice(); badFilter[0] = 5;
  for (const data of [badAdler, compressed.subarray(0, -6), zlibSync(raw.subarray(0, -1)),
    zlibSync(concatenate(raw, Uint8Array.of(0))), zlibSync(badFilter)]) {
    assert.throws(() => inspectImageBytes(changeIDAT(data)), /PNG/);
  }
  const tinyHeader = parts[0].data.slice(); set32(tinyHeader, 0, 1); set32(tinyHeader, 4, 1);
  const bomb = rebuild([{ type: "IHDR", data: tinyHeader }, { type: "IDAT", data: zlibSync(new Uint8Array(2_000_000)) }, parts.at(-1)]);
  assert.throws(() => inspectImageBytes(bomb), /초과/);
});

test("JPEG rejects segment truncation, missing EOI, trailing bytes, forged dimensions and absent scans", () => {
  const brokenLength = jpeg.slice(); brokenLength[4] = 255; brokenLength[5] = 255;
  const huge = jpeg.slice();
  for (let at = 2; at < huge.length;) {
    const marker = huge[at + 1], length = (huge[at + 2] << 8) | huge[at + 3];
    if ([192, 193, 194].includes(marker)) { huge[at + 7] = 0x20; huge[at + 8] = 1; break; }
    at += length + 2;
  }
  for (const bytes of [jpeg.subarray(0, 20), jpeg.subarray(0, -2), concatenate(jpeg, Uint8Array.of(0)), brokenLength, huge, Uint8Array.of(255, 216, 255, 217)]) {
    assert.throws(() => inspectImageBytes(bytes), /JPEG|이미지 크기/);
    invalid(document([image(jpeg, { data: encodeBase64(bytes) })]));
  }
});

test("WebP rejects RIFF size mismatch, cut bitstreams and animation headers", () => {
  const badLength = webp.slice(); badLength[4] ^= 1;
  const brokenFrame = webp.slice(); brokenFrame[23] ^= 1;
  const vp8x = Uint8Array.of(2, 0, 0, 0, 0xdf, 1, 0, 0x2b, 1, 0);
  const animated = concatenate(webp.subarray(0, 12), new TextEncoder().encode("VP8X"), Uint8Array.of(10, 0, 0, 0), vp8x, webp.subarray(12));
  new DataView(animated.buffer).setUint32(4, animated.length - 8, true);
  for (const bytes of [webp.subarray(0, 15), webp.subarray(0, -1), badLength, brokenFrame, animated]) {
    assert.throws(() => inspectImageBytes(bytes, { allowWebP: true }), /WebP/);
  }
});

test("cached binary validation cannot hide altered MIME, dimensions, data, captions or sections", () => {
  const original = image();
  validateImage(original);
  for (const replacement of [
    { mime: "image/jpeg" }, { width: 479 }, { height: 301 }, { data: encodeBase64(png.subarray(0, -1)) },
    { data: "A".repeat(original.data.length) }, { caption: "\u0000" }, { caption: "a".repeat(401) }, { section: "contacts" },
  ]) {
    assert.throws(() => validateImage({ ...original, ...replacement }));
  }
  valid(document([{ ...original, caption: "수정한 설명", section: "steps" }]));
  const mutable = copy(original);
  validateImage(mutable);
  mutable.width = 1;
  assert.throws(() => validateImage(mutable), /일치/);
});

test("per-task and per-document counts enforce limits before binary inspection", () => {
  const perTask = document(Array.from({ length: 20 }, () => image()));
  valid(perTask);
  perTask.tasks[0].images.push(image(png, { data: "AAAA" }));
  invalid(perTask, /업무당.*20/);
  const all = document([]);
  all.tasks = Array.from({ length: 5 }, () => createTask({ images: Array.from({ length: 20 }, () => image()) }));
  valid(all);
  all.tasks.push(createTask({ images: [image(png, { data: "AAAA" })] }));
  invalid(all, /전체.*100/);
});

test("exact per-image and aggregate byte budgets roundtrip; over-budget fails before decoding", () => {
  const large = paddedPNG(IMAGE_LIMITS.imageBytes);
  const source = document(Array.from({ length: 8 }, () => image(large)));
  valid(source);
  assert.equal(source.tasks[0].images[0].data.length, 2_796_204);
  assert.deepEqual(imageStats(source), { count: 8, bytes: IMAGE_LIMITS.totalBytes });
  assert.deepEqual(parseImport(stringifyDocument(source)).document, source);
  const above = copy(source);
  above.tasks[0].images.push(image(png, { data: "AAAA" }));
  invalid(above, /16 MiB/);
  const tooLarge = document([image(png, { data: encodeBase64(paddedPNG(IMAGE_LIMITS.imageBytes + 1)) })]);
  invalid(tooLarge, /문자열 길이|2 MiB/);
  assert.throws(() => validateImage(tooLarge.tasks[0].images[0]), /2 MiB/);
  const tooMuchJSON = copy(source);
  tooMuchJSON.sourceFiles = Array.from({ length: 3 }, () => ({
    id: makeId(), name: "가상.txt", format: "text", importedAt: source.createdAt, excerpt: "a".repeat(1_000_000), warnings: [],
  }));
  invalid(tooMuchJSON, /v2.*24 MiB/);
  assert.throws(() => parseImport(JSON.stringify(tooMuchJSON)), /24 MiB/);
});

test("v1 retains its raw 5 MiB import cap and excerpt cap even though v2 allows larger image strings", () => {
  const legacy = createDocument();
  const padded = JSON.stringify(legacy) + " ".repeat(LIMITS.jsonBytes);
  assert.throws(() => parseImport(padded), /v1.*5 MiB/);
  legacy.provenance = { raw: "a".repeat(LIMITS.excerpt + 1) };
  invalid(legacy, /문자열 길이/);
  const source = document();
  source.sourceFiles = [{ id: makeId(), name: "가상.txt", format: "text", importedAt: source.createdAt,
    excerpt: "a".repeat(LIMITS.excerpt + 1), warnings: [] }];
  invalid(source, /1,048,576/);
});

test("repeated large strings fail the JSON graph budget before huge serialization", () => {
  const source = document();
  source.provenance = { repeated: Array(100).fill("x".repeat(1_000_000)) };
  invalid(source, /v2.*24 MiB/);
});
