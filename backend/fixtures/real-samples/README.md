# Real factory Excel samples (drop zone)

Put the **real Yiwu daily-report / hanging-line Excel files** here, in their
**original, unmodified format**:

```
backend/fixtures/real-samples/
```

Ideally 1–3 files covering the real variety, e.g.:
- one hanging-line output export (吊挂线产量日报)
- one manager daily summary, if its layout differs
- any file that previously failed to import

**Privacy:** everything in this folder is git-ignored — the raw factory files
are **never committed**. After analysis, only *sanitized* copies (fake
factory/line/order names, scrambled numbers, same structure) are committed under
`backend/fixtures/` as regression-test fixtures.

Once the files are here, tell me and I'll:
1. Analyze each (file type, encoding, sheet/title/merged/multi-row headers,
   blank/footer rows, data-start row, required fields) — no guessing.
2. Implement parser support so they import **without changing the original format**.
3. Build sanitized fixtures + regression tests.
