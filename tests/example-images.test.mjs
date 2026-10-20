import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXAMPLE_IMAGES } from "../src/example-images.js";
import { decodeBase64, inspectImageBytes } from "../src/image-data.js";
import {
  createDocument, exampleDocument, importAsCopy, parseImport,
  stringifyDocument, validateDocument,
} from "../src/model.js";

const images = (document) => document.tasks.flatMap((task) => task.images ?? []);
const fixture = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/images/${name}.png`, import.meta.url)));

test("example image payloads are immutable embedded synthetic fixtures without references", () => {
  assert.equal(Object.isFrozen(EXAMPLE_IMAGES), true);
  let bytes = 0;
  for (const [name, payload] of Object.entries(EXAMPLE_IMAGES)) {
    assert.equal(Object.isFrozen(payload), true);
    assert.deepEqual(Object.keys(payload).sort(), ["data", "height", "mime", "width"]);
    assert.match(payload.data, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.doesNotMatch(payload.data, /(?:https?:|file:|blob:|data:)/);
    const decoded = decodeBase64(payload.data);
    assert.deepEqual(decoded, fixture(name));
    const metadata = inspectImageBytes(decoded);
    assert.equal(payload.mime, metadata.mime);
    assert.equal(payload.width, metadata.width);
    assert.equal(payload.height, metadata.height);
    bytes += decoded.byteLength;
  }
  assert.equal(bytes, 19_370);
});

test("sample uses two photos in the intended tasks while blank documents remain v1", () => {
  const document = exampleDocument("2026-10-20");
  assert.equal(document.schemaVersion, 2);
  assert.equal(createDocument().schemaVersion, 1);
  assert.equal(document.tasks.length, 10);
  assert.equal(document.cases.length, 3);
  assert.equal(document.groups.length, 3);
  assert.deepEqual(validateDocument(document).errors, []);
  assert.equal(images(document).length, 2);
  assert.equal(document.tasks[0].title, "[가상] 매일 접수함 확인");
  assert.equal(document.tasks[0].images[0].section, "method");
  assert.equal(document.tasks[1].title, "[가상] 주간 회의 준비");
  assert.equal(document.tasks[1].images[0].section, "steps");
  for (const image of images(document)) {
    assert.match(image.caption, /^\[가상 예시\]/);
    assert.doesNotMatch(image.caption, /https?:\/\/|file:\/\/|blob:/);
  }
});

test("example JSON round trip and copy import preserve photo bytes and captions exactly", () => {
  const original = exampleDocument("2026-10-20");
  original.tasks[0].images[0].caption += "\n검토 메모\t한글 🧩";
  const json = stringifyDocument(original);
  const restored = parseImport(json).document;
  assert.deepEqual(restored, original);
  assert.equal(stringifyDocument(restored), json);
  const duplicate = importAsCopy(restored);
  assert.deepEqual(validateDocument(duplicate).errors, []);
  assert.equal(stringifyDocument(original), json);
  assert.equal(stringifyDocument(restored), json);
  const sourceIds = new Set(images(original).map((image) => image.id));
  images(duplicate).forEach((image, index) => {
    assert.equal(sourceIds.has(image.id), false);
    const source = images(original)[index];
    assert.deepEqual({ ...image, id: source.id }, source);
    assert.deepEqual(decodeBase64(image.data), decodeBase64(source.data));
  });
});

test("repeated samples get fresh image IDs and independently editable photo records", () => {
  const first = exampleDocument("2026-10-20");
  const second = exampleDocument("2026-10-20");
  const firstIds = new Set(images(first).map((image) => image.id));
  assert.equal(firstIds.size, 2);
  assert.equal(new Set(images(second).map((image) => image.id)).size, 2);
  for (const image of images(second)) assert.equal(firstIds.has(image.id), false);
  const originalCaption = second.tasks[0].images[0].caption;
  first.tasks[0].images[0].caption = "사용자가 바꾼 설명";
  first.tasks[0].images[0].data = "";
  first.tasks[1].images.pop();
  assert.equal(second.tasks[0].images[0].caption, originalCaption);
  assert.equal(second.tasks[0].images[0].data, EXAMPLE_IMAGES.landscape.data);
  assert.equal(images(second).length, 2);
  assert.notEqual(EXAMPLE_IMAGES.landscape.data, "");
});
