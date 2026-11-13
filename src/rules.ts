// The rules for each kind of content: how it reads from the Docs API, how it shows in docmd, and which
// requests change it. The renderer, parser and planner are generic over these tables, so a new kind of
// content is a new entry here.
import type { docs_v1 } from "googleapis";
import type { Html, PhrasingContent } from "mdast";

type Tab = docs_v1.Schema$DocumentTab;
type TextStyle = docs_v1.Schema$TextStyle;
type Range = docs_v1.Schema$Range;
type Request = docs_v1.Schema$Request;
type ParagraphElement = docs_v1.Schema$ParagraphElement;

// ---- Marks: inline formatting on text and elements ----

export type MarkValue = true | string;
export type Marks = Record<string, MarkValue>;

export type MarkRule = {
  name: string;
  /** The mark's value in a doc text style, if it's set. */
  read(ts: TextStyle): MarkValue | undefined;
  /** The text style and field mask that set the mark to `value`, or clear it. */
  write(value: MarkValue | undefined): { textStyle: TextStyle; fields: string };
  /** The Markdown node: a wrapper around phrasing content (value: the link URL, or true), or the inline code leaf. */
  mdast: "link" | "delete" | "strong" | "emphasis" | "inlineCode";
};

const MONOSPACE = /mono|courier|code|consolas/i;
const flag = (name: string, field: keyof TextStyle, mdast: MarkRule["mdast"]): MarkRule => ({
  name,
  read: (ts) => (ts[field] ? true : undefined),
  write: (value) => ({ textStyle: { [field]: !!value }, fields: field }),
  mdast,
});

/** Wrappers nest in this order, outermost first. */
export const MARKS: MarkRule[] = [
  {
    name: "link",
    read: (ts) => ts.link?.url ?? undefined,
    write: (url) => ({ textStyle: typeof url === "string" ? { link: { url } } : {}, fields: "link" }),
    mdast: "link",
  },
  flag("strike", "strikethrough", "delete"),
  flag("bold", "bold", "strong"),
  flag("italic", "italic", "emphasis"),
  {
    name: "code",
    read: (ts) => (MONOSPACE.test(ts.weightedFontFamily?.fontFamily ?? "") ? true : undefined),
    write: (code) => ({
      textStyle: code ? { weightedFontFamily: { fontFamily: "Roboto Mono" } } : {},
      fields: "weightedFontFamily",
    }),
    mdast: "inlineCode",
  },
];

export function readMarks(ts: TextStyle = {}): Marks {
  const marks: Marks = {};
  for (const m of MARKS) {
    const value = m.read(ts);
    if (value !== undefined) marks[m.name] = value;
  }
  return marks;
}

// ---- Elements: chips and other inline elements, each one index in the doc ----

export type ElementContext = { tab: Tab; footnoteLabel(id: string): string };
export type ElementRule = {
  /** The paragraph element's field in the Docs API. */
  field: keyof ParagraphElement;
  /** Its identity, which the diff compares, and its docmd. */
  read(pe: ParagraphElement, ctx: ElementContext): { key: string; nodes: PhrasingContent[] };
};

/** Backslash-escapes `\`, `}` and the given characters in a token or comment field. */
export const field = (s: string, extra = "") =>
  s.replace(new RegExp(`[\\\\}${extra.replace(/./g, "\\$&")}]`, "g"), "\\$&");
export const raw = (value: string): Html => ({ type: "html", value });
const token = (t: string) => ({ key: t, nodes: [raw(t)] });

export const ELEMENTS: ElementRule[] = [
  {
    field: "person",
    read: (pe) => {
      const { name, email } = pe.person?.personProperties ?? {};
      return {
        key: `person:${email}`,
        nodes: [
          raw("@"),
          { type: "link", url: `mailto:${email}`, children: [{ type: "text", value: name ?? email ?? "" }] },
        ],
      };
    },
  },
  {
    field: "footnoteReference",
    read: (pe, ctx) => {
      const id = pe.footnoteReference?.footnoteId ?? "";
      const label = ctx.footnoteLabel(id);
      return { key: `footnote:${id}`, nodes: [{ type: "footnoteReference", identifier: label, label }] };
    },
  },
  { field: "dateElement", read: (pe) => token(`{{date:${date(pe.dateElement?.dateElementProperties ?? {})}}}`) },
  {
    field: "richLink",
    read: (pe) => {
      const { uri, title } = pe.richLink?.richLinkProperties ?? {};
      return token(`{{link:${field(uri ?? "", "|")}|${field(title ?? "")}}}`);
    },
  },
  {
    field: "dropdown",
    read: (pe, ctx) => {
      const { dropdownDefinitionId, displayValue } = pe.dropdown?.dropdownProperties ?? {};
      const title = ctx.tab.dropdownDefinitions?.[dropdownDefinitionId ?? ""]?.dropdownDefinitionProperties?.title;
      return token(`{{dropdown:${field(title ?? "", "=")}=${field(displayValue ?? "")}}}`);
    },
  },
];

/** Any other element: an opaque token with its kind and ID, which edits keep. */
export function opaque(pe: ParagraphElement) {
  const { startIndex: _, endIndex: __, ...rest } = pe;
  const [kind, value] = Object.entries(rest)[0] ?? ["unknown", {}];
  const id = Object.entries(value ?? {}).find(([k]) => k.endsWith("Id") && !k.startsWith("suggested"))?.[1];
  return token(`{{opaque:${kind}${typeof id === "string" ? `:${id}` : ""}}}`);
}

/** Structural elements without a Markdown form, shown as a paragraph holding just their token. */
export const BLOCKS = ["tableOfContents", "sectionBreak"] as const;
export const blockToken = (kind: (typeof BLOCKS)[number]) => `{{opaque:${kind}}}`;

/** The date in the chip's time zone, plus the time if the chip shows one. */
function date(p: docs_v1.Schema$DateElementProperties) {
  if (p.timeFormat && p.timeFormat !== "TIME_FORMAT_DISABLED") return p.timestamp ?? "";
  const timeZone = p.timeZoneId && p.timeZoneId !== "etc/UTC" ? p.timeZoneId : "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(p.timestamp ?? 0));
}

// ---- Paragraph properties: what docmd shows of a paragraph's style ----

export type Props = {
  /** Heading level, 0 for any other paragraph. */
  heading: number;
  /** List membership; `id` groups items into lists and `number` is the item's number, for rendering only. */
  list?: { id: string; level: number; ordered: boolean; number: number };
};

export type ParagraphRule = {
  /** Whether docmd shows the two the same. */
  same(a: Props, b: Props): boolean;
  /** The requests that change the paragraph at `range` from `current` to `desired`, or why that isn't supported. */
  change(range: Range, current: Props, desired: Props): Request[] | string;
};

export const PARAGRAPH_RULES: ParagraphRule[] = [
  {
    same: (a, b) => a.heading === b.heading,
    change: (range, _, { heading }) => [
      {
        updateParagraphStyle: {
          range,
          paragraphStyle: { namedStyleType: heading ? `HEADING_${heading}` : "NORMAL_TEXT" },
          fields: "namedStyleType",
        },
      },
    ],
  },
  {
    same: (a, b) => a.list?.ordered === b.list?.ordered && a.list?.level === b.list?.level,
    change: (range, current, { list }) =>
      !current.list && list?.level === 0
        ? [
            {
              createParagraphBullets: {
                range,
                bulletPreset: list.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
              },
            },
          ]
        : "Changing list structure isn't supported yet: you can edit the text of list items, add items next to " +
          "existing ones, and add new top-level lists.",
  },
];
