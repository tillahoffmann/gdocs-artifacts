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
  MARKS,
  type Marks,
  opaque,
  type Props,
  raw,
  readMarks,
} from "./rules.js";

type Tab = docs_v1.Schema$DocumentTab;
type Comment = docs_v1.Schema$CommentThread;

export type Atom = {
  /** A code point of text, an inline element, a paragraph's end (its "\n"), a table or block boundary, or a
   * comment annotation: a zero-width marker where a thread's anchor starts or ends, or the thread itself. */
  kind: "text" | "element" | "end" | "boundary" | "annotation";
  /** What the diff compares: the character, the element's identity, the boundary ("table", "row", "cell",
   * "/table" or a block token), or the annotation ("{==", "==}", or "{>>c:<id><<}" for a thread). */
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
};

/** A placeholder ID for a suggestion that docmd adds; it can't be written in docmd. */
export const fresh = (k: number) => `\u0000${k}`;
export const isFresh = (id?: string) => !!id?.startsWith("\u0000");

/** The IDs of the suggestions on the atoms. */
export const suggestions = (atoms: Atom[]) =>
  new Set(atoms.flatMap((a) => [a.ins, a.del, ...a.styleChanges]).filter((id): id is string => id !== undefined));

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

/** The tab's atoms, with the given threads as annotations; `unanchored` threads go at the end of the body. */
export function fromDoc(tab: Tab, threads: Thread[] = [], unanchored: Comment[] = []): Segment[] {
  const footnotes: string[] = [];
  const ctx: Context = {
    tab,
    threads,
    segmentId: "",
    counters: {},
    footnoteLabel(id) {
      if (!footnotes.includes(id)) footnotes.push(id);
      return String(footnotes.indexOf(id) + 1);
    },
  };
  const body = structural(ctx, tab.body?.content ?? []);
  const last = body.at(-1);
  const end = (last?.index ?? 0) + (last?.size ?? 0);
  for (const c of unanchored) body.push(threadAnnotation(c, end));
  const segments = [{ id: "", atoms: body }];
  for (const id of footnotes) {
    ctx.segmentId = id;
    segments.push({ id, atoms: structural(ctx, tab.footnotes?.[id]?.content ?? []) });
  }
  return segments;
}

type Context = ElementContext & {
  threads: Thread[];
  /** The segment being read: "" for the body, else a footnote ID. Comment ranges are per segment. */
  segmentId: string;
  counters: Record<string, number[]>;
};

const annotation = (key: string, index: number, thread: string): Atom => ({
  kind: "annotation",
  key,
  marks: {},
  index,
  size: 0,
  styleChanges: [],
  thread,
});

/** A thread as docmd: `{>>c:<id>[ resolved ·] Author: text · Author: reply<<}`. */
function threadAnnotation(c: Comment, index: number): Atom {
  const posts = [c.headPost, ...(c.replies ?? [])].map(
    (p) => `${p?.author?.displayName ?? "Unknown"}: ${(p?.content ?? "").replace(/\s*\n\s*/g, " ")}`,
  );
  const resolved = c.status === "RESOLVED" ? " resolved ·" : "";
  const id = c.commentId ?? "";
  return {
    ...annotation(`{>>c:${id}<<}`, index, id),
    nodes: [raw(`{>>c:${id}${resolved} ${field(posts.join(" · "))}<<}`)],
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
      const first = shown.find(inRange);
      if (!first) continue;
      const after = shown[shown.findLastIndex(inRange) + 1] ?? end;
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
  const added = content.length > 0 && content.every((a) => a.ins);
  const style = added ? suggestedParagraph(p, content[0]?.ins) : p;
  const bullet = style.bullet;
  end.props =
    bullet && !inCell
      ? {
          heading: 0,
          list: {
            id: bullet.listId ?? "",
            level: bullet.nestingLevel ?? 0,
            ordered: isOrdered(ctx.tab, bullet.listId ?? "", bullet.nestingLevel ?? 0),
            number: count(ctx, bullet.listId ?? "", bullet.nestingLevel ?? 0),
          },
        }
      : { heading: inCell ? 0 : headingLevel(style) };
  // Paragraph-level suggestions (style or bullet changes), unless the whole paragraph is a suggestion.
  const inserted = new Set(atoms.map((a) => a.ins));
  end.styleChanges = added
    ? []
    : Object.keys({ ...p.suggestedParagraphStyleChanges, ...p.suggestedBulletChanges }).filter(
        (id) => !inserted.has(id),
      );
  // A paragraph style suggestion also shows on the paragraph's text; it's shown once, at the paragraph's end.
  for (const a of atoms) {
    if (a === end) continue;
    a.styleChanges = a.styleChanges.filter((id) => !end.styleChanges.includes(id));
    if (!a.styleChanges.length) a.restyled = undefined;
  }

  shape(atoms.slice(0, -1), end);
  return annotate(ctx, atoms);
}

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
  const shown = views(content.filter((a) => !a.hidden));
  for (const mark of ["bold", "italic", "strike"]) trimWhitespace(shown, mark);
  // Chips and line breaks aren't text, so they don't show as code.
  for (const v of shown) if ((v.atom.kind === "element" || v.atom.key === "\u000b") && get(v)[CODE]) without(v, CODE);
  if (!end.props?.list && content.every((a) => a.hidden)) end.hidden = true;
}

/** Parsed segments as the doc would show them once written: without spaces at paragraph edges, and so on. */
export function asShown(segments: Segment[]): Segment[] {
  return segments.map(({ id, atoms }) => {
    const copy = atoms.map((a) => ({ ...a }));
    let start = 0;
    let cell: Atom[] | undefined;
    copy.forEach((a, k) => {
      if (a.kind === "end") {
        const atoms = copy.slice(start, k).filter((b) => b.kind !== "annotation");
        shape(atoms, a);
        // Formatting suggested where it doesn't change anything isn't written, so it doesn't show.
        for (const b of atoms)
          if (b.styleChanges.some(isFresh) && MARKS.every((m) => b.marks[m.name] === b.restyled?.[m.name])) {
            b.styleChanges = [];
            b.restyled = undefined;
          }
      }
      if (a.kind === "end") cell?.push(a);
      if (a.kind === "boundary") {
        showEmptyCell(cell);
        cell = a.key === "cell" ? [] : undefined;
      }
      if (a.kind === "end" || a.kind === "boundary") start = k + 1;
    });
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

/** Hides spaces and tabs at the paragraph's edges, which Markdown can't express, unless a suggestion is on them. */
function hideEdges(atoms: Atom[]) {
  const edge = (a: Atom) => !a.hidden && blank(a) && !a.ins && !a.del;
  for (const a of atoms) {
    if (!edge(a)) break;
    a.hidden = true;
  }
  for (const a of atoms.toReversed()) {
    if (!edge(a)) break;
    a.hidden = true;
  }
}

/** Bold, italic and strikethrough spans don't start or end with whitespace, which Markdown can't express. */
function trimWhitespace(shown: View[], mark: string) {
  const trim = (span: View[]) => {
    for (const v of span) {
      if (!(blank(v.atom) || v.atom.key === "\u000b")) break;
      without(v, mark);
    }
  };
  let span: View[] = [];
  for (const v of [...shown, undefined]) {
    if (v && get(v)[mark]) {
      span.push(v);
      continue;
    }
    trim(span);
    trim(span.toReversed());
    span = [];
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
  const restyle = changes.length
    ? { styleChanges: changes.map(([id]) => id), restyled: readMarks(suggested(value.textStyle, changes)) }
    : { styleChanges: [] };

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
