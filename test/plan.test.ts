// Planning edits offline, on the captured fixture doc (see render.test.ts).
import { readFileSync } from "node:fs";
import type { docs_v1 } from "googleapis";
import { expect, test } from "vitest";
import { comparable, load, parse, toDocmd } from "../src/docmd.js";
import { applyEdits } from "../src/edit.js";
import type { Atom } from "../src/ir.js";
import { plan } from "../src/plan.js";
import type { Doc } from "./helpers.js";

/** Atoms as docmd, for the planner's messages. */
const asDocmd = (atoms: Atom[]) => comparable([{ id: "", atoms }]).trim();
const doc = JSON.parse(readFileSync(new URL("fixtures/doc.json", import.meta.url), "utf8")) as Doc;
// Edits apply to docmd with open threads inline, as read shows it.
const { segments, threads: anchored } = load(doc);
const footnotes = segments.slice(1).map((s) => s.id);
const basis = toDocmd(segments);
const threads = anchored.map((t) => ({
  id: t.comment.commentId ?? "",
  quote: t.comment.plainTextQuote ?? "",
  ranges: t.ranges,
}));

const planFor = (markdown: string, allowDetach: string[] = [], suggest = false) =>
  plan(segments, parse(markdown, footnotes), {
    suggest,
    threads,
    allowDetach,
    mine: [],
    docmd: asDocmd,
  });
const replace = (old: string, next: string, suggest = false) => {
  expect(basis).toContain(old);
  return planFor(basis.replace(old, next), [], suggest);
};
const suggest = (old: string, next: string) => replace(old, next, true);

test("docmd parses back to what it was rendered from", () => {
  expect(toDocmd(parse(basis, footnotes), {})).toBe(basis);
  expect(planFor(basis)).toEqual({ requests: [], problems: [] });
  expect(planFor(basis, [], true)).toEqual({ requests: [], problems: [] });
});

test("replacing a word", () => {
  expect(replace("Bold with a", "Bold with one").requests).toEqual([
    { insertText: { location: { index: 309 }, text: "one" } },
    { deleteContentRange: { range: { startIndex: 308, endIndex: 309 } } },
  ]);
});

const codes = (p: ReturnType<typeof planFor>) => p.problems.map((x) => x.code);

const THREAD = "doco.p09L3euGEQOxA40zwaHU6A";
const ANCHORED = `{==ship to all workspaces==}{>>c:${THREAD} Test User: Which workspaces first? · Test User: EU first, then US.<<}`;

test("commented text can be edited, but removing all of it needs allowDetach", () => {
  expect(replace("ship to all workspaces", "ship everywhere").problems).toEqual([]);
  // Docs keeps text inserted at an anchor's edge out of it: a replaced last word goes in before the old one, and
  // text added at either edge is refused.
  const [insert, remove] = replace("workspaces==}", "regions==}").requests;
  const at = insert?.insertText?.location?.index ?? 0;
  expect(remove?.deleteContentRange?.range?.startIndex).toBe(at + "regions".length);
  expect(codes(replace("workspaces==}", "workspaces too==}"))).toEqual(["comments_read_only"]);
  expect(codes(replace("{==ship", "{==now ship"))).toEqual(["comments_read_only"]);
  const replaced = basis.replace("ship to all workspaces", "go everywhere");
  expect(codes(planFor(replaced))).toEqual(["anchors_affected"]);
  expect(planFor(replaced, [THREAD]).problems).toEqual([]);
  // With its markup, too.
  const removed = basis.replace(`${ANCHORED} `, "");
  expect(codes(planFor(removed))).toEqual(["comments_read_only", "anchors_affected"]);
  expect(planFor(removed, [THREAD]).problems).toEqual([]);
});

test("comments are read-only", () => {
  // Moving an anchor, dropping a thread's markup, adding a thread, removing an unanchored thread.
  expect(codes(replace("{==ship to", "ship {==to"))).toContain("comments_read_only");
  expect(codes(replace(ANCHORED, "ship to all workspaces"))).toContain("comments_read_only");
  expect(codes(replace("in Q3", "in {==Q3==}{>>Me: why?<<}"))).toContain("comments_read_only");
  expect(codes(replace("\n\n{>>c:doco.wY-1dDsUeApJ0aHPsiqZFg Test User: Gone soon.<<}", ""))).toContain(
    "comments_read_only",
  );
  // What a thread says is compared between old and new, so a reply in the meantime doesn't break old.
  const edit = { old: ANCHORED, new: ANCHORED.replace("EU first", "US first") };
  expect(() => applyEdits(basis, [edit])).toThrow(/^comments_read_only:/);
  const stale = ANCHORED.replace(" · Test User: EU first, then US.", "");
  expect(applyEdits(basis, [{ old: `${stale} in Q3`, new: `${stale} in Q4` }])).toContain(
    `{==ship to all workspaces==}{>>c:${THREAD}<<} in Q4`,
  );
  // A thread shortened to its ID in old can be copied in full into new.
  const full = ANCHORED.slice(ANCHORED.indexOf("{>>"));
  expect(applyEdits(basis, [{ old: `{>>c:${THREAD}<<} in Q3`, new: `${full} in Q4` }])).toContain("in Q4");
});

test("a footnote goes with its reference, and with it the comments in it", () => {
  const unreferenced = basis.replace("footnote[^1]", "footnote");
  expect(codes(planFor(unreferenced))).toEqual(["anchors_affected"]);
  expect(planFor(unreferenced, ["doco._e6AaL_wIoUwA7KW-htung"]).problems).toEqual([]);
});

test("insertions at one index go in in order", () => {
  // Around a thread's end: "!" before it, "," after it.
  expect(basis).toContain("workspaces==}");
  const { requests } = planFor(basis.replace("workspaces==}", "workspaces!==}").replace("<<} in Q3", "<<}, in Q3"));
  expect(requests.map((r) => r.insertText?.text)).toEqual([",", "!"]);
  expect(new Set(requests.map((r) => r.insertText?.location?.index)).size).toBe(1);
});

test("pending suggestions can't be edited", () => {
  expect(codes(replace("$25~~}", "$30~~}"))).toEqual(["anchors_affected"]);
  expect(codes(replace("{--really --}{>>s:suggest.kofj33at3kam<<}", ""))).toEqual(["anchors_affected"]);
  // A style suggestion, neither what it suggests nor its markup.
  const restyled = "{~~important~>**important**~~}{>>s:suggest.lelfozq0mw3i<<}";
  expect(codes(replace(restyled, restyled.replace("**important**", "*important*")))).toEqual(["anchors_affected"]);
  expect(codes(replace(restyled, "important"))).toEqual(["anchors_affected"]);
});

test("suggestions are written in CriticMarkup, and go where it puts them", () => {
  // Outside CriticMarkup, the text and its formatting stay as they are.
  expect(codes(suggest("Bold with a", "Bold with one"))).toEqual(["unsupported_edit"]);
  expect(codes(suggest("Bold with a", "Bold with **a**"))).toEqual(["unsupported_edit"]);
  // A replace reads as written: the old text first, or the new.
  expect(suggest("Bold with a", "Bold with {~~a~>one~~}").requests).toEqual([
    { insertText: { location: { index: 309 }, text: "one" } },
    { deleteContentRange: { range: { startIndex: 308, endIndex: 309 } } },
  ]);
  expect(suggest("Bold with a", "Bold with {++one++}{--a--}").requests).toEqual([
    { insertText: { location: { index: 308 }, text: "one" } },
    { deleteContentRange: { range: { startIndex: 311, endIndex: 312 } } },
  ]);
  expect(suggest("Bold with a", "Bold with {~~a~>**a**~~}").requests).toEqual([
    { updateTextStyle: { range: { startIndex: 308, endIndex: 309 }, textStyle: { bold: true }, fields: "bold" } },
  ]);
  // A whole paragraph, with its break.
  expect(suggest("Spaces at both edges.", "{--Spaces at both edges.--}").requests).toEqual([
    { deleteContentRange: { range: { startIndex: 332, endIndex: 355 } } },
  ]);
  // At a comment's end, new text goes in first or it would fall outside the comment.
  expect(codes(suggest("all workspaces==}", "all {~~workspaces~>regions~~}==}"))).toEqual(["comments_read_only"]);
  expect(suggest("all workspaces==}", "all {++regions++}{--workspaces--}==}").problems).toEqual([]);
  // A heading level can't be suggested yet.
  expect(codes(suggest("\n\nBold with a", "\n\n# Bold with a"))).toEqual(["unsupported_edit"]);
});

test("edits can't create chips, or suggestions when written directly", () => {
  expect(codes(replace("per seat.", "per {++new++} seat."))).toEqual(["unsupported_edit"]);
  // Not with a made-up suggestion ID, nor with one of a pending suggestion.
  expect(codes(replace("per seat.", "per {--seat--}{>>s:fake<<}."))).toEqual(["unsupported_edit"]);
  expect(codes(replace("per seat.", "per seat.{>>s:fake style<<}"))).toEqual(["unsupported_edit"]);
  expect(codes(replace("per seat.", "per {++user++}{>>s:suggest.2cmsco9u7wix<<} seat."))).toEqual(["anchors_affected"]);
  expect(codes(replace("Chips:", "Chips: {{date:2027-01-01}}"))).toEqual(["unsupported_edit"]);
});

test("a line ending within a paragraph is a space", () => {
  expect(replace("Bold with a", "Bold\nwith a").requests).toEqual([]);
});

// ---- Content the fixture doesn't have ----

type Part = {
  text?: string;
  style?: docs_v1.Schema$TextStyle;
  ins?: string;
  del?: string;
  /** A suggested style change: its ID and the fields it sets. */
  restyle?: [string, docs_v1.Schema$TextStyle];
  element?: object;
  /** What a comment on the part says. */
  comment?: string;
};
type Block = { parts: Part[]; level?: number; list?: string; suggested?: string } | { cells: Part[][] };

/** A doc of paragraphs (list items at `level`) and tables of one row. */
function docOf(blocks: Block[]): Doc {
  let index = 1;
  const comments: { id: string; range: docs_v1.Schema$Range; text: string }[] = [];
  const paragraph = (parts: Part[], extra: docs_v1.Schema$Paragraph = {}) => {
    const startIndex = index;
    const elements = [...parts, { text: "\n" }].map(({ text, style, ins, del, restyle, element, comment }: Part) => {
      const at = index;
      index += text?.length ?? 1;
      if (comment)
        comments.push({ id: `t${comments.length + 1}`, range: { startIndex: at, endIndex: index }, text: comment });
      const common = {
        textStyle: style ?? {},
        ...(ins ? { suggestedInsertionIds: [ins] } : {}),
        ...(del ? { suggestedDeletionIds: [del] } : {}),
        ...(restyle
          ? {
              suggestedTextStyleChanges: {
                [restyle[0]]: {
                  textStyle: restyle[1],
                  textStyleSuggestionState: Object.fromEntries(
                    Object.keys(restyle[1]).map((k) => [`${k}Suggested`, true]),
                  ),
                },
              },
            }
          : {}),
      };
      const [kind, value] = Object.entries(element ?? { textRun: { content: text } })[0] ?? [];
      return { startIndex: at, endIndex: index, [kind as string]: { ...value, ...common } };
    });
    return { startIndex, endIndex: index, paragraph: { elements, ...extra } };
  };
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  for (const block of blocks) {
    if ("cells" in block) {
      const startIndex = index;
      index += 2;
      const tableCells = block.cells.map((parts) => ({ startIndex: index++, content: [paragraph(parts)] }));
      index++;
      content.push({ startIndex, endIndex: index, table: { tableRows: [{ startIndex: startIndex + 1, tableCells }] } });
    } else
      content.push(
        paragraph(block.parts, {
          ...(block.level !== undefined ? { bullet: { listId: block.list ?? "list", nestingLevel: block.level } } : {}),
          ...(block.suggested ? { suggestedParagraphStyleChanges: { [block.suggested]: {} } } : {}),
        }),
      );
  }
  content.push(paragraph([{ text: "end" }]));
  const commentAnchors = Object.fromEntries(comments.map((c) => [c.id, { ranges: [c.range] }]));
  return {
    revisionId: "r",
    tabs: [
      {
        documentTab: {
          body: { content },
          commentAnchors,
          lists: { list: { listProperties: {} }, other: { listProperties: {} } },
        },
      },
    ],
    comments: comments.map((c) => ({
      commentId: c.id,
      anchorId: c.id,
      status: "OPEN",
      headPost: { author: { displayName: "Ann" }, content: c.text },
    })),
  } as Doc;
}

const planOn = (d: Doc, edit: (docmd: string) => string = (s) => s, suggest = false, mine: string[] = []) => {
  const { segments, threads } = load(d);
  const docmd = toDocmd(segments);
  return {
    docmd,
    ...plan(
      segments,
      parse(
        edit(docmd),
        segments.slice(1).map((s) => s.id),
      ),
      {
        suggest,
        threads: threads.map((t) => ({ id: t.comment.commentId ?? "", quote: "", ranges: t.ranges })),
        allowDetach: [],
        mine,
        docmd: asDocmd,
      },
    ),
  };
};

test("content without a direct Markdown form parses back to what it was rendered from", () => {
  const date = (style: docs_v1.Schema$TextStyle) => ({
    style,
    element: { dateElement: { dateElementProperties: { timestamp: "2026-12-01T00:00:00Z" } } },
  });
  const link = { element: { richLink: { richLinkProperties: { uri: "https://drive.google.com/x", title: "a|b" } } } };
  const d = docOf([
    // Line breaks before a chip and at the paragraph's end; chips in bold and code.
    { parts: [{ text: "a\u000b" }, date({}), { text: " b\u000b" }] },
    {
      parts: [
        { text: "x", style: { bold: true } },
        date({ bold: true }),
        date({ weightedFontFamily: { fontFamily: "Roboto Mono" } }),
      ],
    },
    // A suggested deletion of a suggested insertion, and strikethrough in a suggested replace.
    { parts: [{ text: "a" }, { text: "bc", ins: "s1" }, { text: "d", ins: "s1", del: "s2" }] },
    {
      parts: [
        { text: "old", style: { strikethrough: true }, del: "s3" },
        { text: "new", ins: "s3" },
      ],
    },
    // Style suggestions: bold on text with spaces at its edges, and one docmd can't show; a replace of text
    // with the same text.
    { parts: [{ text: "a" }, { text: " b ", restyle: ["s4", { bold: true }] }, { text: "c" }] },
    { parts: [{ text: "pq", restyle: ["s6", { underline: true }] }] },
    {
      parts: [
        { text: "x", del: "s5" },
        { text: "x", ins: "s5" },
      ],
    },
    // A literal "@" before a mailto link.
    { parts: [{ text: "@" }, { text: "Bob", style: { link: { url: "mailto:bob@example.com" } } }] },
    // A list that skips a level.
    { parts: [{ text: "one" }], level: 0 },
    { parts: [{ text: "three" }], level: 2 },
    // "|" in a cell: in a chip's title and a comment.
    { cells: [[{ text: "c", comment: "x|y" }, link]] },
  ]);
  const { docmd, ...result } = planOn(d);
  expect(docmd).toBe(String.raw`a{{br}}{{date:2026-12-01}} b{{br}}

**x{{date:2026-12-01}}**{{date:2026-12-01}}

a{++bc{--d--}{>>s:s2<<}++}{>>s:s1<<}

{~~{{}}~~old~~{{}}~>new~~}{>>s:s3<<}

a{~~ b ~> **b** ~~}{>>s:s4<<}c

{~~pq~>pq~~}{>>s:s6<<}

{--x--}{>>s:s5<<}{++x++}{>>s:s5<<}

\@[Bob](mailto:bob@example.com)

- one
  - - three

| {==c==}{>>c:t1 Ann: x\|y<<}{{link:https://drive.google.com/x\|a\|b}} |
| - |

end
`);
  expect(result).toEqual({ requests: [], problems: [] });
});

test("a pending paragraph style suggestion keeps its paragraph break", () => {
  const d = docOf([{ parts: [{ text: "Title" }], suggested: "s1" }, { parts: [{ text: "body" }] }]);
  const { problems } = planOn(d, (s) => s.replace("Title{>>s:s1 style<<}\n\nbody", "Title body"));
  expect(problems.map((p) => p.code)).toEqual(["anchors_affected"]);
});

test("a new list item joins its list, or is refused", () => {
  const items = (...levels: number[]) => docOf(levels.map((level, k) => ({ parts: [{ text: `item${k}` }], level })));
  const add = (s: string) => s.replace(/(- item1\n)/, "$1- {++new++}\n");
  // After an item at its level, it joins the list.
  expect(planOn(items(0, 0), add, true).requests).toEqual([{ insertText: { location: { index: 12 }, text: "\nnew" } }]);
  // After a nested item it would have to be nested too, or start a separate list: neither is what docmd says.
  expect(codes(planOn(items(0, 1), add, true))).toEqual(["unsupported_edit"]);
  expect(codes(planOn(items(0, 1), (s) => add(s).replace("{++new++}", "new")))).toEqual(["unsupported_edit"]);
  // Nor can an item move into a list next to it.
  const two = docOf([
    { parts: [{ text: "a" }], level: 0 },
    { parts: [{ text: "b" }], level: 0, list: "other" },
  ]);
  expect(codes(planOn(two, (s) => s.replace("- a\n\n* b", "- a\n- b")))).toEqual(["unsupported_edit"]);
});

test("a new suggestion can't touch one of the user's own, which it would join", () => {
  const d = docOf([{ parts: [{ text: "all " }, { text: "paid ", ins: "s1" }, { text: "workspaces" }] }]);
  const add = (s: string) => s.replace("<<}workspaces", "<<}{++EU ++}workspaces");
  expect(codes(planOn(d, add, true, ["s1"]))).toEqual(["anchors_affected"]);
  // Someone else's suggestion stays separate.
  expect(planOn(d, add, true).problems).toEqual([]);
});
