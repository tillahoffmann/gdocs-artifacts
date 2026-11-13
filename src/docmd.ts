// docmd: one tab of a Google Doc as Markdown, with open comment threads and pending suggestions inline as
// CriticMarkup, chips as {{…}} tokens, and {{opaque:…}} tokens for anything without a Markdown form.
// `render` goes from the doc to docmd, `parse` from docmd back to the same atoms, so that an edited docmd
// can be compared with the doc.
import type { docs_v1 } from "googleapis";
import type {
  Heading,
  List,
  ListItem,
  Paragraph,
  Parent,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import { type Options, toMarkdown } from "mdast-util-to-markdown";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { ToolError } from "./errors.js";
import { type Atom, anchored, fresh, fromDoc, isFresh, restyleKey, type Segment } from "./ir.js";
import { BLOCKS, blockToken, MARKS, type Marks, type Props, raw } from "./rules.js";
import { docmdFromMarkdown, docmdSyntax } from "./syntax.js";

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

/** A line break (Shift+Enter in Docs). Markdown's own hard break doesn't survive at a paragraph's end, next to
 * docmd markup or in a table cell, so docmd writes it as a token; parsing accepts both. */
const LINE_BREAK = "{{br}}";
/** Separates markup that would otherwise run together; it stands for nothing. */
const SEPARATOR = "{{}}";

/** Raw docmd in a table cell: a `|` would end the cell, so it's escaped, and so is the backslash. */
const escapeCell = (s: string) => s.replace(/[\\|]/g, "\\$&");
const unescapeCell = (s: string) => s.replace(/\\([\\|])/g, "$1");

const MARKDOWN_OPTIONS: Options = {
  bullet: "-",
  listItemIndent: "one",
  incrementListMarker: true,
  extensions: [gfmStrikethroughToMarkdown(), gfmTableToMarkdown({ tablePipeAlign: false }), gfmFootnoteToMarkdown()],
  // Doc text never reads as docmd's own syntax: every literal `{` is escaped, and so is `}` after + - ~ =
  // (which would close CriticMarkup), `>` after ~, and `@` before a link.
  unsafe: [
    { character: "{", inConstruct: "phrasing" },
    { character: "}", before: "[+\\-~=]", inConstruct: "phrasing" },
    { character: ">", before: "~", inConstruct: "phrasing" },
    // "@" right before a mailto link is a person chip.
    { character: "@", after: "[\\[<]", inConstruct: "phrasing" },
    // "<" before what could be an email address would start an autolink.
    { character: "<", after: "[\\w.!#$%&'*+/=?^`{|}~-]", inConstruct: "phrasing" },
  ],
};

/** docmd for the segments: the body (or one section of it), then its footnotes. */
export function toDocmd(segments: Segment[], opts: { section?: string } = {}) {
  const [body, ...footnotes] = segments;
  const ctx: RenderContext = { referenced: new Set() };
  const atoms = opts.section ? section(body?.atoms ?? [], opts.section) : (body?.atoms ?? []);
  const root = blocks(ctx, atoms);
  footnotes.forEach(({ id, atoms }, i) => {
    if (!ctx.referenced.has(id)) return;
    root.push({ type: "footnoteDefinition", identifier: String(i + 1), children: blocks(ctx, atoms) as Paragraph[] });
  });
  return toMarkdown({ type: "root", children: root }, MARKDOWN_OPTIONS);
}

type RenderContext = {
  /** Footnotes referenced in what's rendered. */
  referenced: Set<string>;
};

const isContent = (a: Atom) => a.kind === "text" || a.kind === "element" || a.kind === "annotation";

/** Splits atoms into paragraphs: each paragraph's content and its end, or a lone boundary. Threads without an
 * anchor come last, without an end. */
function* paragraphs(atoms: Atom[]): Generator<{ content: Atom[]; end?: Atom }> {
  let content: Atom[] = [];
  for (const a of atoms) {
    if (isContent(a)) content.push(a);
    else {
      yield { content, end: a };
      content = [];
    }
  }
  if (content.length) yield { content };
}

function blocks(ctx: RenderContext, atoms: Atom[]): RootContent[] {
  const root: RootContent[] = [];
  let lists: { list: List; level: number; id: string }[] = [];
  let table: Table | undefined;
  let cell: TableCell | undefined;

  for (const { content, end } of paragraphs(atoms)) {
    if (!end) {
      for (const a of content) root.push({ type: "paragraph", children: a.nodes ?? [] });
      continue;
    }
    const list = end.props?.list;
    if (!list || table) lists = [];
    if (end.kind === "boundary") {
      if (end.key === "table") {
        table = { type: "table", children: [] };
        root.push(table);
      } else if (end.key === "row") table?.children.push({ type: "tableRow", children: [] });
      else if (end.key === "cell") {
        cell = { type: "tableCell", children: [] };
        table?.children.at(-1)?.children.push(cell);
      } else if (end.key === "/table") {
        table = undefined;
        cell = undefined;
      } else root.push({ type: "paragraph", children: end.nodes ?? [] });
      continue;
    }
    if (end.hidden) continue;
    const node = paragraph(ctx, content, end);
    if (cell) {
      // Cells hold inline content only; their paragraphs are joined with <br>.
      const children = node.children.map((c) => (c.type === "html" ? raw(escapeCell(c.value)) : c));
      if (children.length) cell.children.push(...(cell.children.length ? [raw("<br>")] : []), ...children);
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
        (parent ? parent.children : root).push(l);
        top = { list: l, level, id: list.id };
        lists.push(top);
      }
      top.list.children.push({ type: "listItem", spread: false, children: [node] });
    } else {
      const depth = end.props?.heading;
      root.push(depth ? ({ type: "heading", depth, children: node.children } as Heading) : node);
    }
  }
  return root;
}

/** The atoms of the section under the heading `title`. */
function section(atoms: Atom[], title: string): Atom[] {
  const heads: { title: string; level: number; start: number; end: number }[] = [];
  let start = 0;
  atoms.forEach((a, i) => {
    if (isContent(a)) return;
    const level = a.props?.heading ?? 0;
    const text = atoms
      .slice(start, i)
      .map((b) => (b.kind === "text" ? b.key : ""))
      .join("")
      .trim();
    if (level) heads.push({ title: text, level, start, end: i + 1 });
    start = i + 1;
  });
  const head = heads.find((h) => h.title === title);
  if (!head) {
    const list = heads.length ? `Headings: ${heads.map((h) => `"${h.title}"`).join(", ")}.` : "The tab has none.";
    throw new ToolError("section_not_found", `No heading "${title}". ${list}`);
  }
  const next = heads.find((h) => h.start > head.start && h.level <= head.level);
  return atoms.slice(head.start, next?.start);
}

/** An atom as rendered: `replaces` if it's in the new text of a replace; `literal` on the first atom of a
 * suggested insertion that follows a deletion of the same text, which isn't shown as a replace (that would
 * read as a formatting change). */
type Shown = Atom & { replaces?: boolean; literal?: boolean };

function paragraph(ctx: RenderContext, content: Atom[], end: Atom): Paragraph {
  // Text and elements, and the comment annotations in the gap before each of them (and after the last).
  const shown: Atom[] = [];
  const annotations: string[][] = [[]];
  for (const a of content) {
    if (a.hidden) continue;
    if (a.kind !== "annotation") {
      shown.push(a);
      annotations.push([]);
    } else annotations.at(-1)?.push(a.nodes?.[0]?.type === "html" ? a.nodes[0].value : a.key);
  }
  // Text with style changes shows as a replace of itself with itself formatted as suggested, {~~a~>**a**~~};
  // comment markup in it goes in the first part.
  const atoms: Shown[] = [];
  const gaps: string[][] = [annotations[0] ?? []];
  const styled = new Set<Shown>();
  for (let k = 0; k < shown.length; ) {
    const ids = restyleKey(shown[k] as Atom);
    let m = k + 1;
    if (ids) while (m < shown.length && restyleKey(shown[m] as Atom) === ids) m++;
    const run = shown.slice(k, m);
    if (!ids) atoms.push({ ...(shown[k] as Atom) });
    else {
      const before = run.map((a) => ({ ...a, del: ids, restyled: undefined }));
      const after = run.map((a) => ({ ...a, marks: a.restyled ?? a.marks, ins: ids, restyled: undefined }));
      for (const a of [...before, ...after]) styled.add(a);
      atoms.push(...before, ...after);
      gaps.push(...annotations.slice(k + 1, m), [], ...run.slice(1).map(() => []));
    }
    gaps.push(annotations[m] ?? []);
    k = m;
  }
  /** The text of the suggestion `id` in the insertion or deletion that runs from atom `from`, in direction `step`. */
  const text = (id: string, field: "ins" | "del", from: number, step: 1 | -1) => {
    const keys: string[] = [];
    for (let q = from; atoms[q]?.[field] === id && !(field === "del" && atoms[q]?.ins); q += step)
      keys.push(atoms[q]?.key ?? "");
    return (step > 0 ? keys : keys.reverse()).join("");
  };
  let prev: Shown | undefined;
  for (const [k, a] of atoms.entries()) {
    if (replaces(prev, a) && !styled.has(a))
      a.literal = text(a.ins as string, "ins", k, 1) === text(a.ins as string, "del", k - 1, -1);
    // An insertion that directly follows a deletion with the same suggestion ID: one replace.
    a.replaces = !!a.ins && (prev?.ins === a.ins ? !!prev.replaces : replaces(prev, a));
    if (a.kind === "element" && a.key.startsWith("footnote:")) ctx.referenced.add(a.key.slice(9));
    prev = a;
  }

  const children: PhrasingContent[] = [];
  const stack: { key: string; children: PhrasingContent[] }[] = [];
  const container = () => stack.at(-1)?.children ?? children;

  /** How many wrappers were open where each open suggestion started, innermost last. */
  const depths: number[] = [];
  for (let i = 0; i <= atoms.length; i++) {
    const a = atoms[i - 1];
    const b = atoms[i];
    const closers = suggestionClosers(a, b);
    const openers = suggestionOpeners(atoms, i);
    const rest = [...(gaps[i] ?? []), ...openers];
    const keys = b ? wrapperKeys(b.marks) : [];
    let keep = 0;
    while (keep < stack.length && stack[keep]?.key === keys[keep]) keep++;
    // A suggestion that ends where the formatting around it ends closes inside it, **a {--b--}**, unless a
    // letter, a digit or more formatting follows, which would keep the ** from closing.
    const next = rest[0] ?? (b?.kind === "text" ? b.key : "");
    let early = 0;
    if (keys.length === keep && !/^[\p{L}\p{N}]/u.test(next))
      for (; closers[early] && closers[early] !== "~>" && (depths.at(-1) ?? 0) > keep; early++) {
        stack.length = Math.min(stack.length, depths.pop() as number);
        container().push(raw(closers[early] as string));
      }
    for (const c of closers.slice(early)) if (c !== "~>") depths.pop();
    const events = [...closers.slice(early), ...rest];
    const strike = (k: string) => k.startsWith("strike:");
    // GFM strikethrough doesn't open or close right next to another tilde, as in `{~~` and `~>`.
    if (stack.slice(keep).some((s) => strike(s.key)) && events[0]?.startsWith("~")) events.unshift(SEPARATOR);
    if (keys.slice(keep).some(strike) && events.at(-1)?.endsWith("~")) events.push(SEPARATOR);
    stack.length = keep;
    for (const e of events) container().push(raw(e));
    for (const _ of openers) depths.push(keep);
    if (!b) break;
    for (const key of keys.slice(keep)) {
      const node = wrapper(key);
      container().push(node);
      stack.push({ key, children: node.children });
    }
    push(container(), b);
  }
  for (const id of end.styleChanges) children.push(raw(`{>>s:${isFresh(id) ? "new" : id} style<<}`));
  return { type: "paragraph", children };
}

const WRAPPERS = MARKS.filter((m) => m.mdast !== "inlineCode");

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

function push(into: PhrasingContent[], a: Atom) {
  const last = into.at(-1);
  const code = MARKS.some((m) => m.mdast === "inlineCode" && a.marks[m.name]);
  if (a.nodes) into.push(...a.nodes);
  else if (a.key === "\u000b") into.push(raw(LINE_BREAK));
  else if (code && last?.type === "inlineCode") last.value += a.key;
  else if (code) into.push({ type: "inlineCode", value: a.key });
  else if (last?.type === "text") last.value += a.key;
  else into.push({ type: "text", value: a.key });
}

/** Whether `b` starts the new text of a replace whose old text ends with `a`. */
const replaces = (a?: Atom, b?: Shown) => !!a?.del && !a.ins && b?.ins === a.del && !b.literal;

/** The ID after a suggestion; one that docmd adds has none yet. */
const marker = (id: string) => (isFresh(id) ? "" : `{>>s:${id}<<}`);

function suggestionClosers(a?: Shown, b?: Shown) {
  const out: string[] = [];
  if (a?.del && a.del !== b?.del) out.push(replaces(a, b) ? "~>" : `--}${marker(a.del)}`);
  if (a?.ins && a.ins !== b?.ins) out.push(`${a.replaces ? "~~}" : "++}"}${marker(a.ins)}`);
  return out;
}

function suggestionOpeners(atoms: Shown[], i: number) {
  const a = atoms[i - 1];
  const b = atoms[i];
  const out: string[] = [];
  // An insertion opens first: a deletion inside it (of the inserted text) nests in it.
  if (b?.ins && b.ins !== a?.ins && !replaces(a, b)) out.push("{++");
  if (b?.del && b.del !== a?.del) {
    let j = i;
    while (atoms[j]?.del === b.del) j++;
    out.push(replaces(atoms[j - 1], atoms[j]) ? "{~~" : "{--");
  }
  return out;
}

// ---- Parsing ----

/** Markdown that docmd can't represent, or markup that edits can't create. */
export class Unsupported extends Error {}

/**
 * Parses docmd into atoms (without indexes) for the body and each footnote. `footnotes` are the doc's
 * footnote IDs in label order; footnotes the docmd doesn't define are left out. Comment markup must be
 * stripped first.
 */
export function parse(markdown: string, footnotes: string[] = []): Segment[] {
  const tree = fromMarkdown(markdown, {
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
  let ids = 0;
  const ctx: ParseContext = {
    footnoteId,
    lists: 0,
    source: markdown,
    cell: false,
    fresh: () => fresh(ids++),
    endChanges: [],
  };
  const segments: Segment[] = [{ id: "", atoms: [] }];
  for (const node of tree.children) {
    if (node.type === "footnoteDefinition") {
      const atoms: Atom[] = [];
      for (const child of node.children) block(ctx, child, atoms);
      segments.push({ id: footnoteId(node.label ?? node.identifier), atoms });
    } else block(ctx, node, segments[0]?.atoms ?? []);
  }
  return segments;
}

type ParseContext = {
  footnoteId(label: string): string;
  lists: number;
  source: string;
  /** Whether the content is in a table cell, where raw docmd is escaped. */
  cell: boolean;
  /** A placeholder ID for a new suggestion. */
  fresh(): string;
  /** Suggested paragraph style changes on the paragraph being parsed, shown at its end. */
  endChanges: string[];
};

const atom = (kind: Atom["kind"], key: string, marks: Marks = {}): Atom => ({ kind, key, marks, styleChanges: [] });
const end = (ctx: ParseContext, props: Props): Atom => ({
  ...atom("end", "\n"),
  props,
  styleChanges: ctx.endChanges.splice(0),
});

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
const unsupported = (type: string) =>
  new Unsupported(`docs can't hold ${UNSUPPORTED[type] ?? type} through docmd yet.`);

function block(ctx: ParseContext, node: RootContent, out: Atom[]) {
  if (node.type === "paragraph") {
    const only = node.children.length === 1 ? node.children[0] : undefined;
    const kind = BLOCKS.find((k) => only?.type === "html" && only.value === blockToken(k));
    const atoms = kind ? [] : inline(ctx, node.children);
    if (kind) out.push({ ...atom("boundary", blockToken(kind)), nodes: [raw(blockToken(kind))] });
    // A paragraph of just threads: threads without an anchor.
    else if (atoms.length && atoms.every((a) => a.kind === "annotation")) out.push(...atoms);
    else out.push(...atoms, end(ctx, { heading: 0 }));
  } else if (node.type === "heading") out.push(...inline(ctx, node.children), end(ctx, { heading: node.depth }));
  else if (node.type === "list") list(ctx, node, 0, `parsed${ctx.lists++}`, out);
  else if (node.type === "table") {
    out.push(atom("boundary", "table"));
    for (const row of node.children as TableRow[]) {
      out.push(atom("boundary", "row"));
      for (const cell of row.children) {
        out.push(atom("boundary", "cell"));
        // Paragraphs in a cell are separated by <br>; an empty cell has one empty paragraph.
        let part: PhrasingContent[] = [];
        for (const child of [...cell.children, raw("<br>")]) {
          if (child.type === "html" && /^<br\s*\/?>$/i.test(child.value)) {
            out.push(...inline({ ...ctx, cell: true }, part), end(ctx, { heading: 0 }));
            part = [];
          } else part.push(child);
        }
      }
    }
    out.push(atom("boundary", "/table"));
  } else throw unsupported(node.type);
}

function list(ctx: ParseContext, node: List, level: number, id: string, out: Atom[]) {
  let number = node.start ?? 1;
  for (const item of node.children as ListItem[]) {
    // An item without text, holding just a nested list, stands for a level the list skips.
    const nested = item.children[0]?.type === "list";
    const first = nested ? undefined : item.children[0];
    const rest = nested ? item.children : item.children.slice(1);
    if (first && first.type !== "paragraph") throw unsupported(first.type);
    const props = { heading: 0, list: { id, level, ordered: !!node.ordered, number: number++ } };
    if (first || !rest.length) out.push(...inline(ctx, first?.children ?? []), end(ctx, props));
    for (const child of rest) {
      if (child.type !== "list") throw new Unsupported("list items can hold only one paragraph and nested lists.");
      list(ctx, child, level + 1, id, out);
    }
  }
}

/** A suggestion being parsed: its kind, where it starts and, for a replace, where the new text starts. */
type Region = { kind: "{++" | "{--" | "{~~"; start: number; middle?: number; closed?: boolean };

function inline(ctx: ParseContext, nodes: PhrasingContent[]): Atom[] {
  const out: Atom[] = [];
  // Open suggestions, innermost last: a deletion can nest in an insertion (someone suggests deleting text
  // someone else suggested).
  const regions: Region[] = [];
  const top = () => regions.at(-1);

  /** Ends the closed suggestion on top, with the IDs after it, or as a new one if none follow. */
  const finish = (ids?: string[]) => {
    const region = regions.pop() as Region;
    const own = (atoms: Atom[]) => atoms.filter((a) => a.kind !== "annotation");
    const before = own(out.slice(region.start, region.middle));
    const after = region.middle === undefined ? [] : own(out.slice(region.middle));
    // A replace with the same text is a style change: {~~a~>**a**~~}.
    if (before.length && before.length === after.length && before.every((a, k) => a.key === after[k]?.key)) {
      const changes = ids ?? [ctx.fresh()];
      before.forEach((a, k) => {
        a.styleChanges = changes;
        a.restyled = after[k]?.marks;
      });
      out.length = region.middle ?? out.length;
      return;
    }
    const id = ids?.join(" ") ?? ctx.fresh();
    for (const a of before) {
      if (region.kind === "{++") a.ins = id;
      else a.del = id;
    }
    for (const a of after) a.ins = id;
  };

  const markup = (source: string, marks: Marks) => {
    const value = ctx.cell ? unescapeCell(source) : source;
    if (value === SEPARATOR) return;
    const suggestion = value.match(/^\{>>s:([^<>]+)<<\}$/)?.[1]?.split(" ");
    if (top()?.closed && !(suggestion && suggestion.at(-1) !== "style")) finish();
    if (value === LINE_BREAK) {
      out.push(atom("text", "\u000b", marks));
      return;
    }
    if (value.startsWith("{{")) {
      out.push({ ...atom("element", value, marks), nodes: [raw(value)] });
      return;
    }
    const region = top();
    if (suggestion?.at(-1) === "style") {
      ctx.endChanges.push(...suggestion.slice(0, -1));
      return;
    }
    if (suggestion) {
      if (!region?.closed) throw new Unsupported(`${value} doesn't follow a suggestion.`);
      finish(suggestion);
      return;
    }
    if (value === "{++" || value === "{--" || value === "{~~") {
      const inserting = region && (region.kind === "{++" || region.middle !== undefined);
      if (region && !(value === "{--" && inserting && regions.length === 1))
        throw new Unsupported(
          `${value} inside ${region.kind}: suggestions don't nest, so a new one can't hold a pending one (with ` +
            "its {>>s:…<<}). Suggest changes to the text around pending suggestions, or ask for them to be " +
            "accepted or rejected first.",
        );
      regions.push({ kind: value, start: out.length });
    } else if (value === "~>" && region?.kind === "{~~" && region.middle === undefined) {
      region.middle = out.length;
    } else if (region && value === `${region.kind.slice(1, 3)}}`) {
      region.closed = true;
    } else if (value === "{==" || value === "==}") {
      out.push(atom("annotation", value));
    } else if (value.startsWith("{>>")) {
      // A thread compares by its ID; what it says is checked separately (see edit.ts).
      const id = value.match(/^\{>>c:([^\s<]+)/)?.[1];
      out.push({ ...atom("annotation", id ? `{>>c:${id}<<}` : value), nodes: [raw(value)], thread: id });
    } else throw new Unsupported(`${value} is out of place.`);
  };

  /** Whether the "@" right before `node` in the source is a literal, escaped one. */
  const escaped = (node: PhrasingContent) => {
    let k = (node.position?.start.offset ?? 0) - 1;
    let backslashes = 0;
    while (ctx.source[--k] === "\\") backslashes++;
    return backslashes % 2 === 1;
  };

  const walk = (node: PhrasingContent, marks: Marks) => {
    if (top()?.closed && node.type !== "html") finish();
    switch (node.type) {
      case "text":
        // A line ending in a paragraph is a space, as Markdown reads it.
        for (const ch of node.value.replace(/\r?\n/g, " ")) out.push(atom("text", ch, marks));
        return;
      case "break":
        out.push(atom("text", "\u000b", marks));
        return;
      case "inlineCode": {
        const code = MARKS.find((m) => m.mdast === "inlineCode")?.name ?? "code";
        for (const ch of node.value) out.push(atom("text", ch, { ...marks, [code]: true }));
        return;
      }
      case "html":
        return markup(node.value, marks);
      case "footnoteReference":
        out.push({
          ...atom("element", `footnote:${ctx.footnoteId(node.label ?? node.identifier)}`, marks),
          nodes: [{ type: "footnoteReference", identifier: node.identifier, label: node.label }],
        });
        return;
      default: {
        // A person chip: "@" right before a mailto link (a literal "@" there is escaped).
        const at = out.at(-1);
        const person = node.type === "link" && node.url.startsWith("mailto:");
        if (person && at?.kind === "text" && at.key === "@" && !escaped(node)) {
          out.pop();
          out.push({
            ...atom("element", `person:${node.url.slice(7)}`, marks),
            nodes: [raw("@"), { ...node, position: undefined }],
          });
          return;
        }
        const rule = WRAPPERS.find((m) => m.mdast === node.type);
        if (!rule || !("children" in node)) throw unsupported(node.type);
        const value = node.type === "link" ? node.url : true;
        for (const child of node.children) walk(child, { ...marks, [rule.name]: value });
      }
    }
  };

  for (const node of nodes) walk(node, {});
  if (top()?.closed) finish();
  const open = top();
  if (open) throw new Unsupported(`${open.kind} isn't closed in its paragraph.`);
  return out;
}

/**
 * docmd to compare by: threads by their ID, and suggestions other than the `pending` ones without an ID, as new
 * ones are written. Two versions of a tab read the same if this is the same.
 */
export function comparable(segments: Segment[], pending: ReadonlySet<string> = new Set()) {
  const id = (s?: string) => (s === undefined || pending.has(s) ? s : NEW);
  return toDocmd(
    segments.map(({ id: segment, atoms }) => ({
      id: segment,
      atoms: atoms.map((a) => ({
        ...a,
        ins: id(a.ins),
        del: id(a.del),
        styleChanges: [...new Set(a.styleChanges.map((s) => id(s) as string))],
        ...(a.thread && a.key.startsWith("{>>c:") ? { nodes: [raw(a.key)] } : {}),
      })),
    })),
  );
}

/** A suggestion that isn't pending yet. */
const NEW = fresh(0);
