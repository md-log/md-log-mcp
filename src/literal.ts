/**
 * Literal substring search that stays linear for ANY needle.
 *
 * Native String#indexOf (and split, which shares V8's search code) is linear for needles up to 250
 * characters — V8 runs a full Boyer-Moore over patterns that short. Longer needles get Boyer-Moore tables
 * over their last 250 characters only, and a needle whose distinguishing character sits further left
 * degrades to superlinear time: "a"x5000 + "b" + "a"x5000 over 4M "a" took 5 s, 7.7 s with the "b" a
 * quarter of the way in. Agents choose both the needle (edit_markdown's old_string, save_markdown's asset
 * placeholders) and the text, and the hosted server runs every tenant on one event loop, so one such call
 * stalled everyone.
 *
 * Long needles therefore use Knuth-Morris-Pratt, which reads each text character a bounded number of
 * times whatever the input. Whenever no partial match is in progress it jumps ahead with a native search
 * for the needle's first 250 characters — linear, as above — so ordinary searches keep native speed.
 */

/** Needles up to this length go straight to native indexOf (see the module comment). */
export const NATIVE_SEARCH_MAX_NEEDLE = 250;

/** Finds `needle` in a text: index of the first occurrence at or after `from`, or -1. */
export type LiteralFinder = (haystack: string, from: number) => number;

/** KMP failure table: entry i is the length of the longest proper prefix of needle[0..i] that is also its suffix. */
function failureTable(needle: string): Int32Array {
  const table = new Int32Array(needle.length);
  let k = 0;
  for (let i = 1; i < needle.length; i++) {
    const c = needle.charCodeAt(i);
    while (k > 0 && needle.charCodeAt(k) !== c) k = table[k - 1]!;
    if (needle.charCodeAt(k) === c) k++;
    table[i] = k;
  }
  return table;
}

/** The start position String#indexOf would use for `from`: NaN -> 0, fractions truncated, clamped. */
function startIndex(from: number, length: number): number {
  return Number.isNaN(from) ? 0 : Math.min(Math.max(Math.trunc(from), 0), length);
}

function kmpFinder(needle: string): LiteralFinder {
  const prefix = needle.slice(0, NATIVE_SEARCH_MAX_NEEDLE);
  const m = needle.length;
  // Built on first use: a needle that never fits the text, or whose prefix never occurs in it, must not
  // cost an Int32Array the size of the needle — ~100 MB for a document-sized old_string.
  let lazyTable: Int32Array | undefined;
  return (haystack, from) => {
    let i = startIndex(from, haystack.length);
    let q = 0; // characters of `needle` matched so far, ending just before haystack[i]
    // A match is possible only while the unread text can still complete one (falling back to a shorter
    // partial match never needs less text).
    while (haystack.length - i >= m - q) {
      if (q === 0) {
        // Nothing in progress: no match can start before the prefix's next occurrence, so skip there
        // natively and resume KMP as if those prefix characters had just been matched.
        const at = haystack.indexOf(prefix, i);
        if (at === -1 || haystack.length - at < m) return -1;
        lazyTable ??= failureTable(needle);
        i = at + prefix.length;
        q = prefix.length;
        continue;
      }
      const table = lazyTable!; // built by the jump that started this partial match
      const c = haystack.charCodeAt(i);
      while (q > 0 && needle.charCodeAt(q) !== c) q = table[q - 1]!;
      if (needle.charCodeAt(q) === c) q++;
      i++;
      if (q === m) return i - m;
    }
    return -1;
  };
}

/**
 * Build a finder for `needle`, reusable across calls — build one per needle and pass it around, so the
 * KMP table is built at most once. An empty needle never matches, mirroring the literal helpers'
 * empty-needle no-op. `from` is read the way String#indexOf reads it (NaN -> 0, fractions truncated).
 */
export function literalFinder(needle: string): LiteralFinder {
  if (needle.length === 0) return () => -1;
  if (needle.length <= NATIVE_SEARCH_MAX_NEEDLE) return (haystack, from) => haystack.indexOf(needle, from);
  return kmpFinder(needle);
}
