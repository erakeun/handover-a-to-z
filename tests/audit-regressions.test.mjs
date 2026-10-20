import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import * as model from "../src/model.js";
import * as storage from "../src/storage.js";
import { openDocumentStore } from "../src/document-store.js";
import { createPhotoUI } from "../src/photo-ui.js";
import { imageStats } from "../src/image-data.js";
import { verifyDocumentImages } from "../src/image-browser.js";
import { renderWorkOverview } from "../src/work-overview.js";

// Run the actual application functions in a local DOM. Import/extraction/export
// adapters are deliberately inert; these tests exercise application state only.
const source = (await readFile(new URL("../src/app.js", import.meta.url), "utf8"))
  .replace(/^import .*;\s*$/gm, "");

async function mount(t, initialDocuments = []) {
  const window = new Window({ url: "https://handover-audit-dom-test.invalid/" });
  const { document } = window;
  document.body.innerHTML = '<div id="app"></div><div id="modal-root"></div><div id="notice"></div>';
  if (initialDocuments.length) storage.saveDocuments(window.localStorage, initialDocuments);
  const dependencies = {
    ...model, ...storage, openDocumentStore, createPhotoUI, imageStats,
    verifyDocumentImages, renderWorkOverview, window, document, Node: window.Node,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    renderCalendar: () => document.createElement("section"),
    extractDocument: () => { throw new Error("not used in this audit"); },
    exportDocx: () => { throw new Error("not used in this audit"); },
    exportAIText: () => "",
    AUTHOR_PROMPT: "", parseAIDraft: () => [], applyAIDraft: (value) => value,
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const api = await new AsyncFunction(...Object.keys(dependencies),
    `${source}\nreturn { state, saved, jsonImport, issuesPanel, timingLabel, render };`)(...Object.values(dependencies));
  t.after(() => window.happyDOM.close());
  return { window, document, api };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}
function selectFile(window, input, name, textPromise) {
  Object.defineProperty(input, "files", {
    value: [{ name, size: 100, text: () => textPromise }], configurable: true,
  });
  input.dispatchEvent(new window.Event("change"));
}
function click(document, text) {
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent === text);
  assert.ok(button, `Button exists: ${text}`);
  button.click();
}

test("stale document edits cannot overwrite another tab, while independent progress checks accumulate", async (t) => {
  const original = model.createDocument({ title: "가상 원본" });
  const { window, api } = await mount(t, [original]);
  const newer = storage.loadDocuments(window.localStorage);
  newer[0].title = "다른 탭에서 먼저 저장한 제목";
  storage.saveDocuments(window.localStorage, newer);
  api.state.documents[0].onboarding.dayOne = "현재 탭의 아직 저장하지 않은 메모";
  api.saved();
  await turn();
  assert.equal(api.state.storageConflict, true);
  assert.match(api.state.saveMessage, /다른 창/);
  assert.equal(storage.loadDocuments(window.localStorage)[0].title, newer[0].title);
  assert.equal(storage.loadDocuments(window.localStorage)[0].onboarding.dayOne, "");
  assert.equal(api.state.documents[0].onboarding.dayOne, "현재 탭의 아직 저장하지 않은 메모");
  assert.doesNotThrow(() => model.stringifyDocument(api.state.documents[0]));

  const tabA = storage.loadProgress(window.localStorage);
  const tabB = storage.loadProgress(window.localStorage);
  storage.markProgress(window.localStorage, tabA, original.id, "A@manual", true);
  storage.markProgress(window.localStorage, tabB, original.id, "B@manual", true);
  const actual = storage.loadProgress(window.localStorage)[original.id];
  assert.equal(actual["A@manual"].checked, true);
  assert.equal(actual["B@manual"].checked, true);
});

test("overlapping JSON reads use the most recent selection and closing import discards pending results", async (t) => {
  const { window, document, api } = await mount(t);
  api.jsonImport();
  const input = document.querySelector("input[type=file]");
  const first = deferred();
  const second = deferred();
  selectFile(window, input, "A.json", first.promise);
  selectFile(window, input, "B.json", second.promise);
  second.resolve(model.stringifyDocument(model.createDocument({ title: "가상 문서 B" })));
  await turn();
  first.resolve(model.stringifyDocument(model.createDocument({ title: "가상 문서 A" })));
  await turn();
  assert.match(document.querySelector(".import-preview").textContent, /가상 문서 B/);
  assert.doesNotMatch(document.querySelector(".import-preview").textContent, /가상 문서 A/);
  click(document, "이 인수인계서 보기");
  assert.equal(api.state.documents.length, 1);
  assert.equal(api.state.documents[0].title, "가상 문서 B");
  assert.match(document.querySelector("#notice").textContent, /B\.json/);

  api.jsonImport();
  const pending = deferred();
  selectFile(window, document.querySelector("input[type=file]"), "cancelled.json", pending.promise);
  click(document, "취소");
  pending.resolve(model.stringifyDocument(model.createDocument({ title: "추가되면 안 되는 가상 문서" })));
  await turn();
  assert.equal(document.querySelector("#modal-root").children.length, 0);
  assert.equal(api.state.documents.length, 1);
});

test("the confirmation panel exposes unresolved relative tasks even without other issue flags", async (t) => {
  const task = model.createTask({
    title: "가상 미확정 기준일 업무",
    timing: { kind: "relative", anchorDate: "", offsetDays: 3, startRule: "기준일 확정 후 준비" },
    verifiedAt: model.dateISO(), accessStatus: "confirmed",
  });
  const document = model.createDocument({ tasks: [task] });
  assert.deepEqual(model.issuesFor(document), []);
  assert.equal(model.dueInRange(task, model.dateISO(), model.dateISO()).unresolved, true);
  const { api } = await mount(t, [document]);
  const panel = api.issuesPanel();
  assert.match(panel.textContent, /가상 미확정 기준일 업무/);
  assert.match(panel.textContent, /기준일/);
  assert.ok([...panel.querySelectorAll("details.read-card > summary")].some((summary) => summary.textContent.includes(task.title)));
});

test("human schedule labels ignore retained fields belonging to inactive cadences", async (t) => {
  const { api } = await mount(t);
  assert.equal(api.timingLabel({ kind: "regular", cadence: "daily", month: 12, day: 31, weekday: 1 }), "매일");
  assert.equal(api.timingLabel({ kind: "regular", cadence: "weekly", weekday: 1, month: 12, day: 31 }), "매주 월요일");
  assert.equal(api.timingLabel({ kind: "regular", cadence: "monthly", month: 12, day: 20 }), "매월 20일");
  assert.equal(api.timingLabel({ kind: "regular", cadence: "monthly", dayRule: "monthEnd", month: 12, day: 1 }), "매월 말일");
  assert.match(api.timingLabel({ kind: "regular", cadence: "yearly", month: 12, day: 31 }), /12월.*31일/);
});

test("removing the last role clears a stale role filter instead of hiding all tasks", async (t) => {
  const task = model.createTask({ title: "가상 역할 변경 업무", ownerRole: "가상 역할 A" });
  const { api, document } = await mount(t, [model.createDocument({ tasks: [task] })]);
  api.state.roleQuery = "가상 역할 A";
  api.state.documents[0].tasks[0].ownerRole = "";
  api.state.view = "reader";
  api.render();
  await turn();
  assert.equal(api.state.roleQuery, "");
  assert.equal(document.querySelector(".role-filter"), null);
  assert.match(document.querySelector("#reader-results").textContent, /가상 역할 변경 업무/);
});
