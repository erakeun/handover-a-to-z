/** Regenerate public-safe review fixtures. Requires macOS Swift/CoreText only for PDF generation. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDocument, stringifyDocument } from "../src/model.js";

const pdfURL = new URL("../fixtures/first-flow-safe.pdf", import.meta.url);
const moduleURL = new URL("../src/review-example.js", import.meta.url);
const cache = join(tmpdir(), "handover-review-synthetic-swift-cache");
await mkdir(cache, { recursive: true });
const result = spawnSync("swift", [
  "-module-cache-path", cache,
  fileURLToPath(new URL("./create-first-flow-pdf.swift", import.meta.url)),
  fileURLToPath(pdfURL),
], { encoding: "utf8", env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache } });
if (result.error || result.status !== 0) {
  throw new Error(`Synthetic PDF generation failed: ${result.error?.message ?? result.stderr}`);
}
const bytes = await readFile(pdfURL);
const moduleText = await readFile(moduleURL, "utf8");
const updated = moduleText.replace(
  /const REVIEW_PDF_BASE64 = "[^"]*";/u,
  `const REVIEW_PDF_BASE64 = "${bytes.toString("base64")}";`,
);
if (updated === moduleText && !moduleText.includes(bytes.toString("base64"))) {
  throw new Error("Cannot find the synthetic PDF payload marker");
}
await writeFile(moduleURL, updated);
const { reviewExampleDocument } = await import(`${moduleURL.href}?generated=${Date.now()}`);
const document = reviewExampleDocument();
const validation = validateDocument(document);
if (!validation.ok) throw new Error(validation.errors.join("\n"));
await writeFile(new URL("../fixtures/first-flow-synthetic.json", import.meta.url), stringifyDocument(document));
console.log(JSON.stringify({
  synthetic: true, pdfPages: 2, pdfBytes: bytes.length,
  groups: document.groups.length, tasks: document.tasks.length, cases: document.cases.length,
  images: document.tasks.flatMap((task) => task.images ?? []).length,
  validation: validation.ok, warnings: validation.warnings.length,
}));
