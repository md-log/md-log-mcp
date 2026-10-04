import { describe, expect, it } from "vitest";
import { MdlogError } from "./client.js";
import { afterConcurrentWrite, applyLiteralEdits, MAX_EDITS, resolveEdits } from "./edit.js";

/**
 * edit_markdown's batch mode collapses N literal edits into ONE write (one version, one notification).
 * The contract that keeps that safe is all-or-nothing: every edit is validated against the text produced
 * by the edits before it, and any failure aborts the whole batch before anything is written.
 */
function rejectsWith(fn: () => unknown, reason: string, editIndex?: number): MdlogError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MdlogError);
    const e = err as MdlogError;
    expect(e.code).toBe("VALIDATION");
    const detail = e.detail as Record<string, unknown> | undefined;
    expect(detail?.reason).toBe(reason);
    if (editIndex !== undefined) expect(detail?.edit_index).toBe(editIndex);
    return e;
  }
  throw new Error(`expected a VALIDATION error with reason ${reason}`);
}

describe("applyLiteralEdits", () => {
  it("applies a single edit exactly like the one-shot mode", () => {
    const out = applyLiteralEdits("a\nb\nc\n", [{ old_string: "b", new_string: "B" }]);
    expect(out.content).toBe("a\nB\nc\n");
    expect(out.results).toEqual([{ occurrences: 1, replaced: 1, replace_all: false }]);
  });

  it("applies several edits in order and reports each one", () => {
    const out = applyLiteralEdits("| ttl | 30d |\n\nconclusion: tbd\n", [
      { old_string: "| ttl | 30d |", new_string: "| ttl | 14d |" },
      { old_string: "conclusion: tbd", new_string: "conclusion: shipped" },
    ]);
    expect(out.content).toBe("| ttl | 14d |\n\nconclusion: shipped\n");
    expect(out.results).toHaveLength(2);
  });

  it("matches each edit against the result of the edits before it", () => {
    // The second edit targets text that only exists after the first one ran.
    const out = applyLiteralEdits("draft", [
      { old_string: "draft", new_string: "final v1" },
      { old_string: "v1", new_string: "v2" },
    ]);
    expect(out.content).toBe("final v2");
  });

  it("supports replace_all per edit", () => {
    const out = applyLiteralEdits("foo foo bar", [
      { old_string: "foo", new_string: "baz", replace_all: true },
      { old_string: "bar", new_string: "qux" },
    ]);
    expect(out.content).toBe("baz baz qux");
    expect(out.results[0]).toEqual({ occurrences: 2, replaced: 2, replace_all: true });
  });

  it("inserts '$' sequences literally", () => {
    const out = applyLiteralEdits("price", [{ old_string: "price", new_string: "$& $1 $'" }]);
    expect(out.content).toBe("$& $1 $'");
  });

  it("rejects the whole batch when a later edit does not match", () => {
    rejectsWith(
      () =>
        applyLiteralEdits("alpha beta", [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "gamma", new_string: "GAMMA" },
        ]),
      "NO_MATCH",
      1,
    );
  });

  it("rejects an edit whose text was consumed by an earlier edit", () => {
    rejectsWith(
      () =>
        applyLiteralEdits("alpha", [
          { old_string: "alpha", new_string: "omega" },
          { old_string: "alpha", new_string: "again" },
        ]),
      "NO_MATCH",
      1,
    );
  });

  it("rejects an ambiguous edit without replace_all", () => {
    rejectsWith(() => applyLiteralEdits("x x", [{ old_string: "x", new_string: "y" }]), "AMBIGUOUS_MATCH", 0);
  });

  it("explains an ambiguity that an earlier edit created", () => {
    const err = rejectsWith(
      () =>
        applyLiteralEdits("tag", [
          { old_string: "tag", new_string: "tag tag" },
          { old_string: "tag", new_string: "label" },
        ]),
      "AMBIGUOUS_MATCH",
      1,
    );
    expect(err.message).toContain("after applying the edits before it");
  });

  describe("overlapping matches", () => {
    it("treats an overlapping repeat as ambiguous: \\n\\n inside \\n\\n\\n could mean either pair", () => {
      const err = rejectsWith(
        () => applyLiteralEdits("intro\n\n\nbody", [{ old_string: "\n\n", new_string: "\n" }]),
        "AMBIGUOUS_MATCH",
        0,
      );
      expect(err.detail).toMatchObject({ occurrences: 1, overlapping: true });
      expect(err.message).toContain("overlapping");
    });

    it("still accepts a run that occurs exactly once", () => {
      expect(applyLiteralEdits("intro\n\nbody", [{ old_string: "\n\n", new_string: "\n" }]).content).toBe("intro\nbody");
    });

    it("keeps replace_all left-to-right and non-overlapping", () => {
      const out = applyLiteralEdits("aaa", [{ old_string: "aa", new_string: "X", replace_all: true }]);
      expect(out.content).toBe("Xa");
      expect(out.results[0]).toEqual({ occurrences: 1, replaced: 1, replace_all: true });
    });
  });

  it("applies an adversarial long old_string in linear time", () => {
    // Native indexOf needs ~5 s on 4M chars for this needle; reverting applyOne to it must fail here.
    const side = "a".repeat(5000);
    const needle = side + "b" + side;
    const doc = "a".repeat(4_000_000) + needle;
    const started = performance.now();
    const out = applyLiteralEdits(doc, [{ old_string: needle, new_string: "X" }]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.content.length).toBe(4_000_001);
  });

  it("edits with an old_string longer than the native-search limit", () => {
    const section = "| row | value |\n".repeat(40); // 640 chars: the linear-search path
    const out = applyLiteralEdits(`# T\n${section}end`, [{ old_string: section, new_string: "(table)\n" }]);
    expect(out.content).toBe("# T\n(table)\nend");
  });

  it("rejects an edit whose old_string equals its new_string", () => {
    rejectsWith(
      () => applyLiteralEdits("same", [{ old_string: "same", new_string: "same" }]),
      "IDENTICAL_STRINGS",
      0,
    );
  });

  it("rejects an empty old_string", () => {
    rejectsWith(() => applyLiteralEdits("a", [{ old_string: "", new_string: "b" }]), "EMPTY_OLD_STRING", 0);
  });

  it("rejects a batch that ends up byte-identical to the original", () => {
    rejectsWith(
      () =>
        applyLiteralEdits("on", [
          { old_string: "on", new_string: "off" },
          { old_string: "off", new_string: "on" },
        ]),
      "NO_CHANGE",
    );
  });

  it("rejects an empty batch and an oversized batch", () => {
    rejectsWith(() => applyLiteralEdits("a", []), "EMPTY_EDITS");
    const many = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({
      old_string: `k${i}`,
      new_string: `v${i}`,
    }));
    rejectsWith(() => applyLiteralEdits("a", many), "TOO_MANY_EDITS");
  });

  it("does not mutate the caller's edits array", () => {
    const edits = Object.freeze([Object.freeze({ old_string: "a", new_string: "b" })]);
    expect(applyLiteralEdits("a", edits).content).toBe("b");
  });

  describe("size guard", () => {
    it("stops geometric replace_all growth before building the oversized text", () => {
      // 28 doublings is the 2^28-char payload that used to abort V8; the guard cuts it off at the
      // first step whose RESULT would pass the cap (2^10 = 1024 > 1000), before that string exists.
      const doubling = Array.from({ length: 28 }, () => ({ old_string: "a", new_string: "aa", replace_all: true }));
      const err = rejectsWith(
        () => applyLiteralEdits("a", doubling, "r.md", { maxBytes: 1000 }),
        "DOCUMENT_TOO_LARGE",
        9,
      );
      expect(err.detail).toMatchObject({ min_bytes: 1024, max_bytes: 1000 });
    });

    it("allows a result exactly at the cap and rejects one unit over it", () => {
      const at = applyLiteralEdits("ab", [{ old_string: "b", new_string: "bcd" }], "r.md", { maxBytes: 4 });
      expect(at.content).toBe("abcd");
      rejectsWith(
        () => applyLiteralEdits("ab", [{ old_string: "b", new_string: "bcde" }], "r.md", { maxBytes: 4 }),
        "DOCUMENT_TOO_LARGE",
        0,
      );
    });

    it("lets a shrinking edit through even when the document is already near the cap", () => {
      const out = applyLiteralEdits("abcd", [{ old_string: "bcd", new_string: "" }], "r.md", { maxBytes: 4 });
      expect(out.content).toBe("a");
    });
  });

  describe("replacement budget", () => {
    const flip = (from: string, to: string) => ({ old_string: from, new_string: to, replace_all: true });

    it("rejects chained replace_all passes once their total passes the budget", () => {
      // 4 + 4 = 8 replacements against a budget of 6: refused at the second pass, before it runs.
      const err = rejectsWith(
        () => applyLiteralEdits("aaaa", [flip("a", "b"), flip("b", "c")], "r.md", { maxReplacements: 6 }),
        "TOO_MANY_REPLACEMENTS",
        1,
      );
      expect(err.detail).toMatchObject({ replaced: 8, max_replacements: 6 });
    });

    it("allows a batch exactly at the budget", () => {
      const out = applyLiteralEdits("aaaa", [flip("a", "b"), flip("b", "c")], "r.md", { maxReplacements: 8 });
      expect(out.content).toBe("cccc");
    });

    it("fits one replace_all over every character of a cap-sized document (the pre-batch maximum)", () => {
      // The default budget equals the cap, so the most a single pre-batch edit could ever do still fits.
      const limits = { maxBytes: 8, maxReplacements: 8 };
      expect(applyLiteralEdits("a".repeat(8), [flip("a", "b")], "r.md", limits).content).toBe("b".repeat(8));
    });
  });

  describe("time budget", () => {
    /** A clock that advances `stepMs` every time it is read. */
    const ticking = (stepMs: number) => {
      let t = 0;
      return () => (t += stepMs);
    };
    const abc = [
      { old_string: "a", new_string: "A" },
      { old_string: "b", new_string: "B" },
      { old_string: "c", new_string: "C" },
    ];

    it("stops a batch between edits once the budget is spent, before searching again", () => {
      // startedAt=1000; before edit 1: 2000 (1000 elapsed, OK); before edit 2: 3000 (2000 elapsed > 1500).
      const err = rejectsWith(
        () => applyLiteralEdits("a b c", abc, "r.md", { maxMillis: 1500, now: ticking(1000) }),
        "BATCH_TOO_SLOW",
        2,
      );
      expect(err.detail).toMatchObject({ elapsed_ms: 2000, max_ms: 1500 });
    });

    it("never stops the first edit, so a single edit costs what it did before batching", () => {
      const out = applyLiteralEdits("a", [abc[0]!], "r.md", { maxMillis: 0, now: ticking(1000) });
      expect(out.content).toBe("A");
    });

    it("lets a fast batch through on the real clock", () => {
      expect(applyLiteralEdits("a b c", abc).content).toBe("A B C");
    });
  });
});

describe("resolveEdits", () => {
  it("passes a batch through untouched", () => {
    const edits = [{ old_string: "a", new_string: "b" }];
    expect(resolveEdits({ edits }, "r.md")).toBe(edits);
  });

  it("wraps the single-edit shorthand into a one-item batch", () => {
    expect(resolveEdits({ old_string: "a", new_string: "", replace_all: true }, "r.md")).toEqual([
      { old_string: "a", new_string: "", replace_all: true },
    ]);
  });

  it("ignores empty shorthand defaults sent next to a batch", () => {
    const edits = [{ old_string: "a", new_string: "b" }];
    expect(resolveEdits({ edits, old_string: "", new_string: "", replace_all: false }, "r.md")).toBe(edits);
  });

  it("rejects a meaningful shorthand value next to a batch", () => {
    const edits = [{ old_string: "a", new_string: "b" }];
    rejectsWith(() => resolveEdits({ edits, old_string: "c", new_string: "d" }, "r.md"), "MIXED_INPUT");
    rejectsWith(() => resolveEdits({ edits, replace_all: true }, "r.md"), "MIXED_INPUT");
  });

  it("rejects a shorthand without new_string, and an empty input", () => {
    rejectsWith(() => resolveEdits({ old_string: "a" }, "r.md"), "MISSING_EDIT");
    rejectsWith(() => resolveEdits({}, "r.md"), "MISSING_EDIT");
  });

  it("validates edit shapes without needing the document", () => {
    rejectsWith(() => resolveEdits({ edits: [] }, "r.md"), "EMPTY_EDITS");
    rejectsWith(
      () => resolveEdits({ edits: [{ old_string: "x", new_string: "y" }, { old_string: "z", new_string: "z" }] }, "r.md"),
      "IDENTICAL_STRINGS",
      1,
    );
    rejectsWith(() => resolveEdits({ old_string: "", new_string: "y" }, "r.md"), "EMPTY_OLD_STRING", 0);
  });
});

describe("afterConcurrentWrite", () => {
  it("re-labels a match failure as caused by a concurrent write, without mutating the original", () => {
    const original = new MdlogError("VALIDATION", "old_string was not found", {
      detail: { reason: "NO_MATCH", edit_index: 1 },
    });
    const relabelled = afterConcurrentWrite(original) as MdlogError;
    expect(relabelled).not.toBe(original);
    expect(relabelled.code).toBe("VALIDATION");
    expect(relabelled.message).toMatch(/^Another write changed this document/);
    expect(relabelled.detail).toEqual({ reason: "NO_MATCH", edit_index: 1, after_concurrent_write: true });
    expect(original.detail).toEqual({ reason: "NO_MATCH", edit_index: 1 });
  });

  it("passes every other error through untouched", () => {
    const conflict = new MdlogError("CONFLICT", "stale base");
    const tooLarge = new MdlogError("VALIDATION", "too big", { detail: { reason: "DOCUMENT_TOO_LARGE" } });
    const plain = new Error("boom");
    expect(afterConcurrentWrite(conflict)).toBe(conflict);
    expect(afterConcurrentWrite(tooLarge)).toBe(tooLarge);
    expect(afterConcurrentWrite(plain)).toBe(plain);
  });
});
