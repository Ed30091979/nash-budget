/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isStorableLabel,
  isStorableNote,
  normalizeCategoryName,
  normalizeLabel,
  normalizeNote,
  normalizeTagName,
  STORED_TEXT_EDGE_WHITESPACE,
  STORED_TEXT_FORBIDDEN,
  TAG_NAME_MAX_LENGTH,
} from "../src/index.js";

/** Whatever the input rule makes of `value`, or undefined when it refuses it. */
function attempt(run: () => string | undefined): string | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

/** A small deterministic generator, so the random walk is the same walk on every run. */
function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Holds a note to the promise: what the input rule makes of it is stored text. */
function expectStorableNote(sample: string): number {
  const note = attempt(() => normalizeNote(sample));
  if (note === undefined) return 0;
  if (!isStorableNote(note)) expect.fail(`normalizeNote(${JSON.stringify(sample)}) is not storable`);
  return 1;
}

/** The same for a label, through every input rule that produces one. */
function expectStorableLabel(sample: string): number {
  let checked = 0;
  for (const label of [attempt(() => normalizeLabel(sample, TAG_NAME_MAX_LENGTH)), attempt(() => normalizeTagName(sample)), attempt(() => normalizeCategoryName(sample))]) {
    if (label === undefined) continue;
    if (!isStorableLabel(label, 80)) expect.fail(`label ${JSON.stringify(sample)} is not storable`);
    checked += 1;
  }
  return checked;
}

function expectStorable(sample: string): number {
  return expectStorableNote(sample) + expectStorableLabel(sample);
}

describe("stored text", () => {
  it("accepts everything the input rule produces, over the whole Basic Multilingual Plane", () => {
    let checked = 0;
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = String.fromCharCode(code);
      checked += expectStorableNote(`Заметка ${character} конец`);
      checked += expectStorableLabel(`Дача${character}`);
    }
    expect(checked).toBeGreaterThan(150_000);
  }, 60_000);

  it("accepts everything the input rule produces outside the plane, sampled", () => {
    let checked = 0;
    const blocks: number[] = [0x16d67, 0x1bca0, 0x1d173, 0x1f334, 0x1f468, 0xe0001, 0xe0020, 0xe0080, 0xe0100, 0x10fffd];
    for (let code = 0x10000; code <= 0x10ffff; code += 97) blocks.push(code);
    for (const code of blocks) {
      const character = String.fromCodePoint(code);
      for (const sample of [`Заметка ${character} конец`, `${character}${character}`, `Дача${character}`]) {
        checked += expectStorable(sample);
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("accepts every combining sequence the input rule produces, presentation selectors included", () => {
    const bases = ["A", "a", "e", "и", "е", "Ч", "1", " ", "\u2764", "\u{1f334}", "\u3131"];
    const marks = ["\u0301", "\u0306", "\u0308", "\u030a", "\u0327", "\u0323\u0302", "\u0302\u0323", "\u05b4", "\u0e31", "\u{16d67}"];
    const selectors = ["", "\ufe0e", "\ufe0f", "\ufe0f\ufe0f", "\u200d", "\u034f"];
    let checked = 0;
    for (const base of bases) {
      for (const mark of marks) {
        for (const selector of selectors) {
          for (const sample of [`${base}${selector}${mark}`, `кофе ${base}${mark}${selector} дома`, `${selector}${base}${mark}${mark}`]) {
            checked += expectStorable(sample);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it("accepts every random string the input rule produces", () => {
    const pool = [
      "а", "Я", "z", "Q", "7", " ", "\u00a0", "\u3000", "\u0301", "\u030a", "\ufe0f", "\ufe0e", "\u200d", "\u200b", "\u202e",
      "\u2066", "\u00ad", "\u2028", "\t", "\n", "\u0000", "\u{1f334}", "\u2764", "\ud83d", "\ude00", "\ufeff", "\u0378",
      "\ua7cd", "\u{16d67}", "\u05d0", "\u0627", "\u0e01", "\u4e2d", "\u0130", "\u212b", "\u00c5", "A",
    ];
    const random = mulberry32(42);
    let checked = 0;
    for (let attemptIndex = 0; attemptIndex < 20_000; attemptIndex += 1) {
      const length = 1 + Math.floor(random() * 12);
      let sample = "";
      for (let index = 0; index < length; index += 1) sample += pool[Math.floor(random() * pool.length)]!;
      checked += expectStorable(sample);
    }
    expect(checked).toBeGreaterThan(5_000);
  });

  it("accepts what a newer Unicode composes, assigns or has not assigned yet", () => {
    // U+A7CD is a letter of Unicode 16; U+16D67 pairs compose under NFC only from Unicode 16 on;
    // U+0378 is assigned in no version. Stored text must mean the same thing on every engine.
    expect(isStorableLabel("Дача\ua7cd", TAG_NAME_MAX_LENGTH)).toBe(true);
    expect(isStorableNote("кофе \u{16d67}\u{16d67}")).toBe(true);
    expect(isStorableNote("заметка \u0378 конец")).toBe(true);
    expect(isStorableLabel("\u0378", TAG_NAME_MAX_LENGTH)).toBe(true);
    // No normal form and no alphabet rule: those are the input rule's business.
    expect(isStorableLabel("A\u030a", TAG_NAME_MAX_LENGTH)).toBe(true);
    expect(isStorableLabel("Дом Home", TAG_NAME_MAX_LENGTH)).toBe(true);
    expect(isStorableNote("\u{1f334}")).toBe(true);
  });

  it("refuses every listed code point, an unpaired surrogate and whitespace at either end", () => {
    for (const [first, last] of STORED_TEXT_FORBIDDEN) {
      for (const code of [first, last]) {
        const character = String.fromCodePoint(code);
        expect(isStorableNote(`до ${character} после`), code.toString(16)).toBe(false);
        expect(isStorableLabel(`До${character}м`, TAG_NAME_MAX_LENGTH), code.toString(16)).toBe(false);
      }
    }
    for (const lone of ["\ud83d", "\ude00", "\ude00\ud83d", "a\ud83d", "\ud83db"]) {
      expect(isStorableNote(`до ${lone} после`), JSON.stringify(lone)).toBe(false);
    }
    for (const code of STORED_TEXT_EDGE_WHITESPACE) {
      const space = String.fromCharCode(code);
      expect(isStorableNote(`${space}Пятёрочка`), code.toString(16)).toBe(false);
      expect(isStorableNote(`Пятёрочка${space}`), code.toString(16)).toBe(false);
      expect(isStorableLabel(`${space}Дом`, TAG_NAME_MAX_LENGTH), code.toString(16)).toBe(false);
    }
    // Inside a note a space is a space.
    expect(isStorableNote("Пятёрочка у\u00a0дома")).toBe(true);
  });

  it("refuses an empty value, a value that is too long and a value that is not text", () => {
    expect(isStorableNote("")).toBe(false);
    expect(isStorableNote("я".repeat(500))).toBe(true);
    expect(isStorableNote("я".repeat(501))).toBe(false);
    expect(isStorableLabel("я".repeat(40), TAG_NAME_MAX_LENGTH)).toBe(true);
    expect(isStorableLabel("я".repeat(41), TAG_NAME_MAX_LENGTH)).toBe(false);
    for (const value of [null, undefined, 42, ["Дом"], { name: "Дом" }]) {
      expect(isStorableNote(value)).toBe(false);
      expect(isStorableLabel(value, TAG_NAME_MAX_LENGTH)).toBe(false);
    }
  });

  it("lists its ranges in order and without overlap", () => {
    for (let index = 0; index < STORED_TEXT_FORBIDDEN.length; index += 1) {
      const [first, last] = STORED_TEXT_FORBIDDEN[index]!;
      expect(first).toBeLessThanOrEqual(last);
      if (index > 0) expect(first).toBeGreaterThan(STORED_TEXT_FORBIDDEN[index - 1]![1]);
    }
  });

  it("asks the engine nothing: no Unicode property escape and no normalisation in its source", () => {
    const source = readFileSync(new URL("../src/stored-text.ts", import.meta.url), "utf8");
    expect(source).not.toContain("\\p{");
    expect(source).not.toContain("\\P{");
    expect(source).not.toContain("normalize(");
    expect(source).not.toContain("toLocale");
    expect(source).not.toContain("Intl.");
  });
});
