// Parsing docmd: CriticMarkup is read over the source text, as its spec defines it (see critic.ts), and each
// reading of the text, with every change rejected or accepted, is read as Markdown; the two are put together
// again by where their atoms are in the source.
import { diffArrays } from "diff";
import type { List, ListItem, Paragraph, PhrasingContent, RootContent, TableCell, TableRow } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { type Change, changeAt, type Projection, project, type Scan, scan, Unsupported } from "./critic.js";
import { type Atom, fresh, reblocks, type Segment } from "./ir.js";
import { BLOCKS, blockToken, isCode, MARKS, type Marks, type Props, raw, sameMarks } from "./rules.js";
import { docmdFromMarkdown, docmdSyntax } from "./syntax.js";

export { Unsupported };

/** A line break (Shift+Enter in Docs). Markdown's own hard break doesn't survive at a paragraph's end or next
 * to docmd markup, so docmd writes HTML's. (In a table cell, <br> separates paragraphs, and a line break is
 * one: see ir.ts.) Parsing accepts Markdown's hard breaks too. */
export const LINE_BREAK = "<br>";
export const isLineBreak = (value: string) => /^<br\s*\/?>$/i.test(value);

/** Raw docmd in a table cell: a `|` would end the cell, so it's escaped, and so is the backslash. */
export const escapeCell = (s: string) => s.replace(/[\\|]/g, "\\$&");
const unescapeCell = (s: string) => s.replace(/\\([\\|])/g, "$1");

/** The formatting marks that wrap phrasing content in Markdown (all but code). */
export const WRAPPERS = MARKS.filter((m) => m.mdast !== "inlineCode");

/** One reading of the docmd as Markdown: with every change rejected, or accepted. Each atom has its place in the
 * docmd source, and each paragraph end the place where its block starts. */
export type Reading = {
  segments: Segment[];
  /** Where each atom's Markdown starts and ends in the source: with its escape or character reference, say. */
  source: Map<Atom, number>;
  end: Map<Atom, number>;
  /** Where each paragraph end's block starts. */
  start: Map<Atom, number>;
  /** Where formatting closes (after its closing delimiter), and where each block's inline content starts. */
  closes: number[];
  contents: number[];
  /** Where each code span is: CriticMarkup isn't read in one. */
  codes: [number, number][];
  /** Where each footnote's definition is in the source. */
  spans: Map<string, [number, number]>;
};

/**
 * Parses docmd into atoms (without indexes) for the body and each footnote. `footnotes` are the doc's footnote
 * IDs in label order; footnotes the docmd doesn't define are left out.
 *
 * CriticMarkup is read as its spec defines it, over the source text: the source with every change rejected and
 * with every change accepted are each read as Markdown. What's in both is the doc's; what's only in the
 * rejected reading is a suggested deletion, what's only in the accepted one an insertion. The same text
 * formatted differently is a suggested formatting change, and a paragraph that reads as a different block (a
 * heading, a list item) a suggested paragraph style change.
 */
export function parse(markdown: string, footnotes: string[] = []): Segment[] {
  const found = scan(markdown);
  const read = (side: "reject" | "accept") => reading(project(markdown, found, side), footnotes, side);
  return merge(read("reject"), read("accept"), found, markdown);
}

/** Plain Markdown (no CriticMarkup) read as docmd, with where each atom is in it: to check what's rendered. */
export function readMarkdown(text: string, footnotes: string[] = []): Reading {
  return reading({ text, source: [...Array(text.length + 1).keys()] }, footnotes, "reject");
}

type ParseContext = {
  footnoteId(label: string): string;
  lists: number;
  side: string;
  /** The projection being read, and where each of its characters is in the source. */
  text: string;
  at: number[];
  /** Whether the content is in a table cell, where raw docmd is escaped. */
  cell: boolean;
  reading: Reading;
};

function reading({ text, source: at }: Projection, footnotes: string[], side: string): Reading {
  const tree = fromMarkdown(text, {
    extensions: [gfmTable(), gfmStrikethrough({ singleTilde: false }), gfmFootnote(), docmdSyntax],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmFootnoteFromMarkdown(),
      docmdFromMarkdown,
    ],
  });
  const footnoteId = (label: string) => {
    const id = footnotes[Number(label) - 1];
    if (!/^\d+$/.test(label) || !id) throw new Unsupported(`[^${label}]: adding footnotes isn't supported yet.`);
    return id;
  };
  const r: Reading = {
    segments: [{ id: "", atoms: [] }],
    source: new Map(),
    end: new Map(),
    start: new Map(),
    closes: [],
    contents: [],
    codes: [],
    spans: new Map(),
  };
  const ctx: ParseContext = { footnoteId, lists: 0, side, text, at, cell: false, reading: r };
  for (const node of tree.children) {
    if (node.type === "footnoteDefinition") {
      const atoms: Atom[] = [];
      for (const child of node.children) block(ctx, child, atoms);
      const id = footnoteId(node.label ?? node.identifier);
      r.segments.push({ id, atoms });
      r.spans.set(id, [sourceOf(ctx, node.position?.start.offset), sourceOf(ctx, node.position?.end.offset)]);
    } else block(ctx, node, r.segments[0]?.atoms ?? []);
  }
  return r;
}

/** The source index of a position in the projection. */
const sourceOf = (ctx: ParseContext, offset = ctx.text.length) => ctx.at[offset] ?? ctx.at.at(-1) ?? 0;

const atom = (kind: Atom["kind"], key: string, marks: Marks = {}): Atom => ({ kind, key, marks, styleChanges: [] });

/** An atom at a place in the projection, its Markdown up to `to` (by default, none). */
function placed(ctx: ParseContext, a: Atom, offset?: number, to?: number): Atom {
  return located(ctx, a, sourceOf(ctx, offset), sourceOf(ctx, to ?? offset));
}

/** An atom at a place in the source, its Markdown up to `end`. */
function located(ctx: ParseContext, a: Atom, source: number, end = source): Atom {
  ctx.reading.source.set(a, source);
  ctx.reading.end.set(a, end);
  return a;
}

/** Where a block's inline content starts. */
function content(ctx: ParseContext, nodes: PhrasingContent[]) {
  const at = nodes[0]?.position?.start.offset;
  if (at !== undefined) ctx.reading.contents.push(sourceOf(ctx, at));
}

/** A paragraph end: at the line ending after the block's content (or at `offset`), for the block from `start`. */
function end(
  ctx: ParseContext,
  props: Props,
  node: { position?: { start: { offset?: number }; end: { offset?: number } } },
  offset?: number,
): Atom {
  let p = offset ?? node.position?.end.offset ?? ctx.text.length;
  if (offset === undefined) while (p < ctx.text.length && ctx.text[p] !== "\n") p++;
  // Its line ending, unless it's in a table cell.
  const a = placed(ctx, { ...atom("end", "\n"), props }, p, offset === undefined && ctx.text[p] === "\n" ? p + 1 : p);
  ctx.reading.start.set(a, sourceOf(ctx, node.position?.start.offset));
  return a;
}

const UNSUPPORTED: Record<string, string> = {
  code: "code blocks",
  blockquote: "block quotes",
  thematicBreak: "horizontal rules",
  html: "HTML",
  image: "images",
  imageReference: "images",
  linkReference: "reference links",
  definition: "link definitions",
};
const unsupported = (ctx: ParseContext, node: { type: string; position?: { start: { offset?: number } } }) =>
  new Unsupported(
    `docs can't hold ${UNSUPPORTED[node.type] ?? node.type} through docmd yet.`,
    sourceOf(ctx, node.position?.start.offset),
  );

/** Line breaks alone on a line read as an HTML block; they're a paragraph of line breaks. */
function breaks<T extends RootContent>(node: T): T | Paragraph {
  const parts = node.type === "html" ? node.value.match(/<br\s*\/?>/gi) : null;
  return node.type === "html" && parts && parts.join("") === node.value.trim()
    ? { type: "paragraph", children: parts.map(raw), position: node.position }
    : node;
}

function block(ctx: ParseContext, input: RootContent, out: Atom[]) {
  const node = breaks(input);
  const start = node.position?.start.offset;
  if (node.type === "paragraph") {
    const only = node.children.length === 1 ? node.children[0] : undefined;
    const kind = BLOCKS.find((k) => only?.type === "html" && only.value === blockToken(k));
    if (kind) out.push(placed(ctx, { ...atom("boundary", blockToken(kind)), nodes: [raw(blockToken(kind))] }, start));
    else {
      content(ctx, node.children);
      out.push(...inline(ctx, node.children), end(ctx, { heading: 0 }, node));
    }
  } else if (node.type === "heading") {
    content(ctx, node.children);
    out.push(...inline(ctx, node.children), end(ctx, { heading: node.depth }, node));
  } else if (node.type === "list") list(ctx, node, 0, `${ctx.side}${ctx.lists++}`, out);
  else if (node.type === "table") {
    out.push(placed(ctx, atom("boundary", "table"), start));
    for (const row of node.children as TableRow[]) {
      out.push(placed(ctx, atom("boundary", "row"), row.position?.start.offset));
      for (const cell of row.children) {
        out.push(placed(ctx, atom("boundary", "cell"), cell.position?.start.offset));
        // Paragraphs in a cell are separated by <br>; an empty cell has one empty paragraph.
        let part: PhrasingContent[] = [];
        const last = raw("<br>");
        for (const child of [...cell.children, last]) {
          if (child.type === "html" && isLineBreak(child.value)) {
            const at = child === last ? cellEnd(ctx, cell) : child.position?.start.offset;
            content(ctx, part);
            out.push(...inline({ ...ctx, cell: true }, part), end(ctx, { heading: 0 }, cell, at));
            part = [];
          } else part.push(child);
        }
      }
    }
    // Right after the table's last character, which both readings have.
    out.push(located(ctx, atom("boundary", "/table"), (ctx.at[(node.position?.end.offset ?? 0) - 1] ?? 0) + 1));
  } else throw unsupported(ctx, node);
}

/** Where a cell's text ends: before the space and pipe after it, which the cell's text in either reading has. */
function cellEnd(ctx: ParseContext, cell: TableCell) {
  const start = cell.position?.start.offset ?? 0;
  let at = cell.position?.end.offset ?? start;
  if (ctx.text[at - 1] === "|" && at - 1 > start) at--;
  while (at - 1 > start && (ctx.text[at - 1] === " " || ctx.text[at - 1] === "\t")) at--;
  return at;
}

function list(ctx: ParseContext, node: List, level: number, id: string, out: Atom[]) {
  let number = node.start ?? 1;
  for (const item of node.children as ListItem[]) {
    // An item without text, holding just a nested list on its line ("- - item"), stands for a level the list
    // skips; one with the nested list on the lines after it is an item without text.
    const head = item.children[0];
    const under = head?.type === "list";
    const skipped = under && head.position?.start.line === item.position?.start.line;
    const first = under || !head ? undefined : breaks(head);
    const rest = under ? item.children : item.children.slice(1);
    if (first && first.type !== "paragraph") throw unsupported(ctx, first);
    const props = { heading: 0, list: { id, level, ordered: !!node.ordered, number: number++ } };
    if (!skipped) {
      const e = end(ctx, props, {
        position: {
          start: item.position?.start ?? {},
          end: (first ? first.position?.end : under ? item.position?.start : item.position?.end) ?? {},
        },
      });
      const children = first?.type === "paragraph" ? first.children : [];
      content(ctx, children);
      out.push(...inline(ctx, children), e);
    }
    for (const child of rest) {
      if (child.type !== "list")
        throw new Unsupported(
          "list items can hold only one paragraph and nested lists.",
          sourceOf(ctx, child.position?.start.offset),
        );
      list(ctx, child, level + 1, id, out);
    }
  }
}

/** Where the Markdown of each character of a text node's value starts and ends in the projection: escapes,
 * character references and line breaks in the source make it differ from the value. In code, a backslash is a
 * backslash. */
function offsets(text: string, from: number, to: number, value: string, code: boolean) {
  const out: { start: number; end: number }[] = [];
  let i = from;
  for (const ch of value) {
    for (;;) {
      if (i >= to) {
        out.push({ start: Math.max(from, to - 1), end: to });
        break;
      }
      if (!code && text[i] === "\\" && text[i + 1] === ch && /[!-/:-@[-`{-~]/.test(ch)) {
        out.push({ start: i, end: i + 2 });
        i += 2;
        break;
      }
      const semi = text.indexOf(";", i);
      if (!code && text[i] === "&" && ch !== "&" && semi > i && semi < to) {
        out.push({ start: i, end: semi + 1 });
        i = semi + 1;
        break;
      }
      if (text.startsWith(ch, i) || (ch === " " && (text[i] === "\n" || text[i] === "\r"))) {
        out.push({ start: i, end: i + ch.length });
        i += ch.length;
        break;
      }
      i++;
    }
  }
  return out;
}

function inline(ctx: ParseContext, nodes: PhrasingContent[]): Atom[] {
  const out: Atom[] = [];
  const startOf = (node: PhrasingContent) => node.position?.start.offset;
  const endOf = (node: PhrasingContent) => node.position?.end.offset;
  const chars = (node: PhrasingContent & { value: string }, value: string, marks: Marks, code: boolean) => {
    const from = node.position?.start.offset ?? 0;
    const to = node.position?.end.offset ?? from;
    const at = offsets(ctx.text, from, to, value, code);
    for (const [k, ch] of [...value].entries()) {
      out.push(placed(ctx, atom("text", ch, marks), at[k]?.start, at[k]?.end));
    }
  };

  const markup = (node: PhrasingContent & { value: string }, marks: Marks) => {
    const value = ctx.cell ? unescapeCell(node.value) : node.value;
    if (isLineBreak(value)) out.push(placed(ctx, atom("text", "\u000b", marks), startOf(node), endOf(node)));
    else if (value.startsWith("{{")) {
      if (!TOKENS.test(value))
        throw new Unsupported(
          `${value} isn't a docmd token: those are {{date:…}}, {{link:…}}, {{dropdown:…}} and {{opaque:…}}.`,
          sourceOf(ctx, startOf(node)),
        );
      out.push(placed(ctx, { ...atom("element", value, marks), nodes: [raw(value)] }, startOf(node), endOf(node)));
    } else throw new Unsupported(`${value} is out of place.`, sourceOf(ctx, startOf(node)));
  };

  /** Whether the "@" right before `node` in the source is a literal, escaped one. */
  const escaped = (node: PhrasingContent) => {
    let k = (node.position?.start.offset ?? 0) - 1;
    let backslashes = 0;
    while (ctx.text[--k] === "\\") backslashes++;
    return backslashes % 2 === 1;
  };

  const closes = (node: PhrasingContent) => {
    const at = endOf(node);
    if (at !== undefined) ctx.reading.closes.push(sourceOf(ctx, at));
  };

  const walk = (node: PhrasingContent, marks: Marks) => {
    switch (node.type) {
      case "text":
        // A line ending in a paragraph is a space, as Markdown reads it.
        return chars(node, node.value.replace(/\r?\n/g, " "), marks, false);
      case "break":
        out.push(placed(ctx, atom("text", "\u000b", marks), startOf(node), endOf(node)));
        return;
      case "inlineCode": {
        closes(node);
        ctx.reading.codes.push([sourceOf(ctx, startOf(node)), sourceOf(ctx, endOf(node))]);
        const code = MARKS.find((m) => m.mdast === "inlineCode")?.name ?? "code";
        return chars(node, node.value, { ...marks, [code]: true }, true);
      }
      case "html":
        return markup(node, marks);
      case "footnoteReference":
        out.push(
          placed(
            ctx,
            {
              ...atom("element", `footnote:${ctx.footnoteId(node.label ?? node.identifier)}`, marks),
              nodes: [{ type: "footnoteReference", identifier: node.identifier, label: node.label }],
            },
            startOf(node),
            endOf(node),
          ),
        );
        return;
      default: {
        // A person chip: "@" right before a mailto link (a literal "@" there is escaped).
        const at = out.at(-1);
        const person = node.type === "link" && node.url.startsWith("mailto:");
        if (person && at?.kind === "text" && at.key === "@" && !escaped(node)) {
          out.pop();
          const chip = {
            ...atom("element", `person:${node.url.slice(7)}`, marks),
            nodes: [raw("@"), { ...node, position: undefined }],
          };
          out.push(located(ctx, chip, ctx.reading.source.get(at) ?? 0, sourceOf(ctx, endOf(node))));
          return;
        }
        const rule = WRAPPERS.find((m) => m.mdast === node.type);
        if (!rule || !("children" in node)) throw unsupported(ctx, node);
        closes(node);
        const value = node.type === "link" ? node.url : true;
        for (const child of node.children) walk(child, { ...marks, [rule.name]: value });
      }
    }
  };

  for (const node of nodes) walk(node, {});
  return out;
}

/** The kinds of {{…}} token. */
const TOKENS = /^\{\{(date|link|dropdown|opaque):/;

const READS_DIFFERENTLY =
  "reads as different Markdown once its changes are accepted or rejected than CriticMarkup says. Put block " +
  "markup (#, -, 1.) and the blank lines between blocks either outside CriticMarkup or in it whole, as in " +
  "{~~## Title~>### Title~~}.";

/** The two readings as one: atoms in both are the doc's, the others are suggested insertions and deletions. */
/** A comment that only names its author: `{>>@Name<<}`. */
const AUTHOR = /^\{>>@(?:\\.|[^\\:;<])+<<\}$/;

function merge(old: Reading, next: Reading, { changes, notes }: Scan, src: string): Segment[] {
  let count = 0;
  const ids = new Map<Change, string>();
  const idOf = (c: Change) => {
    let id = ids.get(c);
    if (!id) {
      id = fresh(count++);
      ids.set(c, id);
    }
    return id;
  };
  /** The accepted reading's lists, by the rejected reading's ID of the same list. */
  const lists = new Map<string, string>();
  const accepted: Props[] = [];
  const source = new Map([...old.source, ...next.source]);
  const at = (a: Atom) => source.get(a) ?? 0;

  const mergeAtoms = (rejected: Atom[], acceptedAtoms: Atom[]): Atom[] => {
    const out: Atom[] = [];
    /** The change of the content before, in the paragraph so far, for an end that's only in one reading. */
    let last: Change | undefined;
    /** Whether `x` is one of a run of emphasis markers right outside a change. */
    const empty = (x: Atom) => {
      const i = at(x);
      const markers = (from: number, to: number) => /^[*_~]*$/.test(src.slice(from, to));
      return changes.some((c) => (i < c.start && markers(i, c.start)) || (i >= c.end && markers(c.end, i + 1)));
    };
    const only = (x: Atom, part: "old" | "new"): Atom | undefined => {
      const reading = part === "old" ? old : next;
      let c = changeAt(changes, at(x), part);
      if (!c && x.kind === "end") c = changeAt(changes, reading.start.get(x) ?? -1, part) ?? last;
      if (!c) {
        // Markdown drops whitespace at a paragraph's edges, which a change can leave there.
        if (x.kind === "text" && /^\s$/u.test(x.key)) return x;
        // Emphasis around a change that leaves it empty reads as its markers, as in `**{++bold++}**` with the
        // insertion rejected; as in MultiMarkdown, it's the change's formatting.
        if (x.kind === "text" && /^[*_~]$/.test(x.key) && empty(x)) return undefined;
        throw new Unsupported(`The text around source position ${at(x)} ${READS_DIFFERENTLY}`, at(x));
      }
      const top = c.parent ?? c;
      const y = { ...x };
      source.set(y, at(x));
      if (part === "old") y.del = idOf(top);
      else {
        y.ins = idOf(top);
        const inner = changeAt(changes, at(x), "old");
        if (inner?.parent) y.del = idOf(inner);
        if (y.props) accepted.push(y.props);
      }
      last = y.kind === "end" || y.kind === "boundary" ? undefined : top;
      return y;
    };
    const both = (r: Atom, a: Atom): Atom => {
      if (r.kind !== "end") {
        if (!sameMarks(r.marks, a.marks))
          throw new Unsupported(
            `Formatting at source position ${at(r)} starts or ends inside CriticMarkup: wrap the whole change in it, or put it inside.`,
            at(r),
          );
        last = r.kind === "boundary" ? undefined : last;
        return r;
      }
      last = undefined;
      if (r.props?.list && a.props?.list) lists.set(a.props.list.id, r.props.list.id);
      if (!reblocks(r.props, a.props)) return r;
      const c = changeAt(changes, old.start.get(r) ?? -1, "old") ?? changeAt(changes, next.start.get(a) ?? -1, "new");
      if (!c) throw new Unsupported(`The paragraph at source position ${old.start.get(r)} ${READS_DIFFERENTLY}`, at(r));
      const reprops = { ...(a.props ?? { heading: 0 }) };
      accepted.push(reprops);
      const y = { ...r, styleChanges: [idOf(c)], reprops };
      source.set(y, at(r));
      return y;
    };

    let i = 0;
    let j = 0;
    while (i < rejected.length || j < acceptedAtoms.length) {
      const r = rejected[i];
      const a = acceptedAtoms[j];
      const rs = r ? at(r) : Number.POSITIVE_INFINITY;
      const as = a ? at(a) : Number.POSITIVE_INFINITY;
      let y: Atom | undefined;
      if (r && a && rs === as && r.kind === a.kind && r.key === a.key) {
        y = both(r, a);
        i++;
        j++;
      } else if (r && rs <= as) {
        y = only(r, "old");
        i++;
      } else if (a) {
        y = only(a, "new");
        j++;
      }
      if (y) out.push(y);
    }
    return restyles(out);
  };

  /**
   * What a substitution's old and new text have in common is the doc's: all of it, in a substitution of text with
   * the same text formatted differently (a formatting change, {~~a~>**a**~~}); what's in both, in one of code (a
   * whole code span, as CriticMarkup isn't read in code). Text formatted differently has the style change.
   */
  const restyles = (atoms: Atom[]): Atom[] => {
    let out = atoms;
    for (const c of changes) {
      const id = ids.get(c);
      // (A change of nothing but Markdown has no atoms.)
      if (c.kind !== "{~~" || c.parent || id === undefined) continue;
      const before = out.filter((a) => a.del === id && !a.ins);
      const after = out.filter((a) => a.ins === id);
      const both = [...before, ...after];
      // (A deletion in the new text isn't in common with the old; in code, nor is text formatted differently.)
      const key = (marks: boolean) => (a: Atom) =>
        `${a.kind}\u0001${a.key}\u0001${a.del === id ? "" : (a.del ?? "")}${marks ? JSON.stringify(a.marks) : ""}`;
      let diff = diffArrays(before.map(key(false)), after.map(key(false)));
      const same = before.length > 0 && diff.length === 1 && !diff[0]?.added && !diff[0]?.removed;
      if (same ? both.some((a) => a.kind === "end") : !both.some((a) => isCode(a.marks))) continue;
      if (!same) diff = diffArrays(before.map(key(true)), after.map(key(true)));
      const merged: Atom[] = [];
      let i = 0;
      let j = 0;
      for (const d of diff) {
        const n = d.count ?? d.value.length;
        if (d.added) merged.push(...after.slice(j, j + n));
        else if (d.removed) merged.push(...before.slice(i, i + n));
        else
          for (let k = 0; k < n; k++) {
            const [b, a] = [before[i + k] as Atom, after[j + k] as Atom];
            const styled = !sameMarks(b.marks, a.marks);
            const y = { ...b, del: undefined, ...(styled ? { styleChanges: id.split(" "), restyled: a.marks } : {}) };
            source.set(y, at(b));
            merged.push(y);
          }
        if (!d.added) i += n;
        if (!d.removed) j += n;
      }
      const from = out.indexOf(both[0] as Atom);
      const to = out.indexOf(both.at(-1) as Atom);
      out = [...out.slice(0, from), ...merged, ...out.slice(to + 1)];
    }
    return out;
  };

  const segments: Segment[] = old.segments.map((s) => ({
    id: s.id,
    atoms: mergeAtoms(s.atoms, next.segments.find((n) => n.id === s.id)?.atoms ?? []),
  }));
  for (const s of next.segments)
    if (!segments.some((m) => m.id === s.id)) segments.push({ id: s.id, atoms: mergeAtoms([], s.atoms) });
  // A list in the accepted reading is the list it continues in the rejected one.
  for (const props of accepted)
    if (props.list) props.list = { ...props.list, id: lists.get(props.list.id) ?? props.list.id };

  // Comment markup goes where it is in the source: in the footnote it's in, before the atom after it. A
  // change's authors, {>>@Name<<} after it, only say who made it: they're not part of the doc, and stay or go
  // with it (but for one right after a highlight, which would be a new comment).
  const authorship = new Set(notes.filter((n) => AUTHOR.test(n.value) && !src.startsWith("==}", n.at - 3)));
  for (const n of notes) {
    if (authorship.has(n)) continue;
    const footnote = [...old.spans, ...next.spans].find(([, [from, to]]) => n.at >= from && n.at < to)?.[0];
    const segment = segments.find((s) => s.id === (footnote ?? "")) ?? segments[0];
    if (!segment) continue;
    // (A "|" in a comment can be escaped, as it is in a table cell.)
    const value = n.value.replace(/\\\|/g, "|");
    const note: Atom = {
      ...atom("annotation", value),
      ...(value.startsWith("{>>") ? { nodes: [raw(value)] } : {}),
      ...(n.thread ? { thread: n.thread } : {}),
    };
    source.set(note, n.at);
    const k = segment.atoms.findIndex((a) => at(a) > n.at);
    segment.atoms.splice(k < 0 ? segment.atoms.length : k, 0, note);
  }
  return segments;
}
