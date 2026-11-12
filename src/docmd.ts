// Renders one tab of a Google Doc as docmd: Markdown with open comment threads and pending suggestions inline
// as CriticMarkup, chips as {{…}} tokens, and {{opaque:…}} tokens for anything without a Markdown form.
import type { docs_v1 } from "googleapis";
import type { Heading, List, ListItem, Paragraph, PhrasingContent, RootContent, Table } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { ToolError } from "./errors.js";

type Doc = docs_v1.Schema$Document;
type Tab = docs_v1.Schema$DocumentTab;
type Comment = docs_v1.Schema$CommentThread;

export type RenderOptions = {
  /** Defaults to the first tab. */
  tabId?: string;
  /** Which comment threads to show: open ones (default), all (resolved ones marked), or none. */
  comments?: "open" | "all" | "none";
  /** Only the section under the heading with this text, down to the next heading of the same or a higher level. */
  section?: string;
};

const MONOSPACE = /mono|courier|code|consolas/i;
const WRAPPERS = ["link", "strike", "bold", "italic"] as const; // outermost first

type Style = { link?: string; strike: boolean; bold: boolean; italic: boolean; code: boolean };
/** One code point of text, a line break, or an inline element, with its formatting and pending suggestions. */
type Atom = {
  index: number;
  text?: string;
  nodes?: PhrasingContent[];
  style: Style;
  ins?: string;
  del?: string;
  styleChanges: string[];
  /** An insertion that directly follows a deletion with the same suggestion ID: one replace. */
  replaces?: boolean;
};

/** Backslash-escapes `\`, `}` and the given characters in a token or comment field. */
const field = (s: string, extra = "") => s.replace(new RegExp(`[\\\\}${extra.replace(/./g, "\\$&")}]`, "g"), "\\$&");
const raw = (value: string): PhrasingContent => ({ type: "html", value });
const token = (...parts: string[]) => raw(`{{${parts.join(":")}}}`);

export function render(doc: Doc, opts: RenderOptions = {}): string {
  const tab = findTab(doc, opts.tabId);
  const mode = opts.comments ?? "open";
  const comments = (doc.comments ?? []).filter((c) => mode === "all" || (mode === "open" && c.status === "OPEN"));
  const anchors = tab.commentAnchors ?? {};
  const isFirstTab = !opts.tabId || opts.tabId === doc.tabs?.[0]?.tabProperties?.tabId;

  const ctx: Context = {
    tab,
    comments: comments.filter((c) => anchors[c.anchorId ?? ""]),
    counters: {},
    segmentId: "",
    footnotes: [],
  };
  const root: RootContent[] = [];
  let lists: { list: List; level: number; listId: string }[] = [];

  const content = tab.body?.content ?? [];
  for (const el of opts.section ? section(content, opts.section) : content) {
    const p = el.paragraph;
    if (!p?.bullet) lists = [];
    if (p?.bullet) {
      const listId = p.bullet.listId ?? "";
      const level = p.bullet.nestingLevel ?? 0;
      if (lists[0] && lists[0].listId !== listId) lists = [];
      while ((lists.at(-1)?.level ?? -1) > level) lists.pop();
      const number = count(ctx, listId, level);
      let top = lists.at(-1);
      if (!top || top.level < level) {
        const list: List = {
          type: "list",
          ordered: isOrdered(tab, listId, level),
          start: number,
          spread: false,
          children: [],
        };
        const parent = top?.list.children.at(-1);
        (parent ? parent.children : root).push(list);
        top = { list, level, listId };
        lists.push(top);
      }
      const item: ListItem = { type: "listItem", spread: false, children: [paragraph(ctx, p)] };
      top.list.children.push(item);
    } else if (p) {
      const node = paragraph(ctx, p);
      if (!node.children.length) continue;
      const depth = headingLevel(p);
      root.push(depth ? ({ type: "heading", depth, children: node.children } as Heading) : node);
    } else if (el.table) {
      root.push(table(ctx, el.table));
    } else if (el.tableOfContents) {
      root.push({ type: "paragraph", children: [token("opaque", "tableOfContents")] });
    } else if (el.sectionBreak && el.startIndex) {
      // Every body starts with an implicit section break without a start index.
      root.push({ type: "paragraph", children: [token("opaque", "sectionBreak")] });
    }
  }

  // Threads whose text was deleted have no anchor left; they go at the end of the first tab.
  // Footnotes, in the order they're referenced, as Markdown footnote definitions.
  for (const id of ctx.footnotes) {
    ctx.segmentId = id;
    const children = (tab.footnotes?.[id]?.content ?? [])
      .flatMap((el) => (el.paragraph ? [paragraph(ctx, el.paragraph)] : []))
      .filter((p) => p.children.length);
    root.push({ type: "footnoteDefinition", identifier: footnoteLabel(ctx, id), children });
  }

  if (isFirstTab && !opts.section) {
    for (const c of comments.filter((c) => !anchors[c.anchorId ?? ""])) {
      root.push({ type: "paragraph", children: [raw(thread(c))] });
    }
  }

  return toMarkdown(
    { type: "root", children: root },
    {
      bullet: "-",
      listItemIndent: "one",
      incrementListMarker: true,
      extensions: [gfmToMarkdown({ tablePipeAlign: false })],
      // Every literal `{` is escaped, so CriticMarkup and {{…}} in doc text never read as ours.
      unsafe: [{ character: "{", inConstruct: "phrasing" }],
    },
  );
}

const headingLevel = (p?: docs_v1.Schema$Paragraph) =>
  Number(p?.paragraphStyle?.namedStyleType?.match(/^HEADING_([1-6])$/)?.[1] ?? 0);
const plainText = (p: docs_v1.Schema$Paragraph) =>
  (p.elements ?? [])
    .map((pe) => pe.textRun?.content ?? "")
    .join("")
    .trim();

function section(content: docs_v1.Schema$StructuralElement[], title: string) {
  const start = content.findIndex(
    (el) => headingLevel(el.paragraph) && el.paragraph && plainText(el.paragraph) === title,
  );
  if (start < 0) {
    const headings = content.flatMap((el) =>
      headingLevel(el.paragraph) && el.paragraph ? [plainText(el.paragraph)] : [],
    );
    const list = headings.length ? `Headings: ${headings.map((h) => `"${h}"`).join(", ")}.` : "The tab has none.";
    throw new ToolError("section_not_found", `No heading "${title}". ${list}`);
  }
  const level = headingLevel(content[start]?.paragraph);
  const end = content.findIndex(
    (el, i) => i > start && headingLevel(el.paragraph) && headingLevel(el.paragraph) <= level,
  );
  return content.slice(start, end < 0 ? undefined : end);
}

type Context = {
  tab: Tab;
  comments: Comment[];
  counters: Record<string, number[]>;
  /** The segment being rendered: "" for the body, else a footnote ID. Indexes are per segment. */
  segmentId: string;
  /** Footnote IDs in the order they're referenced. */
  footnotes: string[];
};

/** The footnote's label: its position among the footnotes referenced so far. */
function footnoteLabel(ctx: Context, id: string) {
  if (!ctx.footnotes.includes(id)) ctx.footnotes.push(id);
  return String(ctx.footnotes.indexOf(id) + 1);
}

function findTab(doc: Doc, tabId?: string): Tab {
  const all = (tabs: docs_v1.Schema$Tab[]): docs_v1.Schema$Tab[] => tabs.flatMap((t) => [t, ...all(t.childTabs ?? [])]);
  const tab = all(doc.tabs ?? []).find((t) => !tabId || t.tabProperties?.tabId === tabId)?.documentTab;
  if (!tab) throw new Error(tabId ? `no tab ${tabId}` : "doc has no tabs");
  return tab;
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

function table(ctx: Context, t: docs_v1.Schema$Table): Table {
  return {
    type: "table",
    children: (t.tableRows ?? []).map((row) => ({
      type: "tableRow",
      children: (row.tableCells ?? []).map((cell) => ({
        type: "tableCell",
        // Cells hold inline content only; their paragraphs are joined with <br>.
        children: (cell.content ?? [])
          .flatMap((el) => (el.paragraph ? [paragraph(ctx, el.paragraph).children] : []))
          .filter((c) => c.length)
          .flatMap((c, i) => (i ? [raw("<br>"), ...c] : c)),
      })),
    })),
  };
}

function thread(c: Comment) {
  const posts = [c.headPost, ...(c.replies ?? [])].map(
    (p) => `${p?.author?.displayName ?? "Unknown"}: ${(p?.content ?? "").replace(/\s*\n\s*/g, " ")}`,
  );
  const resolved = c.status === "RESOLVED" ? " resolved ·" : "";
  return `{>>c:${c.commentId}${resolved} ${field(posts.join(" · "))}<<}`;
}

function paragraph(ctx: Context, p: docs_v1.Schema$Paragraph): Paragraph {
  const atoms = trimEdges((p.elements ?? []).flatMap((pe) => elementAtoms(ctx, pe)));
  for (const flag of ["bold", "italic", "strike"] as const) trimWhitespace(atoms, flag);
  let prev: Atom | undefined;
  for (const a of atoms) {
    a.replaces = !!a.ins && (prev?.ins === a.ins ? !!prev.replaces : prev?.del === a.ins);
    prev = a;
  }
  const end = p.elements?.at(-1)?.endIndex ?? 0;

  // Comment ranges, clipped to this paragraph: they open and close at the boundary before an atom.
  const opens: string[][] = [...atoms, null].map(() => []);
  const closes: string[][] = [...atoms, null].map(() => []);
  for (const c of ctx.comments) {
    const ranges = (ctx.tab.commentAnchors?.[c.anchorId ?? ""]?.ranges ?? []).filter(
      (r) => (r.segmentId ?? "") === ctx.segmentId,
    );
    for (const r of ranges) {
      const inRange = (a: Atom) => a.index >= (r.startIndex ?? 0) && a.index < (r.endIndex ?? 0);
      const first = atoms.findIndex(inRange);
      if (first < 0) continue;
      opens[first]?.push("{==");
      // The thread follows the last piece of its last range.
      const isLast = r === ranges.at(-1) && (r.endIndex ?? 0) <= end;
      closes[atoms.findLastIndex(inRange) + 1]?.push(isLast ? `==}${thread(c)}` : "==}");
    }
  }

  // Paragraph-level suggestions (style or bullet changes), unless the whole paragraph is a suggestion.
  const inserted = new Set(atoms.map((a) => a.ins));
  const paragraphChanges = Object.keys({ ...p.suggestedParagraphStyleChanges, ...p.suggestedBulletChanges }).filter(
    (id) => !inserted.has(id),
  );

  const children: PhrasingContent[] = [];
  const stack: { key: string; children: PhrasingContent[] }[] = [];
  const container = () => stack.at(-1)?.children ?? children;

  for (let i = 0; i <= atoms.length; i++) {
    const a = atoms[i - 1];
    const b = atoms[i];
    const events = [
      ...suggestionClosers(a, b),
      ...(closes[i] ?? []),
      ...(opens[i] ?? []),
      ...suggestionOpeners(atoms, i),
    ];

    const keys = b ? wrapperKeys(b.style) : [];
    let keep = 0;
    while (keep < stack.length && stack[keep]?.key === keys[keep]) keep++;
    stack.length = keep;
    for (const e of events) container().push(raw(e));
    if (!b) break;
    for (const key of keys.slice(keep)) {
      const node = wrapper(key);
      container().push(node);
      stack.push({ key, children: node.children });
    }
    push(container(), b);
  }
  for (const id of paragraphChanges) children.push(raw(`{>>s:${id} style<<}`));
  return { type: "paragraph", children };
}

function wrapperKeys(s: Style) {
  return WRAPPERS.flatMap((w) => (w === "link" ? (s.link ? [`link:${s.link}`] : []) : s[w] ? [w] : []));
}

function wrapper(key: string): Extract<PhrasingContent, { children: PhrasingContent[] }> {
  if (key.startsWith("link:")) return { type: "link", url: key.slice(5), children: [] };
  return { type: ({ strike: "delete", bold: "strong", italic: "emphasis" } as const)[key as "strike"], children: [] };
}

function push(into: PhrasingContent[], a: Atom) {
  const last = into.at(-1);
  const text = a.text ?? "";
  if (a.nodes) into.push(...a.nodes);
  else if (text === "\u000b") into.push({ type: "break" });
  else if (a.style.code && last?.type === "inlineCode") last.value += text;
  else if (a.style.code) into.push({ type: "inlineCode", value: text });
  else if (last?.type === "text") last.value += text;
  else into.push({ type: "text", value: text });
}

function suggestionClosers(a?: Atom, b?: Atom) {
  const out: string[] = [];
  if (a) for (const id of a.styleChanges) if (!b?.styleChanges.includes(id)) out.push(`{>>s:${id} style<<}`);
  if (a?.del && a.del !== b?.del) out.push(b?.ins === a.del ? "~>" : `--}{>>s:${a.del}<<}`);
  if (a?.ins && a.ins !== b?.ins) out.push(`${a.replaces ? "~~}" : "++}"}{>>s:${a.ins}<<}`);
  return out;
}

function suggestionOpeners(atoms: Atom[], i: number) {
  const a = atoms[i - 1];
  const b = atoms[i];
  const out: string[] = [];
  if (b?.del && b.del !== a?.del) {
    let j = i;
    while (atoms[j]?.del === b.del) j++;
    out.push(atoms[j]?.ins === b.del ? "{~~" : "{--");
  }
  if (b?.ins && b.ins !== a?.ins && a?.del !== b.ins) out.push("{++");
  return out;
}

/** Drops spaces and tabs at the paragraph's edges, which Markdown can't express, unless a suggestion is on them. */
function trimEdges(atoms: Atom[]) {
  const edge = (a?: Atom) => a && (a.text === " " || a.text === "\t") && !a.ins && !a.del;
  let start = 0;
  let end = atoms.length;
  while (start < end && edge(atoms[start])) start++;
  while (end > start && edge(atoms[end - 1])) end--;
  return atoms.slice(start, end);
}

/** Bold, italic and strikethrough spans don't start or end with whitespace, which Markdown can't express. */
function trimWhitespace(atoms: Atom[], flag: "bold" | "italic" | "strike") {
  const blank = (a: Atom) => a.text === " " || a.text === "\t" || a.text === "\u000b";
  const trim = (span: Atom[]) => {
    for (const a of span) {
      if (!blank(a)) break;
      a.style = { ...a.style, [flag]: false };
    }
  };
  let span: Atom[] = [];
  for (const a of [...atoms, undefined]) {
    if (a?.style[flag]) {
      span.push(a);
      continue;
    }
    trim(span);
    trim(span.toReversed());
    span = [];
  }
}

function elementAtoms(ctx: Context, pe: docs_v1.Schema$ParagraphElement): Atom[] {
  const { startIndex, endIndex: _, ...rest } = pe;
  const [kind, value] = Object.entries(rest)[0] as [
    string,
    { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[]; textStyle?: docs_v1.Schema$TextStyle },
  ];
  const ts = value.textStyle ?? {};
  const ins = value.suggestedInsertionIds?.[0];
  const del = value.suggestedDeletionIds?.[0];
  const style: Style = {
    link: ts.link?.url ?? undefined,
    strike: !!ts.strikethrough,
    bold: !!ts.bold,
    italic: !!ts.italic,
    code: MONOSPACE.test(ts.weightedFontFamily?.fontFamily ?? ""),
  };
  const base = { style, ins, del };

  if (pe.textRun) {
    const changes = Object.keys(pe.textRun.suggestedTextStyleChanges ?? {}).filter((id) => id !== ins);
    const content = (pe.textRun.content ?? "").replace(/\n$/, "");
    const atoms: Atom[] = [];
    let index = startIndex ?? 0;
    for (const ch of content) {
      atoms.push({ ...base, index, text: ch, styleChanges: changes });
      index += ch.length;
    }
    return atoms;
  }

  const atom = (nodes: PhrasingContent[]) => [{ ...base, index: startIndex ?? 0, nodes, styleChanges: [] }];
  if (pe.person) {
    const { name, email } = pe.person.personProperties ?? {};
    return atom([
      { type: "text", value: "@" },
      { type: "link", url: `mailto:${email}`, children: [{ type: "text", value: name ?? email ?? "" }] },
    ]);
  }
  if (pe.footnoteReference) {
    const label = footnoteLabel(ctx, pe.footnoteReference.footnoteId ?? "");
    return atom([{ type: "footnoteReference", identifier: label, label }]);
  }
  if (pe.dateElement) return atom([token("date", date(pe.dateElement.dateElementProperties ?? {}))]);
  if (pe.richLink) {
    const { uri, title } = pe.richLink.richLinkProperties ?? {};
    return atom([raw(`{{link:${field(uri ?? "", "|")}|${field(title ?? "")}}}`)]);
  }
  if (pe.dropdown) {
    const { dropdownDefinitionId, displayValue } = pe.dropdown.dropdownProperties ?? {};
    const title = ctx.tab.dropdownDefinitions?.[dropdownDefinitionId ?? ""]?.dropdownDefinitionProperties?.title;
    return atom([raw(`{{dropdown:${field(title ?? "", "=")}=${field(displayValue ?? "")}}}`)]);
  }
  const id = Object.entries(value).find(([k]) => k.endsWith("Id") && !k.startsWith("suggested"))?.[1];
  return atom([token("opaque", kind, ...(typeof id === "string" ? [id] : []))]);
}

/** The date in the chip's time zone, plus the time if the chip shows one. */
function date(p: docs_v1.Schema$DateElementProperties) {
  if (p.timeFormat && p.timeFormat !== "TIME_FORMAT_DISABLED") return p.timestamp ?? "";
  const timeZone = p.timeZoneId && p.timeZoneId !== "etc/UTC" ? p.timeZoneId : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(p.timestamp ?? 0));
}
