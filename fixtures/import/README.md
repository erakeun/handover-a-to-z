# Synthetic importer fixtures

These files are generated locally from invented text. No user documents, personal
information, or downloaded Office documents are included.

Run `node fixtures/import/generate.mjs` to reproduce them.

| File | Intended check |
| --- | --- |
| `synthetic-body-table.docx` | Body paragraphs, a 2×2 table, and HTML-like text kept literal |
| `synthetic-sections-table.hwpx` | Manifest section order differing from numeric order; table nested in a paragraph |
| `synthetic-slide-order.pptx` | Presentation relationship order differing from slide filename order |
| `synthetic-text-and-scan.pdf` | Two valid PDF pages: text on page 1, image only on page 2 |
| `synthetic-malformed.docx` | Deliberately truncated ZIP; must be rejected |
| `synthetic-legacy.hwp` | Binary HWP signature stub; rejected before parsing |

The XML packages are minimal extraction fixtures, not demonstrations of full
Office/Hancom authoring compatibility. Automated tests open their actual ZIP/XML
or PDF bytes. They do not claim visual equivalence or complete rendering support.
