// Plans the batchUpdate requests that turn a tab into an edited docmd. Both sides are atoms (see ir.ts). Written
// directly, a word-level diff finds what was deleted and inserted; as suggestions, the edited docmd says so in
// CriticMarkup, and the rest must be as in the doc. The mark and paragraph rules turn the other differences into
// style requests, and edits that would touch other people's comments or pending suggestions are refused.
import { diffArrays, diffLines } from "diff";
import type { docs_v1 } from "googleapis";
import { type Atom, isFresh, type Segment, suggestions } from "./ir.js";
import { MARKS, type Marks, type MarkValue, PARAGRAPH_RULES, type Props } from "./rules.js";

type Request = docs_v1.Schema$Request;
type Range = docs_v1.Schema$Range;

export type Problem = {
  code: "anchors_affected" | "comments_read_only" | "unsupported_edit";
  message: string;
};

export type PlanOptions = {
  tabId?: string;
  /** Suggested deletions stay in the doc, so indexes after them don't shift. */
  suggest: boolean;
  /** Comment threads anchored in the tab. */
  threads: { id: string; quote: string; ranges: Range[] }[];
  /** Threads whose text may all go (they stay, unanchored). */
  allowDetach: string[];
  /** The pending suggestions the signed-in user made: a new one that touches one of them joins it. */
  mine: string[];
  /** The docmd of atoms, for messages. */
  docmd(atoms: Atom[]): string;
};

export type Plan = { requests: Request[]; problems: Problem[] };

/** `next` holds the segments the docmd defines; segments it leaves out are unchanged. */
export function plan(segments: Segment[], next: Segment[], opts: PlanOptions): Plan {
  const requests: Request[] = [];
  const problems = new Map<string, Problem>();
  const footnotes = new Map(segments.map((s) => [s.id, s]));
  for (const segment of segments) {
    const edited = next.find((s) => s.id === segment.id);
    if (!edited) continue;
    const result = planSegment(segment, edited.atoms, opts, footnotes);
    requests.push(...result.requests);
    for (const p of result.problems) problems.set(p.message, p);
  }
  return { requests, problems: [...problems.values()] };
}

// ---- Diffing ----

/** Hunks in token coordinates: `ol` old tokens from `o` are replaced by `nl` new tokens from `n`. A suggested
 * replace says which goes first: the new text (`insFirst`) or the old. */
type Hunk = { o: number; ol: number; n: number; nl: number; insFirst?: boolean };
type Token = { from: number; to: number; key: string };

/** What the diff compares: the atom's identity and the pending suggestions on it. A paragraph end's suggestion
 * doesn't show in docmd. */
const diffKey = (a: Atom) =>
  a.kind === "end" || a.kind === "annotation"
    ? `${a.kind[0]}${a.key}`
    : [
        `${a.kind[0]}${a.key}`,
        a.ins ?? "",
        a.del ?? "",
        a.styleChanges.join(" "),
        a.restyled ? MARKS.map((m) => a.restyled?.[m.name] ?? "").join("\u0002") : "",
      ].join("\u0000");

const WORD = /[\p{L}\p{N}_]/u;

/** Words (runs of letters and digits in one suggestion) and single other atoms; with `words` false, one token
 * per atom. */
function tokens(atoms: Atom[], words = true): Token[] {
  const out: Token[] = [];
  const word = (a?: Atom) => words && a?.kind === "text" && WORD.test(a.key);
  for (let k = 0; k < atoms.length; ) {
    const from = k;
    const first = atoms[k];
    k++;
    if (word(first)) while (word(atoms[k]) && atoms[k]?.ins === first?.ins && atoms[k]?.del === first?.del) k++;
    out.push({ from, to: k, key: atoms.slice(from, k).map(diffKey).join("\u0001") });
  }
  return out;
}

function hunks(a: Token[], b: Token[]): Hunk[] {
  const out: Hunk[] = [];
  let o = 0;
  let n = 0;
  for (const c of diffArrays(
    a.map((t) => t.key),
    b.map((t) => t.key),
  )) {
    const count = c.count ?? c.value.length;
    if (!c.added && !c.removed) {
      o += count;
      n += count;
      continue;
    }
    let h = out.at(-1);
    if (!h || h.o + h.ol !== o || h.n + h.nl !== n) {
      h = { o, ol: 0, n, nl: 0 };
      out.push(h);
    }
    if (c.removed) {
      h.ol += count;
      o += count;
    } else {
      h.nl += count;
      n += count;
    }
  }
  return out;
}

/** The equivalent positions of a pure insertion or deletion: it can slide while the tokens at its edges match
 * (and the token it moves over is `movable`). */
function slides(all: Hunk[], k: number, a: Token[], b: Token[], movable: (key?: string) => boolean): Hunk[] {
  const h = all[k] as Hunk;
  if (h.ol && h.nl) return [h];
  const lo = { o: (all[k - 1]?.o ?? 0) + (all[k - 1]?.ol ?? 0), n: (all[k - 1]?.n ?? 0) + (all[k - 1]?.nl ?? 0) };
  const hi = { o: all[k + 1]?.o ?? a.length, n: all[k + 1]?.n ?? b.length };
  const edge = (t: Token[], i: number) => t[i]?.key;
  // The tokens that move from one side of the hunk to the other.
  const leftKey = (c: Hunk) => (c.nl ? edge(b, c.n + c.nl - 1) : edge(a, c.o + c.ol - 1));
  const rightKey = (c: Hunk) => (c.nl ? edge(b, c.n) : edge(a, c.o));
  const out = [h];
  for (
    let c = h;
    c.o > lo.o && c.n > lo.n && edge(a, c.o - 1) === leftKey(c) && movable(leftKey(c)) && out.length < 8;
  ) {
    c = { ...c, o: c.o - 1, n: c.n - 1 };
    out.push(c);
  }
  for (let c = h; out.length < 16; ) {
    const after = c.nl ? edge(a, c.o) : edge(a, c.o + c.ol);
    if (c.o + c.ol >= hi.o || c.n + c.nl >= hi.n || after !== rightKey(c) || !movable(after)) break;
    c = { ...c, o: c.o + 1, n: c.n + 1 };
    out.push(c);
  }
  return out;
}

/** First position in the sorted `values` that is >= `x` (or > `x`, with `after`). */
function bound(values: number[], x: number, after = false) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((values[mid] as number) < x || (after && values[mid] === x)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What a segment's plan is built from, computed once per segment. */
type Context = {
  segment: Segment;
  visible: Atom[];
  next: Atom[];
  a: Token[];
  b: Token[];
  /** The atoms that are in the doc (comment annotations take no space there), in index order. */
  all: Atom[];
  indexes: number[];
  position: Map<Atom, number>;
  ends: Atom[];
  endIndexes: number[];
  /** The IDs of the segment's pending suggestions. */
  pending: Set<string>;
  /** Each paragraph end of `next`, numbered in order. */
  ordinal: Map<Atom, number>;
  footnotes: Map<string, Segment>;
  opts: PlanOptions;
};

/** Token ranges whose matched atoms a build compares: all of them, or the ones around one hunk. */
type Window = { o: number; n: number; oEnd: number; nEnd: number };

function planSegment(segment: Segment, edited: Atom[], opts: PlanOptions, footnotes: Map<string, Segment>): Plan {
  const visible = segment.atoms.filter((a) => !a.hidden);
  const all = segment.atoms.filter((x) => x.kind !== "annotation");
  const ends = all.filter((x) => x.kind === "end");
  const pending = suggestions(segment.atoms);
  // Suggestions in the docmd: pending ones, with their IDs, and new ones, in suggest mode.
  const ids = suggestions(edited);
  const problems: Problem[] = [];
  for (const id of ids)
    if (isFresh(id) ? !opts.suggest : !pending.has(id))
      problems.push({ code: "unsupported_edit", message: isFresh(id) ? DIRECT : `{>>s:${id}<<}: ${UNKNOWN}` });
  if (problems.length) return { requests: [], problems: [...new Map(problems.map((p) => [p.message, p])).values()] };

  // As suggestions, the CriticMarkup says what changes; the text the docmd adds (and the formatting it
  // suggests) is planned as if it were written directly.
  const aligned = opts.suggest ? align(segment, visible, edited, opts.docmd) : undefined;
  if (aligned && "problem" in aligned) return { requests: [], problems: [aligned.problem] };
  const next = aligned ? aligned.next : edited;
  const ctx: Context = {
    segment,
    visible,
    next,
    a: tokens(visible, !aligned),
    b: tokens(next, !aligned),
    all,
    indexes: all.map((x) => x.index ?? 0),
    position: new Map(all.map((x, k) => [x, k])),
    ends,
    endIndexes: ends.map((x) => x.index ?? 0),
    pending,
    ordinal: new Map(next.filter((x) => x.kind === "end").map((x, k) => [x, k])),
    footnotes,
    opts,
  };
  const { a, b } = ctx;
  let hs = aligned ? aligned.hunks : hunks(a, b);
  // A suggestion's text is where the docmd puts it; only which side of a paragraph break it's on is open.
  const movable = (key?: string) => !aligned || key === "e\n";
  // Where an insertion or deletion can go in several places, take the one that is valid and needs the fewest
  // requests (for example, the side of a paragraph break where the new paragraph inherits the right style).
  // Each place is costed on its own, with the text between its neighbouring hunks.
  for (let k = 0; k < hs.length; k++) {
    const options = slides(hs, k, a, b, movable);
    if (options.length < 2) continue;
    const prev = hs[k - 1];
    const window: Window = {
      o: prev ? prev.o + prev.ol : 0,
      n: prev ? prev.n + prev.nl : 0,
      oEnd: hs[k + 1]?.o ?? a.length,
      nEnd: hs[k + 1]?.n ?? b.length,
    };
    const cost = (h: Hunk) => {
      const r = build(ctx, [h], window);
      return (r.invalid ? 1e9 : 0) + r.problems.length * 1000 + r.requests.length;
    };
    const costs = options.map(cost);
    hs = hs.with(k, options[costs.indexOf(Math.min(...costs))] as Hunk);
  }
  const r = build(ctx, hs, { o: 0, n: 0, oEnd: a.length, nEnd: b.length });
  if (r.invalid) r.problems.push({ code: "unsupported_edit", message: r.invalid });
  return r;
}

/**
 * Suggest mode: the docmd's atoms against the doc's, in order. Outside the new CriticMarkup they must be the
 * same; each run of new suggested text becomes a hunk, and a new suggested style change becomes the formatting
 * to write. Returns the atoms as they'd be written directly (the new text without its suggestion, the old text
 * it deletes left out), with the hunks in token (here: atom) coordinates.
 */
function align(
  segment: Segment,
  doc: Atom[],
  edited: Atom[],
  docmd: PlanOptions["docmd"],
): { next: Atom[]; hunks: Hunk[] } | { problem: Problem } {
  const next: Atom[] = [];
  const hs: (Hunk & { parts: ("ins" | "del")[] })[] = [];
  let v = 0;
  let open: (typeof hs)[number] | undefined;
  /** Adds an inserted or deleted atom to the current hunk; text after both its insertion and deletion starts
   * another one. */
  const add = (part: "ins" | "del") => {
    if (!open || (open.parts.at(-1) !== part && open.parts.length === 2)) {
      open = { o: v, ol: 0, n: next.length, nl: 0, parts: [] };
      hs.push(open);
    }
    if (open.parts.at(-1) !== part) open.parts.push(part);
    if (part === "ins") open.nl++;
    else open.ol++;
  };
  const plain = (x: Atom): Atom => ({
    ...x,
    ins: isFresh(x.ins) ? undefined : x.ins,
    del: isFresh(x.del) ? undefined : x.del,
    ...(x.styleChanges.some(isFresh) ? { styleChanges: [], restyled: undefined } : {}),
  });
  const same = (d: Atom | undefined, x: Atom) => !!d && diffKey(d) === diffKey(plain(x));
  /** Whether all of the paragraph that `edited[k]` ends is new: inserted, or deleted. */
  const whole = (k: number, part: "ins" | "del") => {
    let q = k - 1;
    while (edited[q]?.kind === "annotation") q--;
    if (!edited[q] || ofKind(edited[q], "end", "boundary")) return false;
    for (; edited[q] && !ofKind(edited[q], "end", "boundary"); q--)
      if (edited[q]?.kind !== "annotation" && !isFresh(edited[q]?.[part])) return false;
    return true;
  };
  const following = (d: Atom) => segment.atoms.slice(segment.atoms.indexOf(d) + 1).find((y) => y.kind !== "annotation");
  /** The edit without its new suggestions should read as the doc does; the first line where it doesn't. */
  const differs = (why: string): { problem: Problem } => {
    const kept = edited.filter((x, k) => !isFresh(x.ins) && !(x.kind === "end" && whole(k, "ins"))).map(plain);
    const changed = diffLines(docmd(segment.atoms), docmd(kept)).filter((c) => c.added || c.removed);
    const line = (added: boolean) =>
      changed
        .filter((c) => !!c.added === added)
        .flatMap((c) => c.value.split("\n"))
        .find((l) => l.trim()) ?? "(nothing)";
    const lines = changed.length
      ? `\nThe doc reads:\n  ${line(false)}\nbut the edit, apart from its new suggestions:\n  ${line(true)}\n`
      : " ";
    return { problem: { code: "unsupported_edit", message: `${why}.${lines}${SUGGEST}` } };
  };

  /** Most likely, an edit that doesn't match the doc where it has a pending suggestion changes that. */
  const mismatch = (d: Atom | undefined, why: string) => {
    const pending = d?.ins ?? d?.del ?? d?.styleChanges[0];
    return pending ? { problem: suggestionProblem(pending) } : differs(why);
  };
  for (const [k, x] of edited.entries()) {
    const d = doc[v];
    // A new paragraph's break goes with it, unless the doc has a paragraph to put its text in (an empty cell);
    // a deleted paragraph's break goes too, unless it's the last before a table or the segment's end.
    const end = x.kind === "end";
    if (isFresh(x.ins) || (end && whole(k, "ins") && d?.kind !== "end")) {
      add("ins");
      next.push(plain(x));
      continue;
    }
    const removable = !!d && ofKind(following(d), "text", "element", "end");
    if (isFresh(x.del) || (end && whole(k, "del") && removable)) {
      if (!same(d, x)) return mismatch(d, "the text in {--…--} isn't the doc's");
      add("del");
      v++;
      continue;
    }
    open = undefined;
    if (!d || !same(d, x)) return mismatch(d, "the text outside CriticMarkup isn't the doc's");
    const restyle = x.styleChanges.some(isFresh);
    if (x.kind !== "end" && MARKS.some((m) => x.marks[m.name] !== d.marks[m.name]))
      return differs(
        restyle ? "the old formatting in {~~…~>…~~} isn't the doc's" : "formatting changed outside CriticMarkup",
      );
    if (end && PARAGRAPH_RULES.some((rule) => !rule.same(d.props ?? { heading: 0 }, x.props ?? { heading: 0 })))
      return { problem: { code: "unsupported_edit", message: PARAGRAPH_SUGGESTION } };
    next.push(restyle ? { ...plain(x), marks: x.restyled ?? x.marks } : x);
    v++;
  }
  if (v < doc.length) return differs("the edit leaves out text of the doc");
  return {
    next,
    hunks: hs.map(({ parts, ...h }) => (parts.length === 2 ? { ...h, insFirst: parts[0] === "ins" } : h)),
  };
}

// ---- Planning ----

const ofKind = (a: Atom | undefined, ...kinds: Atom["kind"][]) => !!a && kinds.includes(a.kind);
const end = (a: Atom) => (a.index ?? 0) + (a.size ?? 0);
/** Length in the doc: parsed atoms have no size. */
const length = (a: Atom) => (a.kind === "text" ? a.key.length : a.kind === "annotation" ? 0 : 1);

const SEPARATE_LIST =
  "this list item would be in a separate list, not the one docmd puts it in: a new item joins a list when it " +
  "follows an item at its own level. Moving items between lists isn't supported yet.";
const JOINED_LIST =
  "this list item would join the list before it, not start a new one as docmd says. Moving items between " +
  "lists isn't supported yet.";
const SUGGEST =
  "As suggestions (the default mode), write each change in CriticMarkup: {++added++}, {--removed--}, " +
  "{~~old~>new~~}, and formatting as {~~word~>**word**~~}, without an ID; the rest stays as read shows it. " +
  'Pass mode "direct" only if the user asked for direct edits.';
const DIRECT =
  'CriticMarkup makes suggestions, which mode "direct" doesn\'t: write the change itself, or leave out mode to ' +
  "suggest it.";
const UNKNOWN =
  "not a pending suggestion in this tab. Leave pending suggestions with their IDs as they are; new ones have none.";
const PARAGRAPH_SUGGESTION =
  "changing a heading or list item can't be suggested yet; new paragraphs and list items can be. Change it " +
  'with mode "direct" if the user asked for direct edits.';

function build(ctx: Context, hs: Hunk[], window: Window): Plan & { invalid?: string } {
  const { segment, visible, next, a, b, all, indexes, position, opts } = ctx;
  const where = (fields: { index?: number; startIndex?: number; endIndex?: number }) => ({
    ...fields,
    ...(segment.id ? { segmentId: segment.id } : {}),
    ...(opts.tabId ? { tabId: opts.tabId } : {}),
  });
  /** The first atom at or after doc index `i`, the last one before it, and the first paragraph end at or after it. */
  const atomAt = (i: number) => all[bound(indexes, i)];
  const before = (i: number) => all[bound(indexes, i) - 1];
  const firstEnd = (i: number) => ctx.ends[bound(ctx.endIndexes, i)];
  const atomRange = (t: Token[], o: number, l: number, atoms: Atom[]) =>
    l ? atoms.slice(t[o]?.from, t[o + l - 1]?.to) : [];
  const atomStart = (t: Token[], o: number, atoms: Atom[]) => (o < t.length ? (t[o]?.from ?? 0) : atoms.length);

  const problems: Problem[] = [];
  const pass1: { i: number; k: number; requests: Request[] }[] = [];
  const pass2: Request[] = [];
  let invalid: string | undefined;

  type Placed = {
    i: number;
    j: number;
    /** Where the inserted text goes in. */
    x: number;
    inserted: Atom[];
    delta: number;
    at: number;
    /** The style of the paragraph its inserted text goes into, and of one it merges another into, if it does. */
    atJ: Props;
    merges?: Props;
  };
  const placed: Placed[] = [];
  /** The doc ranges that hunks delete, in order. */
  const gone: [number, number][] = [];
  /** Paragraph ends whose style changes because a hunk merged their paragraph into another. */
  const merged = new Map<Atom, Props>();

  for (const h of hs) {
    const deleted = atomRange(a, h.o, h.ol, visible);
    const inserted = atomRange(b, h.n, h.nl, next);
    const vs = atomStart(a, h.o, visible);
    let i: number;
    let j: number;
    const first = deleted[0];
    const last = deleted.at(-1);
    if (first && last) {
      i = first.index ?? 0;
      j = end(last);
    } else {
      // After text, right after it; else at the next visible atom, or for new paragraphs at the start of the
      // next paragraph (which can be a hidden empty one, such as before a table).
      const prev = visible[vs - 1];
      const nextAtom = prev ? all[(position.get(prev) ?? -1) + 1] : all[0];
      const following = inserted.at(-1)?.kind === "end" ? nextAtom : (visible[vs] ?? nextAtom);
      i =
        prev?.kind === "annotation"
          ? (prev.index ?? Number.NaN)
          : ofKind(prev, "text", "element") && prev
            ? end(prev)
            : (following?.index ?? Number.NaN);
      j = i;
    }
    const after = atomAt(j);
    if (Number.isNaN(i) || !after)
      invalid ??= "can't add text after the last paragraph break of the doc or a footnote.";
    else if (inserted.length && after.kind === "boundary")
      invalid ??= "can't add text right before a table or a block token; add it to the paragraph before it.";
    const removed = all.slice(bound(indexes, i), bound(indexes, j));
    for (const x of removed) {
      const following = all[(position.get(x) ?? 0) + 1];
      if (x.kind === "end" && (!following || following.kind === "boundary"))
        invalid ??= "can't remove the last paragraph break of the doc, a footnote or a table cell.";
    }
    checkRemoval(removed, ctx, problems);
    if (j > i) gone.push([i, j]);
    for (const x of deleted)
      if (x.kind === "annotation" && !(x.thread && opts.allowDetach.includes(x.thread)))
        problems.push(commentProblem(x.thread));
    const outer = before(i);
    const inner = atomAt(j);
    if (
      inserted.length &&
      outer &&
      inner &&
      ((outer.ins && outer.ins === inner.ins) || (outer.del && outer.del === inner.del))
    )
      problems.push(suggestionProblem((outer.ins ?? outer.del) as string));
    // Docs merges touching suggestions by the same person into one, which would change the pending one.
    if (opts.suggest && (inserted.length || j > i))
      for (const y of [outer, inner]) {
        const id = y?.ins ?? y?.del;
        if (id && opts.mine.includes(id)) problems.push(joinsProblem(id));
      }

    // New text goes in at j, after the text it replaces (a suggested replace can go either way). It takes
    // the style of the paragraph at j. Deleting [i, j) then merges the paragraph at i with the one at j: the
    // merged paragraph keeps the style of the one at i, unless the deletion started at a paragraph's start.
    // (Suggested deletions don't merge anything until they're accepted.)
    const startsParagraph = !outer || ofKind(outer, "end", "boundary");
    const atJ = firstEnd(j)?.props ?? { heading: 0 };
    const merges = !opts.suggest && removed.some((x) => x.kind === "end");
    const mergedProps = merges && !startsParagraph ? (firstEnd(i)?.props ?? atJ) : atJ;

    let text = "";
    for (const x of inserted) {
      // Text of a pending suggestion that isn't in the doc: an edited suggestion.
      for (const id of [x.ins, x.del]) if (id) problems.push(suggestionProblem(id));
      if (x.kind === "text") text += x.key;
      else if (x.kind === "end") text += "\n";
      else if (x.kind === "annotation") problems.push(commentProblem(x.thread));
      else
        problems.push({
          code: "unsupported_edit",
          message:
            x.kind === "element"
              ? `adding ${opts.docmd([x])} isn't supported yet.`
              : "changing table structure isn't supported yet: edit the text in the cells.",
        });
    }
    // Docs keeps text inserted at either edge of a comment's anchor out of it. So new text right before a
    // thread's `==}` goes in before the text it replaces, inside the anchor; added at an edge, it can't go in.
    // A suggested replace goes in the order the docmd gives, so it can't have its new text at the edge.
    const from = atomStart(b, h.n, next);
    const opens = next[from - 1]?.key === "{==";
    const closes = next[from + inserted.length]?.key === "==}";
    if (text && !deleted.length && (opens || closes)) problems.push(edgeProblem);
    const flat = !removed.some((y) => y.kind === "end") && !inserted.some((y) => y.kind === "end");
    const x =
      h.insFirst !== undefined ? (h.insFirst ? i : j) : text && closes && !opens && deleted.length && flat ? i : j;
    if (text && deleted.length && h.insFirst !== undefined && (h.insFirst ? opens : closes))
      problems.push(h.insFirst ? replaceAtStart : replaceAtEnd);

    const requests: Request[] = [];
    if (text) requests.push({ insertText: { location: where({ index: x }), text } });
    const moved = x === i ? text.length : 0;
    if (j > i) requests.push({ deleteContentRange: { range: where({ startIndex: i + moved, endIndex: j + moved }) } });
    // Hunks at the same index (an insertion right before a replaced word) go in last to first, so that each
    // lands before the text of the ones after it.
    pass1.push({ i, k: pass1.length, requests });
    const delta = text.length - (opts.suggest ? 0 : j - i);
    // Where the inserted text ends up: at i if it went in there or once [i, j) is gone, else at j.
    const at = opts.suggest && x === j ? j : i;
    placed.push({ i, j, x, inserted, delta, at, atJ, ...(merges ? { merges: mergedProps } : {}) });
  }

  // The paragraph end a merge leaves: the next one after the deletion once the hunks after it are applied,
  // which can be one they insert. Hunks apply last to first, so the first one's merge wins.
  const endsOf = (p: Placed) => p.inserted.filter((x) => x.kind === "end");
  for (let k = placed.length - 1; k >= 0; k--) {
    const p = placed[k] as Placed;
    if (!p.merges) continue;
    let survivor: Atom | undefined = endsOf(p)[0] ?? firstEnd(p.j);
    for (const q of endsOf(p).length ? [] : placed.slice(k + 1)) {
      if (!survivor || q.i > (survivor.index ?? 0)) break;
      // q's new paragraph ends go in before the survivor, or in place of it if q deletes it.
      survivor = endsOf(q)[0] ?? (q.j > (survivor.index ?? 0) ? firstEnd(q.j) : survivor);
      if (endsOf(q).length) break;
    }
    if (survivor) merged.set(survivor, p.merges);
  }

  // Final indexes, after the deletions and insertions: hunks are in index order, so their shifts add up.
  const starts = placed.map((p) => p.i);
  const shifts = [0];
  for (const p of placed) shifts.push((shifts.at(-1) ?? 0) + p.delta);
  const shift = (index: number) => shifts[bound(starts, index, true)] ?? 0;

  /** Style requests for runs of atoms whose marks change the same way. */
  const marks = (pairs: { from: Marks; to: Atom; at: number; suggested?: string }[]) => {
    let run: { start: number; end: number; changes: string } | undefined;
    const flush = () => {
      if (!run) return;
      const changes = JSON.parse(run.changes) as [string, MarkValue | null][];
      const styles = changes.map(([name, v]) => MARKS.find((m) => m.name === name)?.write(v ?? undefined));
      pass2.push({
        updateTextStyle: {
          range: where({ startIndex: run.start, endIndex: run.end }),
          textStyle: Object.assign({}, ...styles.map((s) => s?.textStyle)),
          fields: styles.map((s) => s?.fields).join(","),
        },
      });
      run = undefined;
    };
    for (const { from, to, at, suggested } of pairs) {
      if (to.kind === "annotation") continue;
      if (to.kind === "end") {
        flush();
        continue;
      }
      const changes = MARKS.filter((m) => from[m.name] !== to.marks[m.name]).map((m) => [
        m.name,
        to.marks[m.name] ?? null,
      ]);
      if (changes.length && suggested) problems.push(suggestionProblem(suggested));
      const key = JSON.stringify(changes);
      if (run && (run.changes !== key || run.end !== at)) flush();
      if (!changes.length) continue;
      run ??= { start: at, end: at, changes: key };
      run.end = at + length(to);
    }
    flush();
  };

  /** Style requests for consecutive paragraphs (given by their ends) whose style changes, one per run that
   * changes the same way. */
  const paragraphs = (ends: { current: Props; to: Atom; at: number; suggested?: string }[]) => {
    const desired = (e: (typeof ends)[number]) => e.to.props ?? { heading: 0 };
    // Each list item continues the list of the item before it, or starts another list, as the docmd says. No
    // request moves an item between lists; items that get bullets together make one list.
    ends.forEach((e, k) => {
      const before = ends[k - 1];
      const list = desired(e).list;
      if (!before || !list || (!e.current.list && !before.current.list)) return;
      const joins = desired(before).list?.id === list.id;
      if (joins !== (!!e.current.list && before.current.list?.id === e.current.list.id))
        problems.push({ code: "unsupported_edit", message: joins ? SEPARATE_LIST : JOINED_LIST });
    });
    for (const rule of PARAGRAPH_RULES) {
      for (let k = 0; k < ends.length; ) {
        const first = ends[k] as (typeof ends)[number];
        let m = k + 1;
        if (rule.same(first.current, desired(first))) {
          k = m;
          continue;
        }
        if (first.suggested) problems.push(suggestionProblem(first.suggested));
        for (; m < ends.length; m++) {
          const e = ends[m] as (typeof ends)[number];
          const alike = rule.same(e.current, first.current) && rule.same(desired(e), desired(first));
          if (!alike || e.suggested) break;
        }
        const last = ends[m - 1] as (typeof ends)[number];
        const change = rule.change(
          where({ startIndex: first.at, endIndex: last.at + 1 }),
          first.current,
          desired(first),
        );
        if (typeof change === "string") problems.push({ code: "unsupported_edit", message: change });
        else pass2.push(...change);
        k = m;
      }
    }
  };

  // Paragraph ends of the edited docmd, with their style once the text is written.
  const ends: { current: Props; to: Atom; at: number; suggested?: string }[] = [];

  // Atoms the diff matched: their marks and paragraph styles.
  const equalPairs: { from: Marks; to: Atom; at: number; suggested?: string }[] = [];
  let o = window.o;
  let n = window.n;
  for (const h of [...hs, { o: window.oEnd, ol: 0, n: window.nEnd, nl: 0 }]) {
    const olds = atomRange(a, o, h.o - o, visible);
    const news = atomRange(b, n, h.n - n, next);
    olds.forEach((x, k) => {
      const to = news[k] as Atom;
      const at = (x.index ?? 0) + shift(x.index ?? 0);
      const suggested = x.ins ?? x.del ?? x.styleChanges[0];
      if (x.kind === "end")
        ends.push({
          current: merged.get(x) ?? x.props ?? { heading: 0 },
          to,
          at,
          suggested: x.styleChanges[0] ?? x.ins ?? x.del,
        });
      equalPairs.push({ from: x.marks, to, at, suggested });
    });
    o = h.o + h.ol;
    n = h.n + h.nl;
  }
  marks(equalPairs);

  // Inserted atoms: their marks (inserted text takes the style of the text before it, or at a paragraph's
  // start of the text after it) and paragraph styles.
  placed.forEach((p, k) => {
    let at = p.at + (shifts[k] ?? 0);
    const prev = before(p.x);
    // Text after p.x that later hunks delete directly is gone by the time p's text goes in.
    let next = p.x;
    if (!opts.suggest) for (const q of placed.slice(k + 1)) if (q.i === next) next = q.j;
    const following = atomAt(next);
    const source = ofKind(prev, "text", "element")
      ? prev
      : ofKind(following, "text", "element")
        ? following
        : undefined;
    const inherited = source?.style ?? source?.marks ?? {};
    const pairs = [];
    for (const x of p.inserted) {
      if (x.kind === "end") ends.push({ current: merged.get(x) ?? p.atJ, to: x, at });
      pairs.push({ from: inherited, to: x, at });
      at += length(x);
    }
    marks(pairs);
  });

  // Consecutive paragraphs are changed together (one list, not one per item).
  const { ordinal } = ctx;
  ends.sort((x, y) => (ordinal.get(x.to) ?? 0) - (ordinal.get(y.to) ?? 0));
  let run: typeof ends = [];
  for (const e of [...ends, undefined]) {
    const last = run.at(-1);
    if (last && (!e || (ordinal.get(e.to) ?? 0) !== (ordinal.get(last.to) ?? 0) + 1)) {
      paragraphs(run);
      run = [];
    }
    if (e) run.push(e);
  }

  // A thread may lose some of its text, but not all of it (whitespace aside): then it has no anchor left.
  const isGone = (x: Atom) => gone.some(([i, j]) => (x.index ?? 0) >= i && (x.index ?? 0) < j);
  for (const t of opts.threads) {
    if (opts.allowDetach.includes(t.id) || t.ranges.some((r) => (r.segmentId ?? "") !== segment.id)) continue;
    const anchored = t.ranges.flatMap((r) =>
      all
        .slice(bound(indexes, r.startIndex ?? 0), bound(indexes, r.endIndex ?? 0))
        .filter((x) => x.kind === "element" || (x.kind === "text" && /\S/u.test(x.key))),
    );
    if (gone.length && anchored.length && anchored.every(isGone)) problems.push(detachProblem(t));
  }

  pass1.sort((x, y) => y.i - x.i || y.k - x.k);
  return { requests: [...pass1.flatMap((p) => p.requests), ...pass2], problems, invalid };
}

const commentProblem = (thread?: string): Problem => ({
  code: "comments_read_only",
  message:
    `comment markup${thread ? ` of thread ${thread}` : ""} can't be added, moved or removed through edits: ` +
    "keep {==, ==} and {>>c:…<<} where they are (removing all of a thread's text with allowDetach removes its markup too).",
});

const suggestionProblem = (id: string): Problem => ({
  code: "anchors_affected",
  message: `pending suggestion ${id}: its text can't be edited; leave it as it is (the doc's editors accept or reject it).`,
});

/** Problems with removing `removed`: pending suggestions and block tokens on it, and what's in the footnotes
 * whose references go with it. */
function checkRemoval(removed: Atom[], ctx: Context, out: Problem[]) {
  const { opts } = ctx;
  for (const x of removed) {
    const suggested = x.ins ?? x.del ?? x.styleChanges[0];
    if (suggested) out.push(suggestionProblem(suggested));
    const footnote = x.kind === "element" && x.key.startsWith("footnote:") && ctx.footnotes.get(x.key.slice(9));
    if (footnote) {
      checkRemoval(footnote.atoms, ctx, out);
      for (const t of opts.threads)
        if (t.ranges.some((r) => r.segmentId === footnote.id) && !opts.allowDetach.includes(t.id))
          out.push(detachProblem(t));
    }
    if (x.kind === "boundary")
      out.push({
        code: "unsupported_edit",
        message: x.nodes
          ? `${opts.docmd([x])} can't be removed through edits.`
          : "changing table structure isn't supported yet: edit the text in the cells.",
      });
  }
}

const edgeProblem: Problem = {
  code: "comments_read_only",
  message:
    "text added right after {== or right before ==} would fall outside the comment (Docs doesn't grow " +
    "comments at their edges). Add it outside the markup, or replace the first or last word inside along with it.",
};

const replaceAtEnd: Problem = {
  code: "comments_read_only",
  message:
    "in a replace right before ==}, new text after the old would fall outside the comment (Docs doesn't grow " +
    "comments at their edges): put it first, as {++new++}{--old--}.",
};

const replaceAtStart: Problem = {
  code: "comments_read_only",
  message:
    "in a replace right after {==, new text before the old would fall outside the comment (Docs doesn't grow " +
    "comments at their edges): put it after, as {~~old~>new~~}.",
};

const joinsProblem = (id: string): Problem => ({
  code: "anchors_affected",
  message:
    `a new suggestion right next to your own pending suggestion ${id} would join it (Docs merges touching ` +
    "suggestions by the same person), so they'd be accepted or rejected together. Change text that doesn't " +
    `touch it, or ask for ${id} to be accepted or rejected first.`,
});

const detachProblem = (t: PlanOptions["threads"][number]): Problem => ({
  code: "anchors_affected",
  message:
    `comment thread ${t.id} on "${t.quote}" would lose all the text it's anchored on. Keep some of that text ` +
    "(edits within it are fine), or pass the thread ID in allowDetach if the user asked for that text to go " +
    "(the thread stays, without an anchor).",
});
