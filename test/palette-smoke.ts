/**
 * Smoke tests for the colour palette and, above all, for `resolvePalette()`.
 *
 * Stored colours are NEVER rewritten in a sidecar — a mark keeps whatever fill
 * string it was created with, forever, and `resolvePalette()` is the only thing
 * that maps it back onto a current palette entry at paint time. That makes this
 * function the whole backward-compatibility contract for colour: if a
 * superseded fill stops resolving, every mark ever made with it silently loses
 * its ink, emoji, and painted alpha. Every palette change must add its outgoing
 * fills here and to LEGACY_FILL_TO_NAME.
 */
import assert from "node:assert/strict";
import { PALETTE, DEFAULT_COLOR, HL_COLORS, resolvePalette } from "../src/annotations";

// ---- current palette -------------------------------------------------------

{
  assert.deepEqual(
    PALETTE.map((p) => p.name),
    ["yellow", "blue", "mauve", "red"]
  );
  assert.deepEqual(
    PALETTE.map((p) => p.fill),
    ["#df8e1d", "#1e66f5", "#8839ef", "#e64553"]
  );
  assert.equal(DEFAULT_COLOR, "#df8e1d", "the first entry is what new marks get");
  assert.equal(HL_COLORS.mauve, "#8839ef");

  for (const p of PALETTE) {
    assert.equal(resolvePalette(p.fill), p, `${p.name} resolves to itself`);
    assert.ok(p.ink && p.emoji, `${p.name} has ink and emoji`);
    // These accent colours are dark; without an explicit alpha the renderer
    // would apply its 0.46 cap and the wash would fight the body text.
    assert.ok(
      typeof p.highlightAlpha === "number" && p.highlightAlpha > 0 && p.highlightAlpha <= 0.46,
      `${p.name} carries a sane explicit highlightAlpha`
    );
  }
}

// ---- superseded fills must still resolve -----------------------------------

{
  // The marker-like palette replaced by the accent colours above.
  assert.equal(resolvePalette("#FBF719")?.name, "yellow");
  assert.equal(resolvePalette("rgba(72, 158, 255, 0.42)")?.name, "blue");
  assert.equal(resolvePalette("rgba(246, 94, 82, 0.44)")?.name, "red");
  // "pink" was renamed to "mauve"; its stored fills must follow the rename or
  // PALETTE.find(name === "pink") returns undefined and the lookup yields null.
  assert.equal(resolvePalette("rgba(255, 76, 174, 0.46)")?.name, "mauve");
  assert.equal(resolvePalette("rgba(255, 130, 200, 0.42)")?.name, "mauve");

  // Older still — including the two greens that were folded into blue when
  // green left the palette.
  assert.equal(resolvePalette("rgba(255, 214, 0, 0.40)")?.name, "yellow");
  assert.equal(resolvePalette("rgba(232, 194, 76, 0.42)")?.name, "yellow");
  assert.equal(resolvePalette("rgba(255, 224, 46, 0.52)")?.name, "yellow");
  assert.equal(resolvePalette("rgba(106, 217, 126, 0.42)")?.name, "blue");
  assert.equal(resolvePalette("rgba(124, 178, 122, 0.42)")?.name, "blue");
  assert.equal(resolvePalette("rgba(90, 170, 255, 0.40)")?.name, "blue");
  assert.equal(resolvePalette("rgba(255, 110, 110, 0.42)")?.name, "red");

  // No legacy mapping may point at a name no live entry has.
  const names = new Set(PALETTE.map((p) => p.name));
  for (const legacy of [
    "#FBF719",
    "rgba(72, 158, 255, 0.42)",
    "rgba(255, 76, 174, 0.46)",
    "rgba(246, 94, 82, 0.44)",
    "rgba(255, 130, 200, 0.42)",
  ]) {
    const entry = resolvePalette(legacy);
    assert.ok(entry && names.has(entry.name), `${legacy} resolves to a live entry`);
  }
}

// ---- matching tolerance ----------------------------------------------------

{
  // Sidecars round-trip through JSON written by different builds, so spacing
  // must not decide whether a colour is recognised.
  assert.equal(resolvePalette("rgba(72,158,255,0.42)")?.name, "blue");
  assert.equal(resolvePalette("rgba(255,  76, 174, 0.46)")?.name, "mauve");
  // Hex matching is case-insensitive in the colour parser; resolvePalette
  // compares strings, so the stored casing is what has to match.
  assert.equal(resolvePalette("#df8e1d")?.name, "yellow");

  // A genuinely custom colour is not an error — it paints as given.
  assert.equal(resolvePalette("rgba(1, 2, 3, 0.5)"), null);
  assert.equal(resolvePalette("#123456"), null);
}

console.log("palette smoke tests passed");
