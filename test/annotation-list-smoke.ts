/**
 * Smoke tests for the pure part of the annotation list (src/annotation-list.ts).
 *
 * The list is rendered into two different hosts (Obsidian's native PDF sidebar
 * and our floating panel), so the ordering/search/label rules are the one part
 * that must not fork — and the only part testable without a DOM.
 */
import assert from "node:assert/strict";
import {
  annotationKindLabel,
  filterForList,
  listPrimaryText,
  listSecondaryText,
  normalizeSearch,
  sortForList,
  widthBandFor,
  LIST_COMPACT_MIN_WIDTH,
  LIST_ROOMY_MIN_WIDTH,
} from "../src/annotation-list";
import type { Highlight } from "../src/annotations";

function mark(over: Partial<Highlight> = {}): Highlight {
  return {
    id: over.id ?? "id",
    page: 0,
    color: "rgba(255,212,0,0.35)",
    text: "",
    rects: [],
    created: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ---- sortForList -----------------------------------------------------------

{
  const a = mark({ id: "a", page: 4, created: "2026-01-01T00:00:00.000Z" });
  const b = mark({ id: "b", page: 0, created: "2026-01-03T00:00:00.000Z" });
  const c = mark({ id: "c", page: 0, created: "2026-01-02T00:00:00.000Z" });
  const sorted = sortForList([a, b, c]);
  assert.deepEqual(
    sorted.map((h) => h.id),
    ["c", "b", "a"],
    "page order first, then creation time within a page"
  );

  const input = [a, b, c];
  sortForList(input);
  assert.deepEqual(
    input.map((h) => h.id),
    ["a", "b", "c"],
    "sortForList must not mutate its input (the store's array is live)"
  );
}

// ---- annotationKindLabel: legacy marks -------------------------------------

{
  // Sidecars written before the style axis existed carry neither field.
  assert.equal(annotationKindLabel(mark()), "highlight");
  assert.equal(annotationKindLabel(mark({ style: "strike" })), "strikethrough");
  assert.equal(annotationKindLabel(mark({ style: "dashed" })), "dashed underline");
  assert.equal(annotationKindLabel(mark({ type: "tag" })), "tag");
  // An unknown style must degrade rather than throw on MARK_STYLE_LABELS[undefined].
  assert.equal(annotationKindLabel(mark({ style: "bogus" as never })), "highlight");
}

// ---- normalizeSearch -------------------------------------------------------

{
  assert.equal(normalizeSearch("  Two   Words \n"), "two words");
  assert.equal(normalizeSearch("   "), "");
  // No diacritic or hyphen folding here, unlike anchor.ts's normalization.
  assert.equal(normalizeSearch("Café-au-lait"), "café-au-lait");
}

// ---- filterForList ---------------------------------------------------------

{
  const quoted = mark({ id: "quoted", page: 2, text: "Attention Is All You Need" });
  const noted = mark({ id: "noted", page: 7, note: "revisit this derivation" });
  const tag = mark({ id: "tag", page: 2, type: "tag", note: "check the appendix" });
  const all = [quoted, noted, tag];

  assert.equal(filterForList(all, "").length, 3, "empty query matches everything");
  assert.equal(filterForList(all, "   ").length, 3, "whitespace-only query matches everything");
  assert.equal(filterForList(all, "zzzz").length, 0);

  assert.deepEqual(
    filterForList(all, "attention").map((h) => h.id),
    ["quoted"],
    "matches quoted text, case-insensitively"
  );
  assert.deepEqual(
    filterForList(all, "DERIVATION").map((h) => h.id),
    ["noted"],
    "matches the note, case-insensitively"
  );

  // Page numbers are searchable both bare and with the p. prefix.
  assert.deepEqual(
    filterForList(all, "p.8").map((h) => h.id),
    ["noted"],
    "page is searchable 1-based"
  );
  assert.deepEqual(
    filterForList(all, "3").map((h) => h.id).sort(),
    ["quoted", "tag"],
    "bare page number matches too"
  );

  // Terms are ANDed and may land in different fields of the same annotation.
  assert.deepEqual(
    filterForList(all, "3 tag").map((h) => h.id),
    ["tag"],
    "page number AND kind label, from different fields"
  );
  assert.equal(filterForList(all, "3 attention need").length, 1);
  assert.equal(filterForList(all, "3 derivation").length, 0, "AND, not OR");

  const source = [quoted];
  filterForList(source, "attention");
  assert.equal(source.length, 1, "filterForList must not mutate its input");
}

// ---- listPrimaryText / listSecondaryText -----------------------------------

{
  // The user's own words win over the quote.
  assert.equal(listPrimaryText(mark({ note: "my note", text: "the quote" })), "my note");
  assert.equal(listPrimaryText(mark({ text: "the quote" })), "the quote");
  assert.equal(listPrimaryText(mark({ type: "tag" })), "Note");
  assert.equal(
    listPrimaryText(mark({ text: "ragged\n  whitespace   here" })),
    "ragged whitespace here"
  );

  const long = "x".repeat(400);
  const clipped = listPrimaryText(mark({ text: long }));
  assert.equal(clipped.length, 160);
  assert.ok(clipped.endsWith("…"));

  // The secondary line carries what the headline left out, and nothing more.
  assert.equal(listSecondaryText(mark({ note: "my note", text: "the quote" })), "the quote");
  assert.equal(listSecondaryText(mark({ text: "the quote" })), "the quote");
  assert.equal(
    listSecondaryText(mark({ type: "tag", note: "my note" })),
    "",
    "a tag has no quoted source to show"
  );
}

// ---- widthBandFor ----------------------------------------------------------

{
  assert.equal(widthBandFor(0), "tight");
  assert.equal(widthBandFor(140), "tight", "the native sidebar's default width");
  assert.equal(widthBandFor(LIST_COMPACT_MIN_WIDTH - 1), "tight");
  assert.equal(widthBandFor(LIST_COMPACT_MIN_WIDTH), "compact");
  assert.equal(widthBandFor(LIST_ROOMY_MIN_WIDTH - 1), "compact");
  assert.equal(widthBandFor(LIST_ROOMY_MIN_WIDTH), "roomy");
  assert.equal(widthBandFor(900), "roomy");
  assert.equal(widthBandFor(Number.NaN), "tight", "an unmeasurable panel must not throw");
}

console.log("annotation-list smoke tests passed");
