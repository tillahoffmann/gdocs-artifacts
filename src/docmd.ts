// docmd: one tab of a Google Doc as Markdown, with open comment threads and pending suggestions inline as
// CriticMarkup, chips as {{…}} tokens, and {{opaque:…}} tokens for anything without a Markdown form.
// `render` goes from the doc to docmd, `parse` (parse.ts) from docmd back to the same atoms, so that an edited
// docmd can be compared with the doc.
//
// CriticMarkup is a layer over the text: with every change rejected, docmd reads as the doc as it is, and with
// every change accepted, as the doc once they are. So docmd is rendered that way round: each of the two texts
// is Markdown from the standard serializer, and the CriticMarkup marks where they differ, change by change.
// Each reading of what's rendered is then Markdown that reads as what it was rendered from.

import { diffArrays } from "diff";
import type { docs_v1 } from "googleapis";
import type { Heading, List, ListItem, Paragraph, Parent, PhrasingContent, RootContent, Table, TableCell } from "mdast";
import { gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { defaultHandlers, type Options, toMarkdown } from "mdast-util-to-markdown";
import { adopt } from "./actions.js";
import { ToolError } from "./errors.js";
import { type Atom, anchored, fromDoc, isThread, paragraphs, posts, reblocks, restyleKey, type Segment } from "./ir.js";
import { escapeCell, LINE_BREAK, parse, type Reading, readMarkdown, Unsupported, WRAPPERS } from "./parse.js";
import { isCode, type Marks, type Props, raw, sameMarks } from "./rules.js";

export { parse, Unsupported };

type Doc = docs_v1.Schema$Document;
type Tab = docs_v1.Schema$DocumentTab;

export type RenderOptions = {
  /** Defaults to the first tab. */
  tabId?: string;
  /** Which comment threads to show: open ones (default), all (resolved ones marked), or none. */
  comments?: "open" | "all" | "none";
  /** Only the section under the heading with this text, down to the next heading of the same or a higher level. */
  section?: string;
};

export const render = (doc: Doc, opts: RenderOptions = {}) => toDocmd(load(doc, opts).segments, opts);

/** The tab's atoms, with the threads `opts.comments` asks for as annotations. */
export function load(doc: Doc, opts: RenderOptions = {}) {
  const tab = findTab(doc, opts.tabId);
  const mode = opts.comments ?? "open";
  const shown = (doc.comments ?? []).filter((c) => mode === "all" || (mode === "open" && c.status === "OPEN"));
  const threads = anchored(tab, shown);
  const isFirstTab = !opts.tabId || opts.tabId === doc.tabs?.[0]?.tabProperties?.tabId;
  // Threads whose text was deleted have no anchor left; they go at the end of the first tab.
  const unanchored = isFirstTab && !opts.section ? shown.filter((c) => !threads.some((t) => t.comment === c)) : [];
  return { tab, threads, segments: fromDoc(tab, threads, unanchored) };
}

export function findTab(doc: Doc, tabId?: string): Tab {
  const all = (tabs: docs_v1.Schema$Tab[]): docs_v1.Schema$Tab[] => tabs.flatMap((t) => [t, ...all(t.childTabs ?? [])]);
  const tab = all(doc.tabs ?? []).find((t) => !tabId || t.tabProperties?.tabId === tabId)?.documentTab;
  if (!tab) throw new Error(tabId ? `no tab ${tabId}` : "doc has no tabs");
  return tab;
}

// ---- Rendering ----

const MARKDOWN_OPTIONS: Options = {
  bullet: "-",
  listItemIndent: "one",
  incrementListMarker: true,
  extensions: [gfmStrikethroughToMarkdown(), gfmTableToMarkdown({ tablePipeAlign: false }), gfmFootnoteToMarkdown()],
  // Doc text never reads as docmd's own syntax: every literal `{` is escaped, and so is `}` after + - ~ =
  // (which would close CriticMarkup), `>` after ~, and `@` before a link.
  unsafe: [
    { character: "{", inConstruct: "phrasing" },
    // A backslash too, so that none escapes the CriticMarkup after it.
    { character: "\\", inConstruct: "phrasing" },
    { character: "}", before: "[+\\-~=]", inConstruct: "phrasing" },
    { character: ">", before: "~", inConstruct: "phrasing" },
    // "@" right before a mailto link is a person chip.
    { character: "@", after: "[\\[<]", inConstruct: "phrasing" },
    // "<" before what could be an email address would start an autolink.
    { character: "<", after: "[\\w.!#$%&'*+/=?^`{|}~-]", inConstruct: "phrasing" },
  ],
  handlers: {
    // An item of a numbered list shows its number in the doc, in both readings of the docmd alike.
    listItem(node, parent, state, info) {
      const number = (node.data as { number?: number } | undefined)?.number;
      const list = parent?.type === "list" && parent.ordered && number ? { ...parent, start: number } : undefined;
      return defaultHandlers.listItem(node, list ? { ...list, children: [node] } : parent, state, info);
    },
  },
};

/** docmd for the segments: the body (or one section of it), then its footnotes. */
export const toDocmd = (segments: Segment[], opts: { section?: string } = {}) => renderTab(segments, opts).docmd;

/** A paragraph that docmd can't show as it is (see `renderTab`): the doc's atoms of it, and its token. */
export type Opaque = { atoms: Atom[]; key: string };

/**
 * docmd for the segments, read back to check that it reads as them. A paragraph that doesn't (docmd can't show
 * every combination of suggestions in code, for one) is shown as {{opaque:paragraph:<its text>}}, with its
 * threads' comments after it, and listed in `opaque`: edits keep it as it is.
 */
export function renderTab(segments: Segment[], opts: { section?: string } = {}) {
  const [body, ...footnotes] = segments;
  const atoms = opts.section ? section(body?.atoms ?? [], opts.section) : (body?.atoms ?? []);
  const subject = [{ id: body?.id ?? "", atoms }, ...footnotes];
  const tokens = new Set<Atom>();
  for (let round = 0; ; round++) {
    const { segments: tab, opaque, ends } = withOpaque(subject, tokens);
    const { docmd, failing } = check(tab);
    const more = failing.map((e) => ends.get(e) ?? e).filter((e) => !tokens.has(e));
    if (docmd !== undefined && (!more.length || round >= 3)) return { docmd, opaque, segments: tab };
    if (round > 4) throw new Error("docmd can't render the tab");
    // Paragraphs that don't read back, as tokens; if that doesn't do, every paragraph.
    for (const e of round < 3 ? more : subject.flatMap((s) => s.atoms.filter((a) => a.kind === "end"))) tokens.add(e);
  }
}

/** The segments with the paragraphs that end with `ends` as opaque tokens; and, for each paragraph end in them,
 * the doc's. */
function withOpaque(segments: Segment[], ends: Set<Atom>) {
  const opaque: Opaque[] = [];
  const of = new Map<Atom, Atom>();
  const out = segments.map(({ id, atoms }) => {
    if (!ends.size) return { id, atoms };
    const result: Atom[] = [];
    for (const { content, end } of paragraphs(atoms)) {
      if (!end || !ends.has(end)) {
        result.push(...content, ...(end ? [end] : []));
        continue;
      }
      // Its text as it is, for what it says: without the characters that would need escaping (in a table cell,
      // too).
      const text = content
        .filter((a) => !a.hidden && a.kind === "text" && !a.ins)
        .map((a) => (/^[\\{}|]$/.test(a.key) || a.key === "\u000b" ? " " : a.key))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const key = `{{opaque:paragraph:${text}}}`;
      opaque.push({ atoms: [...content, end].filter((a) => !a.hidden), key });
      const token: Atom = { kind: "element", key, marks: {}, styleChanges: [], nodes: [raw(key)] };
      const threads = content.filter(isThread);
      const plain: Atom = { ...end, ins: undefined, del: undefined, styleChanges: [], reprops: undefined };
      of.set(plain, end);
      result.push(token, ...threads, plain);
    }
    return { id, atoms: result };
  });
  return { segments: out, opaque, ends: of };
}

/** The docmd of the segments, if it parses, and the ends of the paragraphs it doesn't read back as. */
function check(segments: Segment[], alone = false): { docmd?: string; failing: Atom[] } {
  /** Which paragraphs it is, when that isn't known: each that doesn't read back on its own. */
  const find = () => (alone ? segments.flatMap((s) => s.atoms.filter((a) => a.kind === "end")) : localize(segments));
  let docmd: string;
  let steps: Item[];
  try {
    ({ docmd, steps } = merged(segments));
  } catch (e) {
    if (!(e instanceof RenderError)) throw e;
    const end = e.atom && paragraphEnd(segments, e.atom);
    return { failing: end ? [end] : find() };
  }
  let parsed: Segment[];
  try {
    parsed = adopt(
      segments,
      parse(
        docmd,
        segments.slice(1).map((s) => s.id),
      ),
    );
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    // The paragraph of the atom at it, or after it.
    const where = e.at ?? Number.POSITIVE_INFINITY;
    const after = steps.find((s) => s.src && s.out !== undefined && s.out >= where)?.src;
    const end = after && paragraphEnd(segments, after);
    return { failing: end ? [end] : find() };
  }
  const failing: Atom[] = [];
  for (const seg of segments) {
    const read = parsed.find((p) => p.id === seg.id);
    if (!read) continue;
    const a = shownParagraphs(seg.atoms);
    const b = shownParagraphs(read.atoms);
    let i = 0;
    for (const c of diffArrays(
      a.map((p) => p.text),
      b.map((p) => p.text),
    )) {
      const n = c.count ?? c.value.length;
      if (c.removed) for (const p of a.slice(i, i + n)) if (p.end) failing.push(p.end);
      if (!c.added) i += n;
    }
  }
  return { docmd, failing };
}

/** The ends of paragraphs that don't read back as themselves on their own. */
function localize(segments: Segment[]): Atom[] {
  const failing: Atom[] = [];
  for (const { id, atoms } of segments)
    for (const { content, end } of paragraphs(atoms)) {
      if (end?.kind !== "end") continue;
      const one = [{ id, atoms: [...content, end] }];
      if (check(one, true).failing.length) failing.push(end);
    }
  return failing;
}

/** The end of the paragraph `atom` is in. */
function paragraphEnd(segments: Segment[], atom: Atom) {
  for (const { atoms } of segments) {
    const k = atoms.indexOf(atom);
    if (k >= 0) return atoms.slice(k).find((a) => a.kind === "end" || a.kind === "boundary");
  }
  return undefined;
}

/** The atoms of the section under the heading `title`. */
function section(atoms: Atom[], title: string): Atom[] {
  const heads: { title: string; level: number; start: number }[] = [];
  let start = 0;
  for (const { content, end } of paragraphs(atoms)) {
    const level = end?.props?.heading ?? 0;
    const text = content.map((b) => (b.kind === "text" ? b.key : "")).join("");
    if (level) heads.push({ title: text.trim(), level, start });
    start += content.length + 1;
  }
  const head = heads.find((h) => h.title === title);
  if (!head) {
    const list = heads.length ? `Headings: ${heads.map((h) => `"${h.title}"`).join(", ")}.` : "The tab has none.";
    throw new ToolError("section_not_found", `No heading "${title}". ${list}`);
  }
  const next = heads.find((h) => h.start > head.start && h.level <= head.level);
  return atoms.slice(head.start, next?.start);
}

// ---- The two readings ----

type Side = "old" | "new";
const SIDES = ["old", "new"] as const;

/**
 * One step of the docmd, in order: an atom of the text with every suggestion rejected (`old`), accepted
 * (`new`), or both; a comment's markup (`note`); or the start of a suggested change of what block a
 * paragraph is (`block`). An atom that isn't the same in both readings is in a change, `unit`.
 */
type Item = {
  old?: Atom;
  new?: Atom;
  unit?: string;
  /** In a suggested deletion of suggested text: a deletion inside the insertion. */
  nested?: boolean;
  note?: string;
  /** A thread without an anchor, on a line of its own after the body. */
  tail?: boolean;
  block?: boolean;
  /** The atom of the doc it is, and where it is in the docmd. */
  src?: Atom;
  out?: number;
  /** Which reading's Markdown to write a shared atom as, if not the old one's. */
  literal?: Side;
  /** Where the atom's Markdown is in each reading, once rendered; for a paragraph end, where its block starts. */
  at?: Partial<Record<Side, [number, number]>>;
  start?: Partial<Record<Side, number>>;
};

/** The comment markup of an annotation. */
const note = (a: Atom) => posts(a).join("") || a.key;

/** The steps of a segment's docmd. */
function items(atoms: Atom[], body: boolean): Item[] {
  const out: Item[] = [];
  let cell = false;
  /** Whether each reading has text since its last paragraph end. */
  const text: Record<Side, boolean> = { old: false, new: false };
  for (const { content, end } of paragraphs(atoms)) {
    if (end?.kind === "boundary") {
      if (end.key === "cell") cell = true;
      if (end.key === "/table") cell = false;
      text.old = text.new = false;
      out.push({ old: end, new: end, src: end });
      continue;
    }
    if (end?.hidden) continue;
    if (!end && content.every((a) => a.kind === "annotation")) {
      // Threads without an anchor, one to a line.
      for (const a of content) out.push({ note: note(a), tail: body });
      continue;
    }
    const steps: Item[] = [];
    const shown = content.filter((a) => !a.hidden);
    // In a table cell, a comment's "|" is escaped, as GFM has it, so that the table reads as one anywhere.
    const noteText = (a: Atom) => (cell ? note(a).replace(/\|/g, "\\|") : note(a));
    // Text with style changes reads as it is when they're rejected, formatted as suggested when they're
    // accepted: {~~a~>**a**~~}. Comment markup in it goes in the first part.
    for (let k = 0; k < shown.length; ) {
      const a = shown[k] as Atom;
      if (a.kind === "annotation") {
        steps.push({ note: noteText(a) });
        k++;
        continue;
      }
      const ids = restyleKey(a);
      if (!ids) {
        steps.push(atomItem(a));
        k++;
        continue;
      }
      // The run, with the comment markup in it (not that after it).
      const unit = `style:${ids}`;
      const after: Item[] = [];
      let m = k;
      while (m < shown.length) {
        let q = m;
        while ((shown[q] as Atom | undefined)?.kind === "annotation") q++;
        const b = shown[q];
        if (!b || restyleKey(b) !== ids) break;
        for (; m < q; m++) steps.push({ note: noteText(shown[m] as Atom) });
        steps.push({ old: b, unit, src: b });
        after.push({ new: { ...b, marks: b.restyled ?? b.marks }, unit, src: b });
        m = q + 1;
      }
      steps.push(...after);
      k = m;
    }
    if (end) {
      // A suggested change of what block the paragraph is (a heading level, a list item) is a change of its
      // Markdown at the start of its line; on a line without other markup, of the whole line.
      const reblocked = !cell && !!end.reprops && end.styleChanges.length > 0 && reblocks(end.props, end.reprops);
      if (reblocked) {
        const unit = `block:${end.styleChanges.join(" ")}`;
        const plain = steps.every((s) => s.note === undefined && !s.unit && s.old && s.new);
        out.push({ block: true, unit });
        if (plain) for (const s of steps) s.unit = unit;
      }
      out.push(...steps);
      const item = atomItem(end);
      if (reblocked && item.new) item.new = { ...item.new, props: end.reprops };
      // Markdown has no empty paragraphs (docmd doesn't show them): a paragraph without text in a reading
      // isn't in it, and its end goes with the change of its text. A paragraph whose end isn't in a reading
      // joins the next there, so its text counts for the next end that is.
      for (const side of SIDES) {
        if (steps.some((s) => s.note === undefined && s[side])) text[side] = true;
        const p = item[side]?.props;
        if (!item[side]) continue;
        if (!cell && !p?.heading && !p?.list && !text[side]) {
          item[side] = undefined;
          item.unit ??= steps.findLast((s) => s.unit)?.unit;
        }
        text[side] = false;
      }
      if (item.old || item.new) out.push(item);
    } else out.push(...steps);
  }
  return out;
}

/** An atom's step: in the readings it's in. */
function atomItem(a: Atom): Item {
  if (a.ins && a.del) return { new: a, unit: a.ins, nested: true, src: a };
  if (a.ins) return { new: a, unit: a.ins, src: a };
  if (a.del) return { old: a, unit: a.del, src: a };
  return { old: a, new: a, src: a };
}

/** One reading's Markdown: its blocks, and the footnotes referenced in either reading. */
function readingTree(segments: { id: string; atoms: Atom[] }[], referenced: Set<string>): RootContent[] {
  const [body, ...footnotes] = segments;
  const root = blocks(body?.atoms ?? []);
  footnotes.forEach(({ id, atoms }, i) => {
    if (!referenced.has(id)) return;
    root.push({ type: "footnoteDefinition", identifier: String(i + 1), children: blocks(atoms) as Paragraph[] });
  });
  return root;
}

function blocks(atoms: Atom[]): RootContent[] {
  const root: RootContent[] = [];
  let lists: { list: List; level: number; id: string }[] = [];
  let table: Table | undefined;
  let cell: TableCell | undefined;
  let cellParagraphs = 0;

  for (const { content, end } of paragraphs(atoms)) {
    const list = end?.props?.list;
    if (!list || table) lists = [];
    if (end?.kind === "boundary") {
      if (end.key === "table") {
        table = { type: "table", children: [] };
        root.push(table);
      } else if (end.key === "row") table?.children.push({ type: "tableRow", children: [] });
      else if (end.key === "cell") {
        cell = { type: "tableCell", children: [] };
        cellParagraphs = 0;
        table?.children.at(-1)?.children.push(cell);
      } else if (end.key === "/table") {
        table = undefined;
        cell = undefined;
      } else root.push({ type: "paragraph", children: end.nodes ?? [] });
      continue;
    }
    const children = phrasing(content, !!cell);
    if (cell) {
      // Cells hold inline content only; their paragraphs are separated by <br>.
      if (cellParagraphs++) cell.children.push(raw(LINE_BREAK));
      cell.children.push(...children);
    } else if (list) {
      if (lists[0] && lists[0].id !== list.id) lists = [];
      while ((lists.at(-1)?.level ?? -1) > list.level) lists.pop();
      let top = lists.at(-1);
      // A list that skips levels gets an item without text at each level it skips.
      while (!top || top.level < list.level) {
        const level = (top?.level ?? -1) + 1;
        const start = level === list.level ? list.number : 1;
        const l: List = { type: "list", ordered: list.ordered, start, spread: false, children: [] };
        if (level < list.level) l.children.push({ type: "listItem", spread: false, children: [] });
        const parent = top?.list.children.at(-1);
        // An item without text, with items under it, has an empty paragraph: "-" on a line of its own, where
        // "- - item" is a level that the list skips.
        if (parent && !parent.children.length && parent.data) parent.children.push({ type: "paragraph", children: [] });
        (parent ? parent.children : root).push(l);
        top = { list: l, level, id: list.id };
        lists.push(top);
      }
      // (An item without text has no paragraph: the serializer then keeps it from reading as a heading's underline.)
      const item: ListItem = {
        type: "listItem",
        spread: false,
        children: children.length ? [{ type: "paragraph", children }] : [],
      };
      item.data = { number: list.number } as ListItem["data"];
      top.list.children.push(item);
    } else {
      const depth = end?.props?.heading;
      root.push(depth ? ({ type: "heading", depth, children } as Heading) : { type: "paragraph", children: children });
    }
  }
  return root;
}

/** A paragraph's text and elements as Markdown. */
function phrasing(atoms: Atom[], cell: boolean): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  const stack: { key: string; children: PhrasingContent[] }[] = [];
  const container = () => stack.at(-1)?.children ?? children;
  const content = atoms.filter((a) => a.kind !== "annotation");
  // Whitespace at a paragraph's edges (where a suggestion leaves it) is a character reference: Markdown would drop
  // it.
  const blank = (a?: Atom) => a?.kind === "text" && (a.key === " " || a.key === "\t") && !isCode(a.marks);
  let first = 0;
  while (blank(content[first])) first++;
  let last = content.length;
  while (last > first && blank(content[last - 1])) last--;
  for (const [k, a] of content.entries()) {
    // Wrappers that are open stay open; new ones open inside them.
    const keys = wrapperKeys(a.marks);
    let keep = 0;
    while (keep < stack.length && keys.includes(stack[keep]?.key ?? "")) keep++;
    stack.length = keep;
    for (const key of keys.filter((k) => !stack.some((w) => w.key === k))) {
      const node = wrapper(key);
      container().push(node);
      stack.push({ key, children: node.children });
    }
    if (k < first || k >= last) container().push(raw(a.key === " " ? "&#x20;" : "&#x9;"));
    else push(container(), a, cell);
  }
  return children;
}

function wrapperKeys(marks: Marks) {
  return WRAPPERS.flatMap((m) => (marks[m.name] ? [`${m.name}:${marks[m.name]}`] : []));
}

function wrapper(key: string): Extract<PhrasingContent, Parent> {
  const name = key.slice(0, key.indexOf(":"));
  const value = key.slice(name.length + 1);
  const type = WRAPPERS.find((m) => m.name === name)?.mdast;
  if (type === "link") return { type, url: value, children: [] };
  return { type: type as "strong" | "emphasis" | "delete", children: [] };
}

function push(into: PhrasingContent[], a: Atom, cell: boolean) {
  const last = into.at(-1);
  const code = isCode(a.marks);
  if (a.nodes) into.push(...a.nodes.map((n) => (cell && n.type === "html" ? raw(escapeCell(n.value)) : n)));
  else if (a.key === "\u000b") into.push(raw(LINE_BREAK));
  else if (code && last?.type === "inlineCode") last.value += a.key;
  else if (code) into.push({ type: "inlineCode", value: a.key });
  else if (last?.type === "text") last.value += a.key;
  else into.push({ type: "text", value: a.key });
}

/** Rendering went wrong: a reading of the docmd doesn't read back as the atoms it was rendered from. */
class RenderError extends Error {
  constructor(
    message: string,
    /** The atom it went wrong at, if it's known. */
    readonly atom?: Atom,
  ) {
    super(message);
  }
}

/** One reading's Markdown read back, with where each of its atoms is in it. */
function read(text: string, segments: { id: string }[]): Reading {
  try {
    return readMarkdown(
      text,
      segments.slice(1).map((s) => s.id),
    );
  } catch (e) {
    throw new RenderError(`a reading doesn't read as Markdown: ${(e as Error).message}`);
  }
}

/** Matches the atoms of a reading to where they are in its Markdown. */
function locate(steps: Item[], side: Side, read: Reading) {
  const parsed = read.segments.flatMap((s) => s.atoms);
  let j = 0;
  for (const s of steps) {
    const a = s[side];
    if (!a) continue;
    const p = parsed[j++];
    const same =
      p &&
      p.kind === a.kind &&
      (p.key === a.key || a.kind === "element" || a.kind === "boundary") &&
      (a.kind !== "text" || sameMarks(p.marks, a.marks));
    if (!same)
      throw new RenderError(
        `the ${side} reading reads ${p?.kind} ${JSON.stringify(p?.key)} for ${a.kind} ${JSON.stringify(a.key)}`,
        a,
      );
    s.at = { ...s.at, [side]: [read.source.get(p) ?? 0, read.end.get(p) ?? 0] };
    if (p.kind === "end") s.start = { ...s.start, [side]: read.start.get(p) };
  }
  // Content without an end reads as a paragraph with one.
  if (parsed.slice(j).some((p) => p.kind !== "end"))
    throw new RenderError(`the ${side} reading reads more`, steps.findLast((s) => s[side])?.[side]);
}

/** The docmd of the segments: their two readings, and the CriticMarkup between them. */
function merged(segments: { id: string; atoms: Atom[] }[]) {
  const bySegment = segments.map((seg, k) => items(seg.atoms, k === 0));
  const steps = bySegment.flat();
  // Footnotes referenced in either reading are in both.
  const referenced = new Set(
    steps.flatMap((s) => SIDES.flatMap((side) => (s[side]?.key.startsWith("footnote:") ? [s[side].key.slice(9)] : []))),
  );
  const texts = {} as Record<Side, string>;
  const reads = {} as Record<Side, Reading>;
  for (const side of SIDES) {
    const own = segments.map((seg, k) => ({
      id: seg.id,
      atoms: (bySegment[k] ?? []).flatMap((s) => (s[side] ? [s[side]] : [])),
    }));
    const text = toMarkdown({ type: "root", children: readingTree(own, referenced) }, MARKDOWN_OPTIONS);
    texts[side] = text;
    reads[side] = read(text, own);
    locate(steps, side, reads[side]);
  }
  return { docmd: weave(steps, texts, reads), steps };
}

// ---- The CriticMarkup between them ----

/** Pieces of docmd: text outside CriticMarkup (in both readings), a change's text in one reading, CriticMarkup,
 * and comment markup. */
type Piece =
  | { kind: "text"; side: Side | "both"; old?: [number, number]; new?: [number, number]; unit?: number }
  | { kind: "mark"; value: string; role: "open" | "mid" | "close"; unit: number }
  | { kind: "note"; value: string };

/** A change: its steps, and where its atoms are in each reading. */
type Unit = { id: string; block: boolean; items: Item[]; range: Partial<Record<Side, [number, number]>> };

/** Markdown's tokens, which the CriticMarkup goes between: an escape, a character reference, a run of the same
 * punctuation (a delimiter), or a character. */
const TOKEN = /\\[\s\S]|&#?\w+;|([!-/:-@[-`{-~])\1*|[\s\S]/gu;

/** The length of the longest common prefix (or suffix) of two strings, in whole tokens. */
function common(a: string, b: string, end: boolean, only?: (t: string) => boolean) {
  const x = a.match(TOKEN) ?? [];
  const y = b.match(TOKEN) ?? [];
  if (end) {
    x.reverse();
    y.reverse();
  }
  let n = 0;
  for (let k = 0; k < x.length && x[k] === y[k] && (!only || only(x[k] as string)); k++) n += (x[k] as string).length;
  return n;
}

/**
 * CriticMarkup isn't read in code, so a change in a code span takes all of it (in both readings: a substitution
 * of the code).
 */
function codeSpans(steps: Item[], reads: Record<Side, Reading>): Item[] {
  // Each code span's steps, from its first atom to its last (with those of the other reading between them).
  const spans: [number, number][] = [];
  for (const side of SIDES) {
    let k = 0;
    for (const [from, to] of reads[side].codes) {
      while (k < steps.length && !((steps[k]?.at?.[side]?.[0] ?? -1) >= from)) k++;
      let last = -1;
      for (let q = k; q < steps.length; q++) {
        const at = steps[q]?.at?.[side];
        if (!at) continue;
        if (at[1] > to) break;
        last = q;
      }
      if (last < 0) continue;
      // The backticks go with its first and last atoms.
      (steps[k]?.at?.[side] as [number, number])[0] = from;
      (steps[last]?.at?.[side] as [number, number])[1] = to;
      spans.push([k, last]);
    }
  }
  // Where each step's paragraph starts and ends: suggestions span paragraphs.
  const bounds: [number, number][] = [];
  for (let k = 0, start = 0; k < steps.length; k++) {
    const kind = steps[k]?.src?.kind;
    if (kind !== "end" && kind !== "boundary" && k < steps.length - 1) continue;
    for (let q = start; q <= k; q++) bounds[q] = [start, k];
    start = k + 1;
  }
  // The changes in a span are one, in both readings (in its paragraphs).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [first, last] of spans) {
      const inside = new Set(steps.slice(first, last + 1).filter((s) => s.note === undefined && !s.block));
      const unit = [...inside].find((s) => s.unit)?.unit;
      if (!unit) continue;
      const others = new Set([...inside].flatMap((s) => (s.unit && s.unit !== unit ? [s.unit] : [])));
      for (let q = bounds[first]?.[0] ?? first; q <= (bounds[last]?.[1] ?? last); q++) {
        const s = steps[q] as Item;
        if ((s.unit && others.has(s.unit)) || (!s.unit && inside.has(s))) {
          s.unit = unit;
          changed = true;
        }
      }
    }
  }
  return steps;
}

/** Interleaves the two readings: text in both once, and the rest as CriticMarkup changes. */
function weave(all: Item[], texts: Record<Side, string>, reads: Record<Side, Reading>): string {
  const slice = (side: Side, [from, to]: [number, number]) => texts[side].slice(from, to);
  // An atom in both readings that one writes as it is and the other escaped (a character reference, to keep
  // formatting from closing next to it, say) is written escaped: it reads the same in both. Except whitespace at
  // a paragraph's edge, which is written as it is, where that can't make or break any markup: Markdown drops it
  // there, and the parser keeps whitespace that's only in one reading. Atoms written differently otherwise are a
  // change (of nothing).
  let run: string | undefined;
  const escaped = (t: string, a: Atom) => t !== a.key && (t === `\\${a.key}` || /^&#?\w+;$/.test(t));
  /** Whether the reference in a reading can be whitespace as it is: at the start of a block's text and before a
   * letter, or at its end after a letter or digit. */
  const plain = (side: Side, [from, to]: [number, number]) => {
    const t = texts[side];
    if (!/^&#x(20|9);$/.test(t.slice(from, to))) return false;
    if (t[to] === "\n" || to === t.length) return /[\p{L}\p{N}]/u.test(t[from - 1] ?? "");
    return reads[side].contents.includes(from) && /\p{L}/u.test(t[to] ?? "");
  };
  for (const [k, s] of all.entries()) {
    const { old, new: next } = s.at ?? {};
    const a = s.old ?? s.new;
    if (old && next && a && !s.unit && slice("old", old) !== slice("new", next)) {
      const [o, n] = [slice("old", old), slice("new", next)];
      if (escaped(o, a) && n === a.key) s.literal = plain("old", old) ? "new" : "old";
      else if (escaped(n, a) && o === a.key) s.literal = plain("new", next) ? "old" : "new";
      else s.unit = run ??= `same:${k}`;
    } else if (s.note === undefined) run = undefined;
  }
  const steps = codeSpans(all, reads);
  let out = "";
  const pos: Record<Side, number> = { old: 0, new: 0 };
  let region: Item[] = [];
  for (const s of steps) {
    const { old, new: next } = s.at ?? {};
    if (s.tail) {
      out += flush(region, texts, reads, pos, out.length);
      region = [];
      out += `\n${s.note}\n`;
    } else if (old && next && !s.unit) {
      out += flush(region, texts, reads, pos, out.length, { old: old[0], new: next[0] });
      region = [];
      s.out = out.length;
      out += s.literal === "new" ? slice("new", next) : slice("old", old);
      pos.old = old[1];
      pos.new = next[1];
    } else region.push(s);
  }
  return out + flush(region, texts, reads, pos, out.length, { old: texts.old.length, new: texts.new.length });
}

/** Where the Markdown between two atoms splits: after the formatting that closes there, before that which opens;
 * at the start of a block's content. */
function split(read: Reading, from: number, to: number) {
  let at = from;
  for (const c of read.closes) if (c > at && c <= to) at = c;
  for (const c of read.contents) if (c >= from && c > at && c <= to) at = c;
  return at;
}

const other = (side: Side): Side => (side === "old" ? "new" : "old");

/**
 * The docmd of the steps between two atoms that are the same in both readings (or the start or end), up to
 * `anchor` in each reading (by default, the end of the last atom in it). Moves `pos` there.
 */
function flush(
  region: Item[],
  texts: Record<Side, string>,
  reads: Record<Side, Reading>,
  pos: Record<Side, number>,
  base: number,
  anchor?: Record<Side, number>,
): string {
  const end = (side: Side) => region.reduce((n, s) => Math.max(n, s.at?.[side]?.[1] ?? 0), pos[side]);
  const to = anchor ?? { old: end("old"), new: end("new") };
  const text = (side: Side, [from, until]: [number, number]) => texts[side].slice(from, until);
  // The changes, in order: runs of steps of the same suggestion. A deletion after an insertion of the same
  // suggestion is a change of its own; a deletion before one, with it, a substitution.
  const units: Unit[] = [];
  const unitOf = new Map<Item, number>();
  for (const s of region) {
    if (s.note !== undefined) continue;
    const last = units.at(-1);
    if (last && !s.block && last.id === s.unit && !(s.old && !s.new && last.items.some((x) => x.new && !x.old)))
      last.items.push(s);
    else units.push({ id: s.unit ?? "", block: !!s.block, items: s.block ? [] : [s], range: {} });
    unitOf.set(s, units.length - 1);
  }
  for (const u of units)
    for (const side of SIDES) {
      const spans = u.items.flatMap((s) => (s.at?.[side] ? [s.at[side]] : []));
      const [first, last] = [spans[0], spans.at(-1)];
      if (first && last) u.range[side] = [first[0], last[1]];
    }

  // What's before the first atom of each reading here and after its last; a reading without atoms here has
  // only Markdown, which goes before the other's atoms, or after them if they end a paragraph (whole lines).
  const lead = {} as Record<Side, [number, number]>;
  const trail = {} as Record<Side, [number, number]>;
  for (const side of SIDES) {
    const ranges = units.flatMap((u) => (u.range[side] ? [u.range[side]] : []));
    const first = ranges[0]?.[0];
    const last = ranges.at(-1)?.[1];
    if (first !== undefined && last !== undefined) {
      lead[side] = [pos[side], first];
      trail[side] = [last, to[side]];
    } else {
      // (Both, if neither reading has atoms here.)
      const last = region.findLast((s) => s[other(side)] && s.note === undefined)?.[other(side)];
      lead[side] = last?.kind === "end" ? [pos[side], pos[side]] : [pos[side], to[side]];
      trail[side] = last && last.kind !== "end" ? [to[side], to[side]] : [pos[side], to[side]];
    }
  }
  // Markdown the readings have in common there is outside the changes; before a block change, only blank lines.
  const block = units[0]?.block;
  const pre = common(text("old", lead.old), text("new", lead.new), false, block ? (t) => t === "\n" : undefined);
  for (const side of SIDES) lead[side][0] += pre;
  // (A block change keeps its block's markup, where the parser looks for it.)
  let post = block ? 0 : common(text("old", trail.old), text("new", trail.new), true);
  for (const side of SIDES) post = Math.min(post, trail[side][1] - Math.max(trail[side][0], lead[side][0]));
  for (const side of SIDES) trail[side][1] -= post;

  // Each change's text in each reading: its atoms and the Markdown between them; the Markdown between two
  // changes splits where formatting closes and opens. What's before the first atom goes with the first change
  // (the block change, if there is one), what's after the last with the last.
  const parts = units.map(() => ({}) as Partial<Record<Side, [number, number]>>);
  for (const side of SIDES) {
    const own = units.flatMap((u, k) => (u.range[side] ? [k] : []));
    if (!own.length) {
      const from = lead[side][0];
      const until = trail[side][1];
      if (until > from) {
        if (!units.length) {
          units.push({ id: "", block: false, items: [], range: {} });
          parts.push({});
        }
        const k = trail[side][0] < trail[side][1] && !block ? units.length - 1 : 0;
        parts[k] = { ...parts[k], [side]: [from, until] };
      }
      continue;
    }
    own.forEach((k, n) => {
      const r = units[k]?.range[side] as [number, number];
      const prev = units[own[n - 1] ?? -1]?.range[side];
      const next = units[own[n + 1] ?? -1]?.range[side];
      const from = prev ? split(reads[side], prev[1], r[0]) : block && k !== 0 ? r[0] : lead[side][0];
      const until = next ? split(reads[side], r[1], next[0]) : trail[side][1];
      parts[k] = { ...parts[k], [side]: [from, until] };
    });
    if (block && !parts[0]?.[side] && lead[side][1] > lead[side][0])
      parts[0] = {
        ...parts[0],
        [side]: [lead[side][0], units[own[0] ?? 0]?.range[side]?.[0] ?? lead[side][1]],
      };
  }

  // Line endings at the edges of the changes stay outside them, where each reading is at the start of a line
  // there: as blank lines in both readings, which Markdown reads the same between blocks. So a new paragraph is
  // {++…++} between blank lines, and a list item that's suggested to be a paragraph {~~- item~>item~~}.
  const edge = (end: boolean): Piece | undefined => {
    const runs = {} as Record<Side, { k?: number; at: number; n: number }>;
    for (const side of SIDES) {
      const own = units.flatMap((_, k) => (parts[k]?.[side] ? [k] : []));
      const k = end ? own.at(-1) : own[0];
      const p = k === undefined ? undefined : parts[k]?.[side];
      const n = p ? (text(side, p).match(end ? /\n*$/ : /^\n*/)?.[0].length ?? 0) : 0;
      runs[side] = { k, n, at: p ? (end ? p[1] - n : p[0]) : end ? to[side] - post : lead[side][0] };
    }
    // At the start of a line, after one that isn't a list item without text (which a blank line would end).
    const lineStart = (side: Side, at: number) => {
      const t = texts[side];
      return (
        at === 0 ||
        (t[at - 1] === "\n" && !/^\s*([-*+]|\d+[.)])$/.test(t.slice(t.lastIndexOf("\n", at - 2) + 1, at - 1)))
      );
    };
    // A paragraph end in the line endings goes with its paragraph, which has to be in the change; and the line
    // endings can be the ends of paragraphs of one reading only, which would otherwise read as one end.
    const ends = SIDES.map((side) =>
      region.filter((s) => {
        const at = s.at?.[side]?.[0];
        return (
          end && s.src?.kind === "end" && at !== undefined && at >= runs[side].at && at < runs[side].at + runs[side].n
        );
      }),
    );
    const whole = SIDES.every((side, k) => ends[k]?.every((s) => (s.start?.[side] ?? -1) >= lead[side][0]));
    const longest = runs.old.n >= runs.new.n ? "old" : "new";
    if (
      !runs[longest].n ||
      !whole ||
      (ends[0]?.length && ends[1]?.length) ||
      !SIDES.every((side) => (end && runs[side].n) || lineStart(side, runs[side].at))
    )
      return undefined;
    for (const side of SIDES) {
      const { k, n } = runs[side];
      const p = k === undefined ? undefined : parts[k]?.[side];
      if (!p || !n) continue;
      const rest: [number, number] = end ? [p[0], p[1] - n] : [p[0] + n, p[1]];
      (parts[k as number] as Partial<Record<Side, [number, number]>>)[side] = rest[1] > rest[0] ? rest : undefined;
    }
    const { at, n } = runs[longest];
    return { kind: "text", side: longest, [longest]: [at, at + n] } as Piece;
  };
  const before = edge(false);
  const after = edge(true);

  const pieces: Piece[] = [
    { kind: "text", side: "both", old: [pos.old, pos.old + pre], new: [pos.new, pos.new + pre] },
  ];
  if (before) pieces.push(before);
  units.forEach((u, k) => {
    const p = parts[k] ?? {};
    const mark = (value: string, role: "open" | "mid" | "close") => pieces.push({ kind: "mark", value, role, unit: k });
    const piece = (side: Side, range: [number, number]) =>
      pieces.push({ kind: "text", side, [side]: range, unit: k } as Piece);
    /** The new text, with a deletion in it around the atoms it deletes (around all of a code span: CriticMarkup
     * isn't read in one). */
    const inserted = (range: [number, number]) => {
      const runs: [number, number][] = [];
      for (let q = 0; q < u.items.length; ) {
        if (!u.items[q]?.nested) {
          q++;
          continue;
        }
        let r = q;
        while (u.items[r + 1]?.nested) r++;
        let from = u.items[q]?.at?.new?.[0] ?? range[0];
        let until = u.items[r]?.at?.new?.[1] ?? from;
        for (const [a, b] of reads.new.codes)
          if (a < until && b > from) [from, until] = [Math.min(from, a), Math.max(until, b)];
        const last = runs.at(-1);
        if (last && from <= last[1]) last[1] = Math.max(last[1], until);
        else runs.push([from, until]);
        q = r + 1;
      }
      let at = range[0];
      for (const [from, until] of runs) {
        if (from > at) piece("new", [at, from]);
        mark("{--", "open");
        piece("new", [from, until]);
        mark("--}", "close");
        at = until;
      }
      if (range[1] > at || !pieces.some((x) => x.kind === "text" && x.unit === k && x.side === "new"))
        piece("new", [at, range[1]]);
    };
    // A deletion and an insertion of the same text (not formatted differently) aren't a substitution, which
    // would read as a formatting change.
    const literal =
      !u.block && !/^(style|same):/.test(u.id) && p.old && p.new && text("old", p.old) === text("new", p.new);
    if (p.old && p.new && !literal) {
      mark("{~~", "open");
      piece("old", p.old);
      mark("~>", "mid");
      inserted(p.new);
      mark("~~}", "close");
      return;
    }
    if (p.old) {
      mark("{--", "open");
      piece("old", p.old);
      mark("--}", "close");
    }
    if (p.new) {
      mark("{++", "open");
      inserted(p.new);
      mark("++}", "close");
    }
  });
  if (after) pieces.push(after);
  pieces.push({ kind: "text", side: "both", old: [to.old - post, to.old], new: [to.new - post, to.new] });

  pos.old = to.old;
  pos.new = to.new;
  // The docmd, and where each atom is in it.
  let out = "";
  for (const p of placeNotes(region, unitOf, pieces, reads, pos, to)) {
    if (p.kind !== "text") {
      out += p.value;
      continue;
    }
    const side = p.side === "both" ? "old" : p.side;
    const [from, until] = p[side] ?? [0, 0];
    for (const s of region) {
      const at = s.at?.[side]?.[0];
      if (at !== undefined && s.out === undefined && at >= from && at < until) s.out = base + out.length + at - from;
    }
    out += texts[side].slice(from, until);
  }
  return out;
}

/**
 * The pieces, with each comment's markup where it is among the atoms: in a change if it's between two of the
 * change's atoms, else between the changes; in the text, where the Markdown between the atoms splits.
 */
function placeNotes(
  region: Item[],
  unitOf: Map<Item, number>,
  pieces: Piece[],
  reads: Record<Side, Reading>,
  pos: Record<Side, number>,
  to: Record<Side, number>,
): Piece[] {
  const out = [...pieces];
  let floor = 0;
  /** Inserts the note at `index`, after notes inserted before it. */
  const insert = (index: number, value: string) => {
    const at = Math.max(index, floor);
    out.splice(at, 0, { kind: "note", value });
    floor = at + 1;
  };
  /** Inserts the note in the text of `side` at `where`, among pieces that `fits`. */
  const inText = (side: Side, where: number, value: string, fits: (p: Piece) => boolean) => {
    let after = out.findLastIndex((p) => p.kind === "text" && fits(p) && (p[side]?.[1] ?? Infinity) <= where);
    for (let q = floor; q < out.length; q++) {
      const p = out[q] as Piece;
      if (p.kind !== "text" || !fits(p)) continue;
      const r = p[side];
      if (!r) continue;
      if (where > r[1]) {
        after = q;
        continue;
      }
      if (where > r[0] && where < r[1]) {
        const cut = where - r[0];
        const [a, b] = [{ ...p }, { ...p }];
        for (const sd of SIDES) {
          const rr = p[sd];
          if (rr) {
            a[sd] = [rr[0], rr[0] + cut];
            b[sd] = [rr[0] + cut, rr[1]];
          }
        }
        out.splice(q, 1, a, b);
        return insert(q + 1, value);
      }
      if (where <= r[0] || q === out.length - 1) return insert(where <= r[0] ? q : q + 1, value);
      // At the end of this piece: before the next text that fits, or after this one.
      const next = out.findIndex((x, n) => n > q && x.kind === "text" && fits(x));
      return insert(next < 0 ? q + 1 : next, value);
    }
    // After the last text that fits.
    insert(after < 0 ? out.length : after + 1, value);
  };
  const atoms = region.filter((s) => s.note === undefined && !s.block && (s.at?.old || s.at?.new));
  for (const [k, s] of region.entries()) {
    if (s.note === undefined) continue;
    const prev = region.slice(0, k).findLast((x) => atoms.includes(x));
    const next = region.slice(k + 1).find((x) => atoms.includes(x));
    const u = next ? unitOf.get(next) : undefined;
    const opening = s.note === "{==";
    if (next && u !== undefined && prev && unitOf.get(prev) === u) {
      // Between two atoms of the same change: in its text. From the old text to the new, at the ~>.
      const side: Side = next.at?.old ? "old" : "new";
      if (!prev.at?.[side]) {
        const mid = out.findIndex((p) => p.kind === "mark" && p.unit === u && p.role === "mid");
        insert(opening ? mid + 1 : mid, s.note);
        continue;
      }
      const gap = split(reads[side], prev.at[side][1], next.at?.[side]?.[0] ?? 0);
      inText(side, gap, s.note, (p) => p.kind === "text" && p.unit === u);
    } else if (next && u !== undefined) {
      // Before a change (or where it would be, if it's only line endings, which went outside it).
      const of = (p: Piece) => (p.kind === "mark" || p.kind === "text" ? p.unit : undefined);
      const at = out.findIndex((p) => of(p) === u);
      insert(at >= 0 ? at : out.findLastIndex((p) => (of(p) ?? -1) < u && of(p) !== undefined) + 1 || 1, s.note);
    } else {
      // After the changes, before the atom after them: in the text both readings have there.
      const side: Side = "old";
      const from = prev?.at?.[side]?.[1] ?? pos[side];
      const gap = split(reads[side], Math.max(from, pos[side]), to[side]);
      const after = out.findLastIndex((p) => p.kind === "mark");
      floor = Math.max(floor, after + 1);
      inText(side, gap, s.note, (p) => p.kind === "text" && p.side === "both");
    }
  }
  return out;
}

/**
 * What docmd shows of the segments, paragraph by paragraph: what a parse of their docmd must read as. Hidden
 * atoms, indexes and lists' numbers and IDs aren't shown; a thread's comments are its posts' docmd.
 */
export const shownAs = (segments: Segment[]): string[][] =>
  segments.map(({ atoms }) => shownParagraphs(atoms).map((p) => p.text));

function shownParagraphs(atoms: Atom[]): { text: string; end?: Atom }[] {
  const marks = (m?: Marks) =>
    m
      ? Object.keys(m)
          .sort()
          .map((k) => `${k}=${m[k]}`)
          .join(",")
      : "";
  // Not which list an item is in: Markdown doesn't tell a list that continues after other blocks.
  const props = (p?: Props) => (p ? `${p.heading}/${p.list ? `${p.list.level},${p.list.ordered}` : ""}` : "");
  return [...paragraphs(atoms.filter((a) => !a.hidden))].map(({ content, end }) => {
    const text = content.filter((a) => a.kind !== "annotation");
    // A paragraph whose text is all inserted or deleted is shown inserted or deleted with its end, whichever its
    // end is: Markdown has no empty paragraphs.
    const plain = end?.kind === "end" && !end.props?.heading && !end.props?.list && text.length > 0;
    const whole = plain && (text.every((t) => t.ins) || text.every((t) => t.del && !t.ins));
    const line: string[] = [];
    let notes = "";
    for (const a of [...content, ...(end ? [end] : [])]) {
      if (a.kind === "annotation") {
        notes += note(a);
        continue;
      }
      const suggestions = `${whole && a === end ? "|" : `${a.ins ?? ""}|${a.del ?? ""}`}|${a.styleChanges.join(" ")}`;
      const shown =
        a.kind === "end"
          ? `end ${props(a.props)} ${suggestions} ${props(a.reprops)}`
          : `${a.kind} ${a.key} ${marks(a.marks)} ${suggestions} ${marks(a.restyled)}`;
      line.push(`${notes}${shown}`);
      notes = "";
    }
    return { text: [...line, ...(notes ? [notes] : [])].join("\n"), end };
  });
}

/**
 * docmd to compare by: threads as their placeholders (what they say is checked separately; see edit.ts). Two
 * versions of a tab read the same if this is the same.
 */
export function comparable(segments: Segment[]) {
  return toDocmd(
    segments.map(({ id, atoms }) => ({
      id,
      atoms: atoms.map((a) => (isThread(a) ? { ...a, nodes: [raw(a.key)] } : a)),
    })),
  );
}

export type { Props };
