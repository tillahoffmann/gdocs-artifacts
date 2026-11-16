// The intermediate representation both sides of an edit share: a tab as segments (the body, then its
// footnotes), each a flat sequence of atoms laid out like the doc's own indexes. Read from the doc it carries
// indexes; parsed from docmd it doesn't.
import type { docs_v1 } from "googleapis";
import type { PhrasingContent } from "mdast";
import {
  BLOCKS,
  blockToken,
  ELEMENTS,
  type ElementContext,
  field,
  isCode,
  MARKS,
  type Marks,
  opaque,
  type Props,
  raw,
  readMarks,
  sameMarks,
} from "./rules.js";

type Tab = docs_v1.Schema$DocumentTab;
type Comment = docs_v1.Schema$CommentThread;

export type Atom = {
  /** A code point of text, an inline element, a paragraph's end (its "\n"), a table or block boundary, or a
   * comment annotation: a zero-width marker where a thread's anchor starts or ends, or the thread itself. */
  kind: "text" | "element" | "end" | "boundary" | "annotation";
  /** What the diff compares: the character, the element's identity, the boundary ("table", "row", "cell",
   * "/table" or a block token), or the annotation ("{==", "==}", a thread's placeholder, or a comment's docmd). */
  key: string;
  /** Formatting as docmd shows it. */
  marks: Marks;
  /** Formatting in the doc, where it differs from what docmd shows (whitespace at the edge of a bold span). */
  style?: Marks;
  index?: number;
  /** Length in UTF-16 code units, as the doc counts it. */
  size?: number;
  /** Pending suggestions: the IDs of the suggested insertion or deletion, and of style changes. A suggestion
   * that docmd adds, which has no ID yet, has a placeholder (see `fresh`). */
  ins?: string;
  del?: string;
  styleChanges: string[];
  /** With style changes on text or an element: its formatting once they're accepted. */
  restyled?: Marks;
  /** Not shown in docmd: spaces at a paragraph's edge, empty paragraphs. */
  hidden?: boolean;
  /** An element's, block token's or thread's docmd. */
  nodes?: PhrasingContent[];
  /** The comment thread an annotation belongs to. */
  thread?: string;
  /** A paragraph end's properties. */
  props?: Props;
  /** With style changes on a paragraph end: its properties once they're accepted. */
  reprops?: Props;
  /** Who suggested the pending suggestions on the atom, in the doc. */
  authors?: string[];
};

/** A placeholder ID for a suggestion that docmd adds; it can't be written in docmd. */
export const fresh = (k: number) => `\u0000${k}`;
export const isFresh = (id?: string) => !!id?.startsWith("\u0000");

/** The IDs of the suggestions on the atoms. */
export const suggestions = (atoms: Atom[]) =>
  new Set(atoms.flatMap((a) => [a.ins, a.del, ...a.styleChanges]).filter((id): id is string => id !== undefined));

export type Choice = "accept" | "reject";

/** Whether accepting or rejecting a suggestion removes the atom: a rejected insertion or accepted deletion. */
const removes = (a: Atom, choices: ReadonlyMap<string, Choice>) =>
  (a.ins !== undefined && choices.get(a.ins) === "reject") || (a.del !== undefined && choices.get(a.del) === "accept");

/** Where a doc index goes once the suggestions in `choices` are accepted or rejected. */
export function shifts(segments: Segment[], choices: ReadonlyMap<string, Choice>) {
  const gone = new Map(
    segments.map(({ id, atoms }) => [id, atoms.filter((a) => removes(a, choices) && a.size)] as const),
  );
  return (segment: string, index: number) =>
    index - (gone.get(segment) ?? []).reduce((n, a) => n + ((a.index ?? 0) < index ? (a.size ?? 0) : 0), 0);
}

/** The segments once the suggestions in `choices` are accepted or rejected, as the doc will be once they are:
 * requests can be planned on them. */
export function resolved(segments: Segment[], choices: ReadonlyMap<string, Choice>): Segment[] {
  if (!choices.size) return segments;
  const shift = shifts(segments, choices);
  const choice = (id?: string) => (id === undefined ? undefined : choices.get(id));
  return segments.map(({ id, atoms }) => ({
    id,
    atoms: atoms.flatMap((a): Atom[] => {
      if (removes(a, choices)) return [];
      const out = { ...a, ...(a.index === undefined ? {} : { index: shift(id, a.index) }) };
      if (choice(a.ins)) {
        out.ins = undefined;
        out.style = undefined;
      }
      if (choice(a.del)) out.del = undefined;
      const decided = a.styleChanges.filter((s) => choice(s));
      if (decided.length) {
        if (decided.some((s) => choice(s) === "accept")) {
          out.marks = a.restyled ?? a.marks;
          out.props = a.reprops ?? a.props;
        }
        out.styleChanges = a.styleChanges.filter((s) => !choice(s));
        if (!out.styleChanges.length) {
          out.restyled = undefined;
          out.reprops = undefined;
        }
      }
      return [out];
    }),
  }));
}

/** The body has ID "", footnotes their footnote ID. Footnotes follow the body in the order they're referenced. */
export type Segment = { id: string; atoms: Atom[] };

/** A comment thread and where it's anchored. */
export type Thread = { comment: Comment; ranges: docs_v1.Schema$Range[] };

/** The threads among `comments` that are anchored in this tab, with their ranges. */
export function anchored(tab: Tab, comments: Comment[]): Thread[] {
  return comments.flatMap((comment) => {
    const ranges = tab.commentAnchors?.[comment.anchorId ?? ""]?.ranges;
    return ranges?.length ? [{ comment, ranges }] : [];
  });
}

/** The tab's atoms, with the given threads as annotations; `unanchored` threads go at the end of the body.
 * `authors` has who made each suggestion, by its ID. */
export function fromDoc(
  tab: Tab,
  threads: Thread[] = [],
  unanchored: Comment[] = [],
  authors: ReadonlyMap<string, string> = new Map(),
): Segment[] {
  const footnotes: string[] = [];
  const ctx: Context = {
    tab,
    threads,
    segmentId: "",
    counters: {},
    unsuggested: new Map(),
    footnoteLabel(id) {
      if (!footnotes.includes(id)) footnotes.push(id);
      return String(footnotes.indexOf(id) + 1);
    },
  };
  const body = newParagraphs(ctx, structural(ctx, tab.body?.content ?? []));
  const last = body.at(-1);
  const end = (last?.index ?? 0) + (last?.size ?? 0);
  for (const c of unanchored) body.push(threadAnnotation(c, end));
  const segments = [{ id: "", atoms: body }];
  for (const id of footnotes) {
    ctx.segmentId = id;
    segments.push({ id, atoms: newParagraphs(ctx, structural(ctx, tab.footnotes?.[id]?.content ?? [])) });
  }
  for (const a of segments.flatMap((s) => s.atoms)) {
    const names = [...suggestions([a])].flatMap((id) => authors.get(id) ?? []);
    if (names.length) a.authors = [...new Set(names)];
  }
  return segments;
}

type Context = ElementContext & {
  threads: Thread[];
  /** The segment being read: "" for the body, else a footnote ID. Comment ranges are per segment. */
  segmentId: string;
  counters: Record<string, number[]>;
  /** The properties of a new paragraph's end that isn't new itself: what they are without the paragraph. */
  unsuggested: Map<Atom, Props>;
};

/**
 * Docs suggests a new paragraph after one as an insertion of a paragraph end and then its text, before the
 * paragraph's own end: that end then ends the new text, and the inserted one the old text. docmd shows the new
 * paragraph as inserted, its end included, so the ends trade places: the old text's end is the one that was
 * there, with its properties, and the new text's end the inserted one.
 */
function newParagraphs(ctx: Context, atoms: Atom[]): Atom[] {
  const list = [...paragraphs(atoms)];
  const text = (content: Atom[]) => content.filter((a) => a.kind !== "annotation" && !blank(a));
  list.forEach(({ content, end }, i) => {
    const old = end && ctx.unsuggested.get(end);
    const id = text(content)[0]?.ins;
    if (!end || !old || !id) return;
    let k = i - 1;
    const within = (n: number) => list[n]?.end?.kind === "end" && list[n]?.end?.ins === id;
    while (within(k) && text(list[k]?.content ?? []).every((a) => a.ins === id)) k--;
    // The first end of the run: the old text's, or a new paragraph's before the others.
    if (!within(k)) k++;
    const before = list[k]?.end;
    if (!before || k >= i || !within(k)) return;
    // (Not where that would make a list item of the old text, or of the new: edits can't split or join list
    // items yet.)
    const changed = reblocks(old, before.props);
    if (changed && (old.list || before.props?.list || before.styleChanges.length)) return;
    before.ins = undefined;
    end.ins = id;
    if (changed) {
      before.reprops = before.props;
      before.props = old;
      before.styleChanges = [id];
    }
  });
  return atoms;
}

const annotation = (key: string, index: number, thread: string): Atom => ({
  kind: "annotation",
  key,
  marks: {},
  index,
  size: 0,
  styleChanges: [],
  thread,
});

/** Whether the annotation is a thread (rather than a highlight's start or end). */
export const isThread = (a: Atom) => !!a.thread && a.key === threadKey(a.thread);

/** The docmd of an annotation's comments, one per post. */
export const posts = (a: Atom) => a.nodes?.flatMap((n) => (n.type === "html" ? [n.value] : [])) ?? [];

/** How a thread's posts are told apart from other text when edits are matched: a placeholder that docmd never
 * shows (see edit.ts), and the key the thread's annotation compares by. */
export const threadKey = (id: string) => `\uE000${id}\uE001`;

/** The docmd of a comment's author, and of its status if it has one: `@Author` or `@Author; resolved`. */
export const byline = (name: string, status?: string) => `@${name}${status ? `; ${status}` : ""}`;

/** A thread as docmd: each post a comment, `{>>@Author: text<<}`; the first says if the thread is resolved. */
function threadAnnotation(c: Comment, index: number): Atom {
  // Posts that only resolve or reopen the thread have no text.
  const posts = [c.headPost, ...(c.replies ?? [])].filter((p) => p?.content);
  const resolved = c.status === "RESOLVED" ? "resolved" : undefined;
  const id = c.commentId ?? "";
  return {
    ...annotation(threadKey(id), index, id),
    nodes: posts.map((p, k) =>
      raw(
        `{>>${byline(field(p?.author?.displayName ?? "Unknown", ":;"), k ? undefined : resolved)}: ${field((p?.content ?? "").replace(/\s*\n\s*/g, " "))}<<}`,
      ),
    ),
  };
}

/** Inserts the threads' annotations into a paragraph's atoms: `{==` where each range starts, `==}` where it
 * ends (clipped to the paragraph), and the thread after the last piece of its last range. */
function annotate(ctx: Context, atoms: Atom[]): Atom[] {
  const end = atoms.at(-1) as Atom;
  const shown = atoms.filter((a) => a.kind !== "end" && !a.hidden);
  const opens = new Map<Atom, Atom[]>();
  const closes = new Map<Atom, Atom[]>();
  const add = (map: Map<Atom, Atom[]>, at: Atom, a: Atom) => map.set(at, [...(map.get(at) ?? []), a]);
  for (const { comment, ranges: all } of ctx.threads) {
    const id = comment.commentId ?? "";
    const ranges = all.filter((r) => (r.segmentId ?? "") === ctx.segmentId);
    for (const r of ranges) {
      const inRange = (a: Atom) => (a.index ?? 0) >= (r.startIndex ?? 0) && (a.index ?? 0) < (r.endIndex ?? 0);
      let from = shown.findIndex(inRange);
      if (from < 0) continue;
      let to = shown.findLastIndex(inRange) + 1;
      // CriticMarkup isn't read in code: a highlight that starts or ends in a code span is of all of it.
      const code = (a?: Atom) => !!a && (isCode(a.marks) || (!!a.restyled && isCode(a.restyled)));
      while (code(shown[from]) && code(shown[from - 1])) from--;
      while (code(shown[to - 1]) && code(shown[to])) to++;
      const first = shown[from] as Atom;
      const after = shown[to] ?? end;
      add(opens, first, annotation("{==", first.index ?? 0, id));
      add(closes, after, annotation("==}", after.index ?? 0, id));
      if (r === ranges.at(-1) && (r.endIndex ?? 0) <= (end.index ?? 0) + 1)
        add(closes, after, threadAnnotation(comment, after.index ?? 0));
    }
  }
  return atoms.flatMap((a) => [...(closes.get(a) ?? []), ...(opens.get(a) ?? []), a]);
}

const boundary = (key: string, index: number, size = 1, nodes?: PhrasingContent[]): Atom => ({
  kind: "boundary",
  key,
  marks: {},
  index,
  size,
  styleChanges: [],
  nodes,
});

function structural(ctx: Context, content: docs_v1.Schema$StructuralElement[], inCell = false): Atom[] {
  const atoms: Atom[] = [];
  for (const el of content) {
    if (el.paragraph) atoms.push(...paragraph(ctx, el.paragraph, inCell));
    else if (el.table) {
      atoms.push(boundary("table", el.startIndex ?? 0));
      for (const row of el.table.tableRows ?? []) {
        atoms.push(boundary("row", row.startIndex ?? 0));
        for (const cell of row.tableCells ?? []) {
          atoms.push(boundary("cell", cell.startIndex ?? 0));
          const inner = structural(ctx, cell.content ?? [], true);
          showEmptyCell(inner.filter((a) => a.kind === "end"));
          atoms.push(...inner);
        }
      }
      atoms.push(boundary("/table", (el.endIndex ?? 1) - 1));
    } else {
      // Every body starts with an implicit section break without a start index; it isn't content.
      const kind = BLOCKS.find((k) => el[k]);
      if (kind && el.startIndex != null) {
        const t = blockToken(kind);
        atoms.push(boundary(t, el.startIndex, (el.endIndex ?? 0) - el.startIndex, [raw(t)]));
      }
    }
  }
  return atoms;
}

const headingLevel = (p: docs_v1.Schema$Paragraph) =>
  Number(p.paragraphStyle?.namedStyleType?.match(/^HEADING_([1-6])$/)?.[1] ?? 0);

function paragraph(ctx: Context, p: docs_v1.Schema$Paragraph, inCell: boolean): Atom[] {
  const atoms = (p.elements ?? []).flatMap((pe) => elementAtoms(ctx, pe));
  const end = atoms.at(-1);
  if (end?.kind !== "end") throw new Error(`paragraph at ${p.elements?.[0]?.startIndex} doesn't end with a newline`);
  // A new paragraph (all its text a suggested insertion) shows with the style changes suggested on it: like
  // those on suggested text, they're part of the suggestion.
  const content = atoms.slice(0, -1);
  // (Whitespace aside: docmd doesn't show it at a paragraph's edges.)
  const words = content.filter((a) => !blank(a));
  const added = words.length > 0 && words.every((a) => a.ins);
  end.props = propsOf(ctx, added ? suggestedParagraph(p, words[0]?.ins) : p, inCell, true);
  if (added && !end.ins) ctx.unsuggested.set(end, propsOf(ctx, p, inCell, false));
  // Paragraph-level suggestions (style or bullet changes), unless the whole paragraph is a suggestion: docmd
  // shows those that change what block the paragraph is (see `reblocks`).
  const inserted = new Set([...words, end].map((a) => a.ins));
  const ids = added
    ? []
    : Object.keys({ ...p.suggestedParagraphStyleChanges, ...p.suggestedBulletChanges }).filter(
        (id) => !inserted.has(id),
      );
  const reprops = ids.length ? propsOf(ctx, suggestedParagraph(p), inCell, false, end.props) : undefined;
  end.styleChanges = reprops && reblocks(end.props, reprops) ? ids : [];
  if (end.styleChanges.length) end.reprops = reprops;
  // A paragraph style suggestion also shows on the paragraph's text; it's shown once, at the paragraph's end.
  for (const a of atoms) {
    if (a === end) continue;
    a.styleChanges = a.styleChanges.filter((id) => !ids.includes(id));
    if (!a.styleChanges.length) a.restyled = undefined;
  }

  // In a table cell, docmd doesn't tell a line break from a paragraph break: it shows both as <br>, so a line
  // break there is read as a paragraph's end (of the same size: edits around it leave it as it is).
  const parts: Atom[][] = [[]];
  for (const a of atoms) {
    const broken = inCell && a.kind === "text" && a.key === "\u000b";
    const b = broken ? { ...a, kind: "end" as const, key: "\n", props: { heading: 0 }, styleChanges: [] } : a;
    parts.at(-1)?.push(b);
    if (broken) parts.push([]);
  }
  for (const part of parts) shape(part.slice(0, -1), part.at(-1) as Atom);
  return annotate(ctx, parts.flat());
}

/** A paragraph's properties. Counting numbers it in its list; otherwise it keeps the number of `current` if it's
 * in the same list. */
function propsOf(
  ctx: Context,
  p: docs_v1.Schema$Paragraph,
  inCell: boolean,
  counting: boolean,
  current?: Props,
): Props {
  const bullet = p.bullet;
  if (!bullet || inCell) return { heading: inCell ? 0 : headingLevel(p) };
  const id = bullet.listId ?? "";
  const level = bullet.nestingLevel ?? 0;
  const same = current?.list?.id === id && current.list.level === level;
  const number = counting ? count(ctx, id, level) : same ? (current?.list?.number ?? 1) : 1;
  return { heading: 0, list: { id, level, ordered: isOrdered(ctx.tab, id, level), number } };
}

/** Whether two paragraph styles differ in what docmd shows: the heading level, the list level and kind. */
export const reblocks = (a: Props = { heading: 0 }, b: Props = { heading: 0 }) =>
  a.heading !== b.heading ||
  !a.list !== !b.list ||
  a.list?.level !== b.list?.level ||
  a.list?.ordered !== b.list?.ordered;

const CODE = MARKS.find((m) => m.mdast === "inlineCode")?.name ?? "code";

/** One atom's formatting as docmd shows it: as it is, or once its style changes are accepted. */
type View = { atom: Atom; field: "marks" | "restyled" };
const get = (v: View) => v.atom[v.field] ?? {};
function set(v: View, marks: Marks) {
  if (v.field === "marks") v.atom.style ??= v.atom.marks;
  v.atom[v.field] = marks;
}
const without = (v: View, mark: string) => {
  const marks = { ...get(v) };
  delete marks[mark];
  set(v, marks);
};

/** The formatting of shown atoms in the order docmd shows it: text with style changes shows twice, as it is
 * and once they're accepted (`{~~a~>**a**~~}`). */
function views(atoms: Atom[]): View[] {
  const out: View[] = [];
  for (let k = 0; k < atoms.length; ) {
    const ids = restyleKey(atoms[k] as Atom);
    let m = k + 1;
    if (ids) while (m < atoms.length && restyleKey(atoms[m] as Atom) === ids) m++;
    const run = atoms.slice(k, m);
    out.push(...run.map((atom) => ({ atom, field: "marks" as const })));
    if (ids) out.push(...run.map((atom) => ({ atom, field: "restyled" as const })));
    k = m;
  }
  return out;
}

/** The style changes shown on an atom, as one key: "" if there are none. */
export const restyleKey = (a: Atom) => (a.restyled ? a.styleChanges.join(" ") : "");

/** Fits a paragraph's content to what docmd can show; the doc's formatting stays in `style`. */
function shape(content: Atom[], end: Atom) {
  hideEdges(content);
  hideRuns(content);
  const shown = views(content.filter((a) => !a.hidden));
  for (const mark of ["bold", "italic", "strike"]) trimWhitespace(shown, mark);
  // Chips and line breaks aren't text, so they don't show as code.
  for (const v of shown) if ((v.atom.kind === "element" || v.atom.key === "\u000b") && get(v)[CODE]) without(v, CODE);
  // Style changes that no longer show don't show at all.
  for (const a of content)
    if (a.restyled && sameMarks(a.marks, a.restyled)) {
      a.styleChanges = [];
      a.restyled = undefined;
    }
  if (!end.props?.list && content.every((a) => a.hidden)) end.hidden = true;
}

/** Splits atoms into paragraphs: each paragraph's content and its end, or a lone boundary; content at the end
 * without one has none. */
export function* paragraphs(atoms: Atom[]): Generator<{ content: Atom[]; end?: Atom }> {
  let content: Atom[] = [];
  for (const a of atoms) {
    if (a.kind !== "end" && a.kind !== "boundary") content.push(a);
    else {
      yield { content, end: a };
      content = [];
    }
  }
  if (content.length) yield { content };
}

/** Parsed segments as the doc would show them once written: without spaces at paragraph edges, and so on. */
export function asShown(segments: Segment[]): Segment[] {
  return segments.map(({ id, atoms }) => {
    const copy = atoms.map((a) => ({ ...a }));
    let cell: Atom[] | undefined;
    for (const { content, end: a } of paragraphs(copy)) {
      if (a?.kind === "end") {
        const atoms = content.filter((b) => b.kind !== "annotation");
        // A new paragraph or list item whose end is outside the markup ("- {++text++}") is written as new, its
        // end included.
        const id = atoms[0]?.ins;
        if (isFresh(id) && !a.ins && !a.del && atoms.every((b) => b.ins === id)) a.ins = id;
        shape(atoms, a);
        if (a.styleChanges.some(isFresh) && !reblocks(a.props, a.reprops)) {
          a.styleChanges = [];
          a.reprops = undefined;
        }
        // Formatting suggested where it doesn't change anything isn't written, so it doesn't show.
        for (const b of atoms)
          if (b.styleChanges.some(isFresh) && sameMarks(b.marks, b.restyled)) {
            b.styleChanges = [];
            b.restyled = undefined;
          }
        cell?.push(a);
      } else if (a?.kind === "boundary") {
        showEmptyCell(cell);
        cell = a.key === "cell" ? [] : undefined;
      }
    }
    // Docs joins new insertions that touch into one suggestion.
    const joined = new Map<string, string>();
    let before: Atom | undefined;
    for (const a of copy) {
      if (a.kind === "annotation") continue;
      if (a.ins && isFresh(a.ins)) {
        const into = joined.get(a.ins) ?? (before?.ins && isFresh(before.ins) ? before.ins : a.ins);
        joined.set(a.ins, into);
        a.ins = into;
      }
      before = a;
    }
    return { id, atoms: copy };
  });
}

/** An empty cell still shows one (empty) paragraph, so that text can go into it. */
function showEmptyCell(ends: Atom[] | undefined) {
  const last = ends?.at(-1);
  if (last && ends?.every((a) => a.hidden)) last.hidden = false;
}

function isOrdered(tab: Tab, listId: string, level: number) {
  const glyph = tab.lists?.[listId]?.listProperties?.nestingLevels?.[level]?.glyphType;
  return !!glyph && glyph !== "GLYPH_TYPE_UNSPECIFIED" && glyph !== "NONE";
}

/** The item's number in its list at its level; deeper levels restart after it. */
function count(ctx: Context, listId: string, level: number) {
  const start = ctx.tab.lists?.[listId]?.listProperties?.nestingLevels?.[level]?.startNumber ?? 1;
  const levels = ctx.counters[listId] ?? [];
  const number = (levels[level] ?? start - 1) + 1;
  levels[level] = number;
  levels.length = level + 1;
  ctx.counters[listId] = levels;
  return number;
}

const blank = (a: Atom) => a.kind === "text" && (a.key === " " || a.key === "\t");

/** Hides spaces and tabs at the paragraph's edges, which Markdown can't express. */
function hideEdges(atoms: Atom[]) {
  const edge = (a: Atom) => !a.hidden && blank(a);
  for (const a of atoms) {
    if (!edge(a)) break;
    a.hidden = true;
  }
  for (const a of atoms.toReversed()) {
    if (!edge(a)) break;
    a.hidden = true;
  }
}

/** Hides all but one space or tab of each run of them outside code: Markdown reads them as one. With every
 * suggestion accepted, and rejected, the text keeps a space where it had one. */
function hideRuns(atoms: Atom[]) {
  const blankText = (a?: Atom) => !!a && !a.hidden && blank(a) && !isCode(a.marks);
  for (let k = 0; k < atoms.length; ) {
    let m = k;
    while (blankText(atoms[m])) m++;
    const run = atoms.slice(k, m);
    if (run.length > 1) {
      const plain = run.find((a) => !a.ins && !a.del);
      const keep = new Set([plain ?? run.find((a) => !a.ins) ?? run[0], plain ?? run.find((a) => !a.del) ?? run[0]]);
      for (const a of run) if (!keep.has(a)) a.hidden = true;
    }
    k = Math.max(m, k + 1);
  }
}

/** Whether a view shows in the text with every suggestion rejected, or with every one accepted. */
const inReading = (v: View, side: "old" | "new") =>
  side === "old" ? !v.atom.ins && !(v.field === "restyled") : !v.atom.del && !(v.field === "marks" && v.atom.restyled);

/** Bold, italic and strikethrough spans don't start or end with whitespace, which Markdown can't express: in the
 * text as it is, or with every suggestion in it accepted or rejected (CriticMarkup is read over the text). */
function trimWhitespace(shown: View[], mark: string) {
  const blankView = (v: View) => blank(v.atom) || v.atom.key === "\u000b";
  for (let changed = true; changed; ) {
    changed = false;
    for (const side of ["old", "new"] as const) {
      let span: View[] = [];
      const trim = (views: View[]) => {
        for (const v of views) {
          if (!blankView(v)) break;
          without(v, mark);
          changed = true;
        }
      };
      for (const v of [...shown.filter((x) => inReading(x, side)), undefined]) {
        if (v && get(v)[mark]) {
          span.push(v);
          continue;
        }
        trim(span);
        trim(span.toReversed());
        span = [];
      }
    }
  }
}

function elementAtoms(ctx: Context, pe: docs_v1.Schema$ParagraphElement): Atom[] {
  const { startIndex, endIndex: _, ...rest } = pe;
  const value = Object.values(rest)[0] as {
    suggestedInsertionIds?: string[];
    suggestedDeletionIds?: string[];
    suggestedTextStyleChanges?: Record<string, docs_v1.Schema$SuggestedTextStyle>;
    textStyle?: docs_v1.Schema$TextStyle;
  };
  const base: Pick<Atom, "marks" | "style" | "ins" | "del"> = {
    marks: readMarks(value.textStyle),
    ins: value.suggestedInsertionIds?.[0],
    del: value.suggestedDeletionIds?.[0],
  };
  // Style changes on suggested inserted text are part of the insertion (formatting set on it is stored under the
  // insertion's own ID): the text shows formatted as they suggest, and `style` keeps its formatting in the doc.
  // On a suggested deletion they don't show; on other text, they show as {~~a~>**a**~~}.
  const all = ordered(value.suggestedTextStyleChanges ?? {}, base.ins);
  if (base.ins && all.length) {
    base.marks = readMarks(suggested(value.textStyle, all));
    base.style = readMarks(value.textStyle);
  }
  const changes = base.ins || base.del ? [] : all;
  // Style changes docmd can't show (a colour, a font) aren't shown at all.
  const restyled = changes.length ? readMarks(suggested(value.textStyle, changes)) : undefined;
  const visible = restyled && !sameMarks(restyled, base.marks);
  const restyle = visible ? { styleChanges: changes.map(([id]) => id), restyled } : { styleChanges: [] };

  if (pe.textRun) {
    const atoms: Atom[] = [];
    let index = startIndex ?? 0;
    for (const ch of pe.textRun.content ?? "") {
      const kind = ch === "\n" ? "end" : "text";
      atoms.push({
        ...base,
        kind,
        key: ch,
        index,
        size: ch.length,
        ...(kind === "end" ? { styleChanges: [] } : restyle),
      });
      index += ch.length;
    }
    return atoms;
  }
  const rule = ELEMENTS.find((r) => pe[r.field]);
  const { key, nodes } = rule ? rule.read(pe, ctx) : opaque(pe);
  return [{ ...base, kind: "element", key, nodes, index: startIndex ?? 0, size: 1, ...restyle }];
}

type TextStyle = docs_v1.Schema$TextStyle;
type StyleChange = docs_v1.Schema$SuggestedTextStyle;

/** Suggested changes in the order they apply: those of the insertion `first` (how it was inserted), then others. */
const ordered = <T>(changes: Record<string, T>, first?: string) =>
  Object.entries(changes).toSorted(([a], [b]) => Number(b === first) - Number(a === first));

/** The paragraph's style and bullet once the suggested changes to them are accepted; `insertion` is the
 * suggestion that inserted it. */
function suggestedParagraph(p: docs_v1.Schema$Paragraph, insertion?: string): docs_v1.Schema$Paragraph {
  let { namedStyleType } = p.paragraphStyle ?? {};
  let bullet = p.bullet;
  for (const [, c] of ordered(p.suggestedParagraphStyleChanges ?? {}, insertion))
    if (c.paragraphStyleSuggestionState?.namedStyleTypeSuggested) namedStyleType = c.paragraphStyle?.namedStyleType;
  for (const [, c] of ordered(p.suggestedBulletChanges ?? {}, insertion)) {
    const state = c.bulletSuggestionState ?? {};
    if (state.listIdSuggested && !c.bullet?.listId) bullet = undefined;
    else if (state.listIdSuggested || state.nestingLevelSuggested) bullet = { ...bullet, ...c.bullet };
  }
  return { ...p, paragraphStyle: { ...p.paragraphStyle, namedStyleType }, bullet };
}

/** The text style once the suggested changes are accepted: each changes the fields it marks as suggested. */
function suggested(style: TextStyle = {}, changes: [string, StyleChange][]): TextStyle {
  const out: Record<string, unknown> = { ...style };
  for (const [, change] of changes)
    for (const [flag, on] of Object.entries(change.textStyleSuggestionState ?? {})) {
      const field = flag.replace(/Suggested$/, "") as keyof TextStyle;
      if (on) out[field] = change.textStyle?.[field];
    }
  return out as TextStyle;
}
