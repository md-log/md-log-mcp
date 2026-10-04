/**
 * Pure, in-memory application of edit_markdown's literal edits.
 *
 * Batch mode exists so an agent that needs several partial changes to one document lands them as ONE
 * write: one PUT -> one version -> one push/inbox notification. Before it, every edit_markdown call was
 * its own version and its own notification, so a 30-step revision buzzed every device 30 times and left
 * 30 permanent (commit_message => milestone) versions behind.
 *
 * Safety is the same as the one-shot mode, per edit: an edit must match exactly once (or opt into
 * replace_all), and the batch is ALL-OR-NOTHING — any failing edit throws before the caller writes
 * anything. Edits apply in order, each against the text produced by the edits before it.
 */
import { MdlogError } from "./client.js";
import { resolveMaxDocumentBytes } from "./config.js";
import { literalFinder } from "./literal.js";
import { countLiteral, replaceAllLiteral, replaceFirstLiteral } from "./path.js";

/** Upper bound on one batch: large enough for a real revision, small enough to keep errors legible. */
export const MAX_EDITS = 50;

/**
 * The backend's per-document cap in UTF-8 bytes (same source as the client's pre-flight check). Every
 * UTF-16 code unit encodes to at least one byte, so a text whose `.length` exceeds this is certainly
 * over the cap: checking length against it never rejects a body the final byte check would accept.
 */
const MAX_DOCUMENT_BYTES = resolveMaxDocumentBytes();

/**
 * Per-call budget of occurrences replaced across the whole batch. The replacement count is what makes a
 * batch expensive: on a cap-sized document, 50 chained replace_all passes that each hit every character
 * blocked the event loop for ~27 s, while 50 single-match edits took ~0.2 s. A single pre-batch call
 * could replace at most one occurrence per character of a cap-sized document, so this budget bounds any
 * batch to the cost of the worst single edit (~0.5 s) and never rejects a single edit that worked before.
 */
const MAX_TOTAL_REPLACEMENTS = MAX_DOCUMENT_BYTES;

/**
 * Wall-clock budget for one batch, checked BETWEEN edits so the first edit always runs (a single edit
 * costs what it would on its own). Searches are linear now (literal.ts), so this is defense in depth: it
 * stops a batch from chaining 50 expensive steps should any superlinear path remain. Measured legitimate
 * worst case: 50 edits on a 25 MiB document in 0.25-0.37 s, so 2 s leaves 5x headroom.
 */
const MAX_BATCH_MILLIS = 2000;

export interface LiteralEdit {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

/** edit_markdown's raw arguments: a batch, or the single-edit shorthand. */
export interface EditInput {
  readonly edits?: readonly LiteralEdit[];
  readonly old_string?: string;
  readonly new_string?: string;
  readonly replace_all?: boolean;
}

export interface EditResult {
  readonly occurrences: number;
  readonly replaced: number;
  readonly replace_all: boolean;
}

export interface AppliedEdits {
  readonly content: string;
  readonly results: readonly EditResult[];
}

/** Resource limits for one batch. Overridable so tests can exercise them without 25 MiB fixtures. */
export interface EditLimits {
  readonly maxBytes: number;
  readonly maxReplacements: number;
  readonly maxMillis: number;
  /** Monotonic clock in milliseconds. */
  readonly now: () => number;
}

interface BatchContext extends EditLimits {
  readonly path: string;
  readonly total: number;
  readonly startedAt: number;
}

function reject(message: string, detail: Record<string, unknown>): never {
  // VALIDATION, never NOT_FOUND / CONFLICT: a failed match must not read as "file missing" (the model
  // would fall back to the force-writing save_markdown), and must not be swallowed by the CONFLICT retry.
  throw new MdlogError("VALIDATION", message, { detail });
}

/** Message prefix: the batch index only matters when there is more than one edit. */
function label(index: number, total: number): string {
  return total > 1 ? `edits[${index}]: ` : "";
}

/** Checks that need no document — run before any backend read, so a malformed call costs no round-trip. */
function assertEditShapes(edits: readonly LiteralEdit[], path: string): void {
  if (edits.length === 0) {
    reject("edits is empty — nothing was written.", { reason: "EMPTY_EDITS", path });
  }
  if (edits.length > MAX_EDITS) {
    reject(
      `edits has ${edits.length} entries; at most ${MAX_EDITS} are allowed per call — nothing was ` +
        `written. Merge neighbouring changes into fewer, larger edits.`,
      { reason: "TOO_MANY_EDITS", path, count: edits.length, max: MAX_EDITS },
    );
  }
  edits.forEach((edit, index) => {
    const where = label(index, edits.length);
    if (edit.old_string.length === 0) {
      reject(`${where}old_string is empty — nothing was written.`, {
        reason: "EMPTY_OLD_STRING",
        path,
        edit_index: index,
      });
    }
    if (edit.old_string === edit.new_string) {
      reject(`${where}old_string and new_string are identical — nothing to change, so nothing was written.`, {
        reason: "IDENTICAL_STRINGS",
        path,
        edit_index: index,
      });
    }
  });
}

/**
 * Turn edit_markdown's two input shapes into one validated, ordered edit list: either `edits` (batch)
 * or the top-level `old_string`/`new_string`/`replace_all` shorthand. Mixing them is rejected rather
 * than merged: a caller that sent both has a wrong model of what will be written.
 */
export function resolveEdits(input: EditInput, path: string): readonly LiteralEdit[] {
  // Clients that fill in every optional parameter send '' / false for the shorthand next to `edits`.
  // Those defaults carry no intent, so only a value that would change the written text counts.
  const usesShorthand = !!input.old_string || !!input.new_string || input.replace_all === true;
  if (input.edits !== undefined && usesShorthand) {
    reject(
      "Pass EITHER `edits` OR old_string/new_string/replace_all, not both — nothing was written. Move " +
        "the top-level change into `edits` and omit old_string/new_string/replace_all.",
      { reason: "MIXED_INPUT", path },
    );
  }
  const edits = input.edits ?? shorthandEdit(input, path);
  assertEditShapes(edits, path);
  return edits;
}

function shorthandEdit(input: EditInput, path: string): readonly LiteralEdit[] {
  if (input.old_string === undefined || input.new_string === undefined) {
    reject(
      "Provide `edits` (a list of {old_string, new_string}) or both old_string and new_string — " +
        "nothing was written.",
      { reason: "MISSING_EDIT", path },
    );
  }
  return [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
}

/**
 * Refuse a step BEFORE building its text: chained replace_all edits grow the text geometrically
 * ("a" -> "aa" 28 times is 2^28 chars, and split() on that aborts V8 with an uncatchable fatal error),
 * and they multiply the work done per call. Both would stall the shared HTTP server for every tenant.
 */
function assertWithinLimits(
  contentLength: number,
  edit: LiteralEdit,
  replaced: number,
  replacedBefore: number,
  index: number,
  ctx: BatchContext,
): void {
  const where = label(index, ctx.total);
  const nextLength = contentLength + replaced * (edit.new_string.length - edit.old_string.length);
  if (nextLength > ctx.maxBytes) {
    reject(
      `${where}this edit would grow "${ctx.path}" to at least ${nextLength} bytes, over the ` +
        `${ctx.maxBytes}-byte document cap — nothing was written.`,
      { reason: "DOCUMENT_TOO_LARGE", path: ctx.path, edit_index: index, min_bytes: nextLength, max_bytes: ctx.maxBytes },
    );
  }
  const totalReplaced = replacedBefore + replaced;
  if (totalReplaced > ctx.maxReplacements) {
    reject(
      `${where}the edits would replace ${totalReplaced} occurrences in total, over the per-call limit of ` +
        `${ctx.maxReplacements} — nothing was written. Split the change across several calls.`,
      {
        reason: "TOO_MANY_REPLACEMENTS",
        path: ctx.path,
        edit_index: index,
        replaced: totalReplaced,
        max_replacements: ctx.maxReplacements,
      },
    );
  }
}

function assertWithinTime(index: number, ctx: BatchContext): void {
  if (index === 0) return; // the first edit always runs — a single edit costs what it did before batching
  const elapsed = Math.round(ctx.now() - ctx.startedAt);
  if (elapsed > ctx.maxMillis) {
    reject(
      `${label(index, ctx.total)}applying the edits before this one already took ${elapsed} ms, over the ` +
        `${ctx.maxMillis} ms per-call budget — nothing was written. Split the edits across several calls.`,
      { reason: "BATCH_TOO_SLOW", path: ctx.path, edit_index: index, elapsed_ms: elapsed, max_ms: ctx.maxMillis },
    );
  }
}

function applyOne(
  content: string,
  edit: LiteralEdit,
  index: number,
  replacedBefore: number,
  ctx: BatchContext,
): { content: string; result: EditResult } {
  const where = label(index, ctx.total);
  const after = index > 0 ? " (after applying the edits before it)" : "";
  const all = edit.replace_all === true;

  assertWithinTime(index, ctx);
  const find = literalFinder(edit.old_string);
  const first = find(content, 0);
  if (first === -1) {
    reject(
      `${where}old_string was not found in "${ctx.path}"${after} — nothing was written. Re-read the ` +
        `file with get_markdown and copy the text to replace verbatim (indentation, punctuation and ` +
        `line breaks must match exactly).`,
      { reason: "NO_MATCH", path: ctx.path, edit_index: index, occurrences: 0 },
    );
  }
  // "Exactly once" means ONE possible target, so an OVERLAPPING repeat is ambiguous too: "\n\n" inside
  // "\n\n\n" could mean either pair. replace_all keeps split()'s left-to-right, non-overlapping semantics.
  if (!all && find(content, first + 1) !== -1) {
    rejectAmbiguous(countLiteral(content, edit.old_string, find), where, after, index, ctx.path);
  }

  const occurrences = all ? countLiteral(content, edit.old_string, find) : 1;
  assertWithinLimits(content.length, edit, occurrences, replacedBefore, index, ctx);

  // Literal splice only — String.replace would interpret '$&', '$1', "$'" in new_string. One finder per
  // edit (a long old_string's KMP table is built once), and a single edit splices at the match it already
  // found instead of searching again.
  const next = all
    ? replaceAllLiteral(content, edit.old_string, edit.new_string, find)
    : replaceFirstLiteral(content, edit.old_string, edit.new_string, first);
  return { content: next, result: { occurrences, replaced: occurrences, replace_all: all } };
}

function rejectAmbiguous(occurrences: number, where: string, after: string, index: number, path: string): never {
  if (occurrences > 1) {
    reject(
      `${where}old_string occurs ${occurrences} times in "${path}"${after} — ambiguous, so nothing was ` +
        `written. Extend old_string with surrounding lines until it is unique, or set replace_all:true ` +
        `to change all ${occurrences} occurrences.`,
      { reason: "AMBIGUOUS_MATCH", path, edit_index: index, occurrences },
    );
  }
  reject(
    `${where}old_string matches at overlapping positions in "${path}"${after} (e.g. inside a longer run of ` +
      `blank lines or repeated characters) — ambiguous, so nothing was written. Extend old_string with ` +
      `neighbouring text so it identifies exactly one position.`,
    { reason: "AMBIGUOUS_MATCH", path, edit_index: index, occurrences, overlapping: true },
  );
}

/**
 * Apply `edits` in order to `original`. Throws a VALIDATION MdlogError (with `detail.reason` and, for
 * per-edit failures, `detail.edit_index`) without producing any output if any edit fails, if a step
 * would exceed the document cap, the per-call replacement budget or the per-call time budget, or if the
 * batch leaves the document byte-identical.
 */
export function applyLiteralEdits(
  original: string,
  edits: readonly LiteralEdit[],
  path = "document",
  limits: Partial<EditLimits> = {},
): AppliedEdits {
  assertEditShapes(edits, path);
  const now = limits.now ?? (() => performance.now());
  const ctx: BatchContext = {
    path,
    total: edits.length,
    maxBytes: limits.maxBytes ?? MAX_DOCUMENT_BYTES,
    maxReplacements: limits.maxReplacements ?? MAX_TOTAL_REPLACEMENTS,
    maxMillis: limits.maxMillis ?? MAX_BATCH_MILLIS,
    now,
    startedAt: now(),
  };
  const { content, results } = edits.reduce<{ content: string; results: EditResult[]; replaced: number }>(
    (acc, edit, index) => {
      const step = applyOne(acc.content, edit, index, acc.replaced, ctx);
      return {
        content: step.content,
        results: [...acc.results, step.result],
        replaced: acc.replaced + step.result.replaced,
      };
    },
    { content: original, results: [], replaced: 0 },
  );

  if (content === original) {
    // e.g. A->B then B->A. The backend no-ops an identical save anyway; saying so here keeps the caller
    // from reporting a version that was never written.
    reject(`The edits cancel out — "${path}" would be unchanged, so nothing was written.`, {
      reason: "NO_CHANGE",
      path,
    });
  }
  return { content, results };
}

/**
 * Re-label a match failure that happened on the CONFLICT retry. The document was re-read after another
 * writer changed it, so "old_string not found" there means "someone else changed that text", not "you
 * copied it wrong" — without saying so the agent re-reads, finds its text gone, and cannot tell why.
 * Every other error passes through untouched.
 */
export function afterConcurrentWrite(err: unknown): unknown {
  if (!(err instanceof MdlogError) || err.code !== "VALIDATION") return err;
  const detail = (err.detail ?? {}) as Record<string, unknown>;
  if (detail.reason !== "NO_MATCH" && detail.reason !== "AMBIGUOUS_MATCH") return err;
  return new MdlogError(
    "VALIDATION",
    `Another write changed this document while your edit was in flight. After re-reading it: ${err.message}`,
    { detail: { ...detail, after_concurrent_write: true } },
  );
}
