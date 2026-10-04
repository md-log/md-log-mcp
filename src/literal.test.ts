import { describe, expect, it } from "vitest";
import { literalFinder, NATIVE_SEARCH_MAX_NEEDLE } from "./literal.js";
import { countLiteral, replaceAllLiteral, replaceFirstLiteral } from "./path.js";

/**
 * literalFinder must be a drop-in for String#indexOf — same answers for every needle — while staying
 * linear for long needles, where V8's own search goes superlinear (see literal.ts).
 */

/** Deterministic PRNG (mulberry32) so a failing random case reproduces exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(next: () => number, length: number, alphabet: string): string {
  return Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
}

/** Obviously-correct reference: try every start position. */
function naiveIndexOf(haystack: string, needle: string, from: number): number {
  for (let i = Math.max(0, from); i + needle.length <= haystack.length; i++) {
    if (haystack.startsWith(needle, i)) return i;
  }
  return -1;
}

describe("literalFinder", () => {
  it("agrees with a naive search on random long and short needles, including overlapping matches", () => {
    const next = rng(20261005);
    for (let round = 0; round < 400; round++) {
      // A 2-3 letter alphabet makes partial matches, repeats and overlaps common.
      const alphabet = round % 2 === 0 ? "ab" : "abc";
      const text = randomString(next, 600 + Math.floor(next() * 900), alphabet);
      const length = 1 + Math.floor(next() * (NATIVE_SEARCH_MAX_NEEDLE + 150));
      // Half the needles are cut from the text, so they are guaranteed to occur at least once.
      const start = Math.floor(next() * Math.max(1, text.length - length));
      const needle = next() < 0.5 ? text.slice(start, start + length) : randomString(next, length, alphabet);
      const find = literalFinder(needle);
      for (const from of [0, 1, start, start + 1, Math.floor(next() * text.length), text.length]) {
        expect(find(text, from)).toBe(naiveIndexOf(text, needle, from));
      }
    }
  });

  it("agrees with a naive search on near-periodic text, where KMP has to fall back on long partial matches", () => {
    // Random text rarely matches 250+ characters and then fails, so it barely exercises the failure table.
    // A repeated short unit with a few flipped characters makes long partial matches the norm.
    const next = rng(42);
    const flip = (s: string, times: number) =>
      Array.from({ length: times }).reduce<string>((acc) => {
        const at = Math.floor(next() * acc.length);
        return acc.slice(0, at) + "abc"[Math.floor(next() * 3)] + acc.slice(at + 1);
      }, s);
    for (let round = 0; round < 400; round++) {
      const unit = randomString(next, 1 + Math.floor(next() * 4), "ab");
      const text = flip(unit.repeat(Math.ceil(1500 / unit.length)), Math.floor(next() * 6));
      const length = NATIVE_SEARCH_MAX_NEEDLE + 1 + Math.floor(next() * 350);
      const start = Math.floor(next() * (text.length - length));
      const needle = flip(text.slice(start, start + length), next() < 0.5 ? 0 : 1);
      const find = literalFinder(needle);
      for (const from of [0, 1, start, start + 1, Math.floor(next() * text.length)]) {
        expect(find(text, from)).toBe(naiveIndexOf(text, needle, from));
      }
    }
  });

  it("finds a long needle at the very start and the very end", () => {
    const needle = "x".repeat(NATIVE_SEARCH_MAX_NEEDLE) + "yz";
    const find = literalFinder(needle);
    expect(find(needle + "tail", 0)).toBe(0);
    expect(find("head" + needle, 0)).toBe(4);
    expect(find("head" + needle, 5)).toBe(-1);
  });

  it("never matches an empty needle and treats a negative start as 0", () => {
    expect(literalFinder("")("abc", 0)).toBe(-1);
    const long = "q".repeat(NATIVE_SEARCH_MAX_NEEDLE + 1);
    expect(literalFinder(long)(long, -5)).toBe(0);
  });

  it("reads `from` exactly like String#indexOf (NaN, fractions, infinities, out of range)", () => {
    const long = "ab".repeat(200) + "c"; // 401 chars: the KMP path
    const text = `xx${long}yy${long}zz`;
    for (const needle of [long, "abc"]) {
      for (const from of [Number.NaN, 2.5, 3.9, -1e9, -Infinity, Infinity, text.length, text.length + 1]) {
        expect(literalFinder(needle)(text, from)).toBe(text.indexOf(needle, from));
      }
    }
  });

  it("answers at once, without building the KMP table, when the needle cannot fit the text", () => {
    // A document-sized old_string against a short document used to allocate ~95 MB just to say "no".
    const giant = "x".repeat(20_000_000);
    const started = performance.now();
    expect(literalFinder(giant)("tiny doc", 0)).toBe(-1);
    expect(literalFinder(giant)("x".repeat(1000), 0)).toBe(-1);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("literal helpers with long needles", () => {
  const block = "lorem ipsum ".repeat(30); // 360 chars: takes the long-needle path

  it("counts, replaces the first, and replaces all non-overlapping occurrences", () => {
    const text = `A ${block} B ${block} C`;
    expect(countLiteral(text, block)).toBe(2);
    expect(replaceFirstLiteral(text, block, "X")).toBe(`A X B ${block} C`);
    expect(replaceAllLiteral(text, block, "$&")).toBe("A $& B $& C");
  });

  it("matches split()/join() semantics on overlapping repeats", () => {
    const unit = "ab".repeat(NATIVE_SEARCH_MAX_NEEDLE); // 500 chars
    const text = unit + unit.slice(0, 250); // the needle overlaps itself at every even offset
    expect(replaceAllLiteral(text, unit, "#")).toBe(text.split(unit).join("#"));
    expect(countLiteral(text, unit)).toBe(text.split(unit).length - 1);
  });
});

describe("adversarial long needles stay linear", () => {
  // Native indexOf took ~5 s on 4M chars for this needle (7.7 s with the "b" a quarter of the way in).
  const side = "a".repeat(5000);
  const needle = side + "b" + side;
  const text = "a".repeat(4_000_000) + needle;
  const fast = (fn: () => unknown) => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };

  it("finds, counts and replaces in well under a second", () => {
    expect(fast(() => expect(literalFinder(needle)(text, 0)).toBe(4_000_000))).toBeLessThan(1000);
    expect(fast(() => expect(countLiteral(text, needle)).toBe(1))).toBeLessThan(1000);
    expect(fast(() => expect(replaceAllLiteral(text, needle, "!").length).toBe(4_000_001))).toBeLessThan(1000);
  });

  it("gives up on an absent adversarial needle just as fast", () => {
    const quarter = "a".repeat(2500) + "b" + "a".repeat(7500);
    expect(fast(() => expect(literalFinder(quarter)(text, 0)).toBe(-1))).toBeLessThan(1000);
  });
});
