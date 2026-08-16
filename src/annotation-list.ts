/**
 * annotation-list.ts — the pure part of the annotation list: ordering,
 * searching, the short labels each row shows, and the width band a list
 * container should render at.
 *
 * This is deliberately DOM-free and Obsidian-free (it only imports the
 * `Highlight` shape and the mark-style labels from annotations.ts) for the same
 * reason `pdf-bytes.ts` / `anchor.ts` are: it is the only part of the list that
 * can then be unit-tested headlessly (see test/annotation-list-smoke.ts), and
 * keeping the *rules* out of the renderer keeps the sidebar a placement
 * decision rather than something baked through the whole feature.
 *
 * Search is intentionally simple: fold case and collapse whitespace, then
 * require every space-separated term to appear somewhere in one joined haystack
 * per annotation. That makes "3 tag" mean "a tag on page 3" without any query
 * syntax. Note there is NO diacritic or hyphen folding here — unlike
 * anchor.ts's normalization, which strips them because it is matching text that
 * came out of a *different* pdf.js build. Here both sides of the comparison are
 * strings the user typed or wrote, so folding them would only cause surprise.
 */
import { MARK_STYLE_LABELS, markStyleOf, type Highlight } from "./annotations";

/**
 * How long the reveal bounce runs when a list entry is clicked. Both annotation
 * surfaces schedule the class removal off this, and it MUST match the
 * `lpa-flash` / `lpa-tag-flash` animation durations in styles.css — a shorter
 * timeout strips the class mid-animation and the mark snaps back mid-hop.
 */
export const FLASH_MS = 1000;

/**
 * How much horizontal room the list has. The native PDF sidebar starts at
 * 140px and is resized by a native drag handle we must not fight (its width
 * lives in a private pdf.js field and is persisted view state), so the list
 * adapts to the width it is given instead of asking for one.
 */
export type ListWidthBand = "tight" | "compact" | "roomy";

/** Below this, only a page badge and one clamped line of text fit. */
export const LIST_COMPACT_MIN_WIDTH = 160;
/** At or above this, secondary source text earns its space. */
export const LIST_ROOMY_MIN_WIDTH = 260;

export function widthBandFor(width: number): ListWidthBand {
  if (!Number.isFinite(width) || width < LIST_COMPACT_MIN_WIDTH) return "tight";
  if (width < LIST_ROOMY_MIN_WIDTH) return "compact";
  return "roomy";
}

export function annotationTypeOf(h: Highlight): "highlight" | "tag" {
  // Marks written before page notes existed have no `type` at all.
  return h.type === "tag" ? "tag" : "highlight";
}

export function annotationColor(h: Highlight): string {
  return h.tagColor ?? h.color;
}

export function tagPreview(h: Highlight): string {
  const raw = (h.note || h.text || "Note").replace(/\bnote:\s*/gi, " ").replace(/\s+/g, " ").trim();
  const words = raw.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  return words || "Note";
}

export function annotationKindLabel(h: Highlight): string {
  if (annotationTypeOf(h) === "tag") return "tag";
  // Legacy marks carry no `style`; markStyleOf() degrades them to "highlight".
  const st = markStyleOf(h);
  return st === "highlight" ? "highlight" : MARK_STYLE_LABELS[st].toLowerCase();
}

export function shortAnnotationText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** The row's headline: the user's own words if there are any, else the quote. */
export function listPrimaryText(h: Highlight): string {
  const text = (h.note || h.noteContentCJK || h.text || tagPreview(h)).replace(/\s+/g, " ").trim();
  return shortAnnotationText(text || "Untitled note", 160);
}

/** What the headline left out — shown only in the roomy band. */
export function listSecondaryText(h: Highlight): string {
  const chunks: string[] = [];
  if (h.note && h.noteContentCJK) chunks.push(h.noteContentCJK);
  if (annotationTypeOf(h) === "highlight" && h.text) chunks.push(h.text);
  return shortAnnotationText(chunks.join("  "), 180);
}

/** Reading order: down the document, then by creation within a page. */
export function sortForList(highlights: readonly Highlight[]): Highlight[] {
  return [...highlights].sort((a, b) => a.page - b.page || a.created.localeCompare(b.created));
}

export function normalizeSearch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function annotationMatchesSearch(h: Highlight, query: string): boolean {
  const haystack = [
    `p.${h.page + 1}`,
    String(h.page + 1),
    annotationKindLabel(h),
    h.note,
    h.noteContentCJK,
    h.text,
    tagPreview(h),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return query.split(" ").every((part) => haystack.includes(part));
}

/** `query` is raw user input; an empty or whitespace-only query matches all. */
export function filterForList(highlights: readonly Highlight[], query: string): Highlight[] {
  const normalized = normalizeSearch(query);
  if (!normalized) return [...highlights];
  return highlights.filter((h) => annotationMatchesSearch(h, normalized));
}
