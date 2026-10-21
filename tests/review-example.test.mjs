import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reviewExampleDocument } from "../src/review-example.js";
import { EXAMPLE_IMAGES } from "../src/example-images.js";
import { extractDocument } from "../src/importers.js";
import { validateDocument, parseImport, stringifyDocument, importAsCopy, dueInRange } from "../src/model.js";

const readFixture = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const images = (document) => document.tasks.flatMap((task) => task.images ?? []);

test("review fixture is a valid self-contained v2 document with five review categories", async () => {
  const document = reviewExampleDocument();
  assert.deepEqual(validateDocument(document), { ok: true, errors: [], warnings: [] });
  assert.equal(document.schemaVersion, 3);
  assert.equal(document.groups.length, 3);
  assert.equal(document.tasks.length, 6);
  assert.equal(document.cases.length, 2);
  assert.equal(images(document).length, 1);
  assert.equal(images(document)[0].data, EXAMPLE_IMAGES.landscape.data);
  assert.ok(document.tasks.every((task) => task.title.startsWith("[가상]")));
  assert.ok(document.tasks.every((task) => task.firstAction.length > 0));
  assert.match(document.title, /완전가상/);
  assert.equal(document.sourceFiles.length, 1);
  assert.equal(document.sourceFiles[0].pdf.pageCount, 2);
  assert.ok(document.sourceFiles[0].excerpt.length < 250);
  assert.match(document.sourceFiles[0].warnings.join("\n"), /뜻이 정해지지 않은 메모/);
  const serialized = stringifyDocument(document);
  assert.doesNotMatch(serialized, /libfile_|\/Users\/|https?:\/\//u);
  const stored = parseImport((await readFixture("first-flow-synthetic.json")).toString("utf8")).document;
  assert.deepEqual(validateDocument(stored).errors, []);
  assert.equal(stored.tasks.length, document.tasks.length);
  assert.deepEqual(stored.sourceFiles[0].pdf, document.sourceFiles[0].pdf);
});

test("embedded PDF matches the standalone file and actually contains two readable synthetic pages", async () => {
  const document = reviewExampleDocument();
  const bytes = await readFixture("first-flow-safe.pdf");
  assert.deepEqual(Buffer.from(document.sourceFiles[0].pdf.data, "base64"), bytes);
  const result = await extractDocument({
    name: "first-flow-safe.pdf", size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  assert.equal(result.format, "pdf");
  assert.equal(result.blocks.length, 2);
  assert.match(result.blocks[0].source, /1쪽/);
  assert.match(result.blocks[1].source, /2쪽/);
  assert.ok(result.blocks.every((block) => /완전가상|SYNTHETIC REVIEW ONLY/u.test(block.text)));
  assert.match(result.blocks[0].text, /날짜가 없음/u);
  assert.match(result.blocks[0].text, /요청자 역할에게 날짜를 질문/u);
  assert.match(result.blocks[1].text, /정확한 날짜 미확정/u);
  assert.match(result.blocks[1].text, /노란 표시/u);
  assert.match(result.blocks[1].text, /본인 계정/u);
});

test("uncertain month-start and month-end fixtures never turn into exact calendar dates", () => {
  const document = reviewExampleDocument();
  for (const dayRule of ["monthStartUnconfirmed", "monthEndUnconfirmed"]) {
    const task = document.tasks.find((task) => task.timing.dayRule === dayRule);
    const result = dueInRange(task, "2026-10-01", "2026-11-30");
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.dates, []);
  }
  const exact = document.tasks.find((task) => task.timing.dayRule === "monthEnd");
  assert.deepEqual(dueInRange(exact, "2026-10-01", "2026-11-30").dates, ["2026-10-31", "2026-11-30"]);
});

test("JSON reopen and copy retain explicit versus unknown state, task links, PDF and image bytes", () => {
  const original = reviewExampleDocument();
  const restored = parseImport(stringifyDocument(original)).document;
  assert.deepEqual(restored, original);
  assert.equal(restored.cases[0].status, "waiting");
  assert.equal(restored.cases[0].statusConfirmed, true);
  assert.equal(restored.cases[0].taskId, restored.tasks[0].id);
  assert.equal(restored.cases[1].status, "unknown");
  assert.equal(restored.cases[1].statusConfirmed, false);
  assert.equal(restored.cases[1].dueDate, "");
  const copied = importAsCopy(restored);
  assert.deepEqual(validateDocument(copied).errors, []);
  assert.notEqual(copied.tasks[0].id, original.tasks[0].id);
  assert.equal(copied.cases[0].taskId, copied.tasks[0].id);
  assert.equal(copied.cases[1].taskId, copied.tasks.at(-1).id);
  assert.deepEqual(copied.sourceFiles[0].pdf, original.sourceFiles[0].pdf);
  assert.equal(images(copied)[0].data, images(original)[0].data);
  assert.equal(copied.cases[1].status, "unknown");
  assert.equal(copied.cases[1].statusConfirmed, false);
});

test("opening the review example twice creates separate editable records without DOM dependencies", () => {
  const first = reviewExampleDocument();
  const second = reviewExampleDocument();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.tasks[0].id, second.tasks[0].id);
  assert.notEqual(first.sourceFiles[0].id, second.sourceFiles[0].id);
  first.tasks[0].firstAction = "Edited synthetic action";
  first.tasks[0].images[0].caption = "Edited synthetic caption";
  first.sourceFiles[0].warnings.push("Edited synthetic warning");
  first.sourceFiles[0].pdf.data = "";
  assert.notEqual(second.tasks[0].firstAction, first.tasks[0].firstAction);
  assert.notEqual(second.tasks[0].images[0].caption, first.tasks[0].images[0].caption);
  assert.equal(second.sourceFiles[0].warnings.length, 2);
  assert.ok(second.sourceFiles[0].pdf.data.length > 0);
  assert.deepEqual(validateDocument(second).errors, []);
});
