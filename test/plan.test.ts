// Planning edits offline, on the captured fixture doc (see render.test.ts).
import { readFileSync } from "node:fs";
import type { docs_v1 } from "googleapis";
import { expect, test } from "vitest";
import { adopt } from "../src/actions.js";
import { comparable, load, parse, toDocmd } from "../src/docmd.js";
import { applyEdits, planEdit, threadsOf } from "../src/edit.js";
import { type Atom, threadKey } from "../src/ir.js";
import { type Problem, plan } from "../src/plan.js";
import { docOf } from "./docs.js";
import type { Doc } from "./helpers.js";

/** Atoms as docmd, for the planner's messages. */
const asDocmd = (atoms: Atom[]) => comparable([{ id: "", atoms }]).trim();
const doc = JSON.parse(readFileSync(new URL("fixtures/doc.json", import.meta.url), "utf8")) as Doc;
// Edits apply to docmd with open threads inline, as read shows it.
const { segments } = load(doc);
const footnotes = segments.slice(1).map((s) => s.id);
const basis = toDocmd(segments);
const known = threadsOf(segments);

/** Plans the doc's docmd replaced by `markdown`, as the edit tool does. */
const planFor = (markdown: string, allowDetach = false, suggest = false) =>
  planEdit(doc, { edits: [{ old: basis, new: markdown }], mode: suggest ? "suggest" : "direct", allowDetach });
const replace = (old: string, next: string, suggest = false) => {
  expect(basis).toContain(old);
  return planFor(basis.replace(old, next), false, suggest);
};
const suggest = (old: string, next: string) => replace(old, next, true);

test("docmd parses back to what it was rendered from", () => {
  // (Who made a suggestion is the doc's, not the docmd's: parsed, it's no one.)
  expect(toDocmd(parse(basis, footnotes), {})).toBe(basis.replace(/\{>>@[^:<]*<<\}/g, ""));
  for (const suggest of [false, true]) {
    const { batch, problems } = planFor(basis, false, suggest);
    expect({ batch, problems }).toEqual({ batch: [], problems: [] });
  }
});

test("replacing a word", () => {
  expect(replace("Bold with a", "Bold with one").requests).toEqual([
    { insertText: { location: { index: 309 }, text: "one" } },
    { deleteContentRange: { range: { startIndex: 308, endIndex: 309 } } },
  ]);
});

const codes = (p: { problems: Problem[] }) => p.problems.map((x) => x.code);

const THREAD = "doco.p09L3euGEQOxA40zwaHU6A";
const POSTS = "{>>@Test User: Which workspaces first?<<}{>>@Test User: EU first, then US.<<}";
const ANCHORED = `{==ship to all workspaces==}${POSTS}`;

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
  expect(planFor(replaced, true).problems).toEqual([]);
  // With its markup, too: the thread stays, without its text.
  const removed = basis.replace(`${ANCHORED} `, "");
  expect(codes(planFor(removed))).toEqual(["anchors_affected"]);
  expect(planFor(removed, true).outcome).toEqual(['The comment on "ship to all workspaces" stays, without its text.']);
});

/** Plans edits of the docmd as the edit tool does, comments and pending suggestions included. */
const editing = (old: string, next: string, mode?: "direct") => {
  expect(basis).toContain(old);
  return planEdit(doc, { edits: [{ old, new: next }], mode });
};

test("comments are added, replied to and resolved through edits, and otherwise read-only", () => {
  // A new comment is on the highlighted text before it; the rest of the edit is planned without it.
  const added = editing("in Q3", "in {==Q3==}{>>Why *Q3*\\}?<<}");
  expect(added.comments.map((c) => [c.content, c.on.map((a) => a.key).join("")])).toEqual([["Why *Q3*}?", "Q3"]]);
  expect(added.batch).toEqual([]);
  expect(codes(editing("in Q3", "in Q3{>>why?<<}"))).toEqual(["comments_read_only"]);
  // A new comment is the user's: it can't say it's someone else's.
  expect(codes(editing("in Q3", "in {==Q3==}{>>@Ann: Why?<<}"))).toEqual(["comments_read_only"]);
  // A reply is a comment after the thread's last, and several are several.
  const thread = POSTS;
  const reply = (content: string) => ({ addCommentReply: { commentId: THREAD, post: { content } } });
  expect(editing(thread, `${thread}{>>Agreed\\}.<<}`).batch).toEqual([reply("Agreed}.")]);
  expect(editing(`${thread} in Q3`, `${thread}{>>One.<<}{>>Two.<<} in Q3`).batch).toEqual([
    reply("One."),
    reply("Two."),
  ]);
  const last = "{>>@Test User: EU first, then US.<<}";
  expect(editing(last, `${last}{>>Ok.<<}`).batch).toEqual([reply("Ok.")]);
  // Read before the last reply came in: a reply still goes after it, and resolving takes it along.
  const stale = thread.replace(last, "");
  expect(planEdit(doc, { edits: [{ old: stale, new: `${stale}{>>Ok.<<}` }] }).batch).toEqual([reply("Ok.")]);
  expect(
    planEdit(doc, { edits: [{ old: `{==ship to all workspaces==}${stale}`, new: "ship to all workspaces" }] }).batch,
  ).toEqual([{ addCommentReply: { commentId: THREAD, post: { commentAction: "RESOLVE" } } }]);
  expect(codes(editing("in Q3", "in {==Q3==}{>>New.<<}{>>Reply.<<}"))).toEqual(["comments_read_only"]);
  // Removing a thread's markup resolves it; text edits can come with that.
  expect(editing(ANCHORED, "send to all workspaces", "direct").batch).toEqual([
    { insertText: { location: { index: 438 }, text: "send" } },
    { deleteContentRange: { range: { startIndex: 434, endIndex: 438 } } },
    { addCommentReply: { commentId: THREAD, post: { commentAction: "RESOLVE" } } },
  ]);
  // Moving an anchor, or dropping part of a thread's markup.
  expect(codes(replace("{==ship to", "ship {==to"))).toContain("comments_read_only");
  expect(codes(editing(ANCHORED, "{==ship to all workspaces==}"))).toEqual(["comments_read_only"]);
  // What a thread says can't change: not a comment's text, and no comment can go but with all of it.
  for (const changed of [
    ANCHORED.replace("EU first", "US first"),
    ANCHORED.replace("{>>@Test User: EU first, then US.<<}", ""),
  ])
    expect(() => applyEdits(basis, [{ old: ANCHORED, new: changed }], known)).toThrow(/^comments_read_only:/);
  expect(codes(editing(ANCHORED, ANCHORED.replace("{>>@Test User: Which", "{>>@Test User: When")))).toEqual([
    "comments_read_only",
  ]);
  // Old from before a reply came in still matches, and the thread stays as it is.
  const before = ANCHORED.replace("{>>@Test User: EU first, then US.<<}", "");
  expect(applyEdits(basis, [{ old: `${before} in Q3`, new: `${before} in Q4` }], known)).toContain(
    `{==ship to all workspaces==}${threadKey(THREAD)} in Q4`,
  );
});

test("a footnote goes with its reference, and with it the comments in it", () => {
  const unreferenced = basis.replace("footnote[^1]", "footnote");
  expect(codes(planFor(unreferenced))).toEqual(["anchors_affected"]);
  expect(planFor(unreferenced, true).problems).toEqual([]);
});

test("insertions at one index go in in order", () => {
  // Around a thread's end: "!" before it, "," after it.
  expect(basis).toContain("workspaces==}");
  const { requests } = planFor(basis.replace("workspaces==}", "workspaces!==}").replace("<<} in Q3", "<<}, in Q3"));
  expect(requests.map((r) => r.insertText?.text)).toEqual([",", "!"]);
  expect(new Set(requests.map((r) => r.insertText?.location?.index)).size).toBe(1);
});

test("pending suggestions are accepted or rejected by removing their markup, and otherwise can't be edited", () => {
  const choices = (old: string, next: string, mode?: "direct") => {
    const r = editing(old, next, mode);
    expect(r.problems).toEqual([]);
    return r.batch;
  };
  const deletion = "{--really --}";
  const restyled = "{~~important~>**important**~~}";
  expect(choices(deletion, "")).toEqual([{ acceptSuggestion: { suggestionId: "suggest.kofj33at3kam" } }]);
  expect(choices(deletion, "really ")).toEqual([{ rejectSuggestion: { suggestionId: "suggest.kofj33at3kam" } }]);
  expect(choices(restyled, "**important**")).toEqual([{ acceptSuggestion: { suggestionId: "suggest.lelfozq0mw3i" } }]);
  expect(choices(restyled, "important")).toEqual([{ rejectSuggestion: { suggestionId: "suggest.lelfozq0mw3i" } }]);
  // The rest is planned on the doc as it is once they're accepted or rejected: "important" is at 529-538 once
  // "really " (529-536) is gone, and "seat" at 483 once "$20" (475-478) is.
  expect(choices(`${deletion}${restyled}`, `${restyled} indeed`, "direct")).toEqual([
    { acceptSuggestion: { suggestionId: "suggest.kofj33at3kam" } },
    { insertText: { location: { index: 538 }, text: " indeed" } },
  ]);
  // (A change's author goes with it, or is left out.)
  expect(choices("{~~$20~>$25~~}{>>@Test User<<} per seat", "$25 per {~~seat~>user~~}")).toEqual([
    { acceptSuggestion: { suggestionId: "suggest.2cmsco9u7wix" } },
    { insertText: { location: { index: 487 }, text: "user" } },
    { deleteContentRange: { range: { startIndex: 483, endIndex: 487 } } },
  ]);
  // A change's author can go with its markup, or stay.
  expect(choices("{~~$20~>$25~~}{>>@Test User<<}", "$25")).toEqual([
    { acceptSuggestion: { suggestionId: "suggest.2cmsco9u7wix" } },
  ]);
  expect(choices("{~~$20~>$25~~}", "$20")).toEqual([{ rejectSuggestion: { suggestionId: "suggest.2cmsco9u7wix" } }]);
  // Neither accepted nor rejected, or edited.
  expect(codes(editing(restyled, "*important*"))).toEqual(["anchors_affected"]);
  expect(codes(replace("$25~~}", "$30~~}"))).toEqual(["anchors_affected"]);
  expect(codes(replace(restyled, restyled.replace("**important**", "*important*")))).toEqual(["anchors_affected"]);
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
  // A heading level, as a change of the paragraph's Markdown; not outside CriticMarkup.
  expect(suggest("\n\nBold with a", "\n\n{++## ++}Bold with a").requests.map((r) => Object.keys(r)[0])).toEqual([
    "updateParagraphStyle",
  ]);
  expect(codes(suggest("\n\nBold with a", "\n\n# Bold with a"))).toEqual(["unsupported_edit"]);
});

test("edits can't create chips, or suggestions when written directly", () => {
  expect(codes(replace("per seat.", "per {++new++} seat."))).toEqual(["unsupported_edit"]);
  expect(codes(replace("Chips:", "Chips: {{date:2027-01-01}}"))).toEqual(["unsupported_edit"]);
});

test("a run of spaces shows as one, and goes with it", () => {
  const d = docOf([{ parts: [{ text: "one  \t two" }] }]);
  expect(toDocmd(load(d).segments)).toBe("one two\n\nend\n");
  const edit = (next: string) => planEdit(d, { edits: [{ old: "one two", new: next }], mode: "direct" }).requests;
  expect(edit("two")).toEqual([{ deleteContentRange: { range: { startIndex: 1, endIndex: 8 } } }]);
  expect(edit("one")).toEqual([{ deleteContentRange: { range: { startIndex: 4, endIndex: 11 } } }]);
});

test("a line ending within a paragraph is a space", () => {
  expect(replace("Bold with a", "Bold\nwith a").requests).toEqual([]);
});

// ---- Content the fixture doesn't have ----

/** Plans `edit` of the doc's docmd as the edit tool does, with `mine` the user's own suggestions. */
const planOn = (d: Doc, edit: (docmd: string) => string = (s) => s, suggest = false, mine: string[] = []) => {
  const { segments, threads } = load(d);
  const docmd = toDocmd(segments);
  const edited = parse(
    applyEdits(edit(docmd), [], threadsOf(segments)),
    segments.slice(1).map((s) => s.id),
  );
  const { requests, problems } = plan(segments, adopt(segments, edited), {
    suggest,
    threads: threads.map((t) => ({ id: t.comment.commentId ?? "", quote: "", ranges: t.ranges })),
    allowDetach: false,
    mine,
    docmd: asDocmd,
  });
  return { docmd, requests, problems };
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
  expect(docmd).toBe(String.raw`a<br>{{date:2026-12-01}} b<br>

**x{{date:2026-12-01}}**{{date:2026-12-01}}

a{++bc{--d--}++}

{~~~~old~~~>new~~}

a {~~b~>**b**~~} c

pq

{--x--}{++x++}

\@[Bob](mailto:bob@example.com)

- one
  - - three

| {==c==}{>>@Ann: x\|y<<}{{link:https://drive.google.com/x\|a\|b}} |
| - |

end
`);
  expect(result).toEqual({ requests: [], problems: [] });
});

test("a pending paragraph style suggestion is a change of the paragraph's line, and keeps its paragraph break", () => {
  const d = docOf([{ parts: [{ text: "Title" }], suggested: "s1" }, { parts: [{ text: "body" }] }]);
  const line = "{~~Title~>## Title~~}";
  const { docmd, problems } = planOn(d, (s) => s.replace(`${line}\n\nbody`, `${line} body`), true);
  expect(docmd).toContain(`${line}\n\nbody`);
  expect(problems.map((p) => p.code)).toEqual(["anchors_affected"]);
  // Accepted or rejected like any other: by writing the line it suggests, or the line as it is.
  const choose = (next: string) => planEdit(d, { edits: [{ old: line, new: next }] }).batch;
  expect(choose("## Title")).toEqual([{ acceptSuggestion: { suggestionId: "s1" } }]);
  expect(choose("Title")).toEqual([{ rejectSuggestion: { suggestionId: "s1" } }]);
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
  const add = (s: string) => s.replace("++}workspaces", "++}{++EU ++}workspaces");
  expect(codes(planOn(d, add, true, ["s1"]))).toEqual(["anchors_affected"]);
  // Someone else's suggestion stays separate.
  expect(planOn(d, add, true).problems).toEqual([]);
});
