// Edits end to end: planned from docmd, written to a real doc, and read back.
import { expect, test } from "vitest";
import { comparable, load, parse, render, toDocmd } from "../src/docmd.js";
import { applyEdits, createDoc, type Edit, edit } from "../src/edit.js";
import { asShown, type Segment } from "../src/ir.js";
import { type Api, connect, type Doc, describeAccounts, findText } from "./helpers.js";

const MARKDOWN = `# Title heading

Intro with **bold** and plain text.

## Section

- one
- two

| **A** | **B** |
| --- | --- |
| 1 | 2 |

Commented: ship to all workspaces now.

Last paragraph.
`;

// Text after bold that isn't bold, a heading level and a paragraph under it, a list item, code in a cell, text
// at a paragraph's start, a link, a new list at the end, and commented text changed at both its edges.
const EDITS = [
  { old: "{==ship to all workspaces==}", new: "{==send to every workspace==}" },
  { old: "**bold** and plain", new: "**bold** words and *plain*" },
  { old: "## Section", new: "### Section\n\nNew paragraph under the heading." },
  { old: "- two", new: "- two\n- three" },
  { old: "| 1 | 2 |", new: "| 1 | `two` |" },
  { old: "Last paragraph.", new: "Start: last paragraph, with a [link](https://example.com).\n\n1. x\n2. y" },
];

// The same changes as suggestions, except the heading level, which can't be suggested yet.
const SUGGESTIONS = [
  { old: "{==ship to all workspaces==}", new: "{=={~~ship~>send~~} to {++every workspace++}{--all workspaces--}==}" },
  { old: "**bold** and plain", new: "**bold**{++ words++} and {~~plain~>*plain*~~}" },
  { old: "## Section", new: "## Section\n\n{++New paragraph under the heading.++}" },
  { old: "- two", new: "- two\n- {++three++}" },
  { old: "| 1 | 2 |", new: "| 1 | {~~2~>`two`~~} |" },
  {
    old: "Last paragraph.",
    new: "{~~Last~>Start: last~~} paragraph{++, with a [link](https://example.com)++}.\n\n1. {++x++}\n2. {++y++}",
  },
];

// Results are compared as docmd, comment anchors included (threads by ID): docs that read the same are the
// same, as far as edits can tell.
const compared = (segments: Segment[]) => comparable(segments);
const shown = (doc: Doc) => compared(load(doc).segments);
/** What the edits should make of the doc; `then` goes from the docmd's atoms to what's compared. */
function intended(doc: Doc, edits: Edit[], then = (segments: Segment[]) => segments) {
  const { segments } = load(doc);
  const footnotes = segments.slice(1).map((s) => s.id);
  return compared(asShown(then(parse(applyEdits(toDocmd(segments), edits), footnotes))));
}

/** The segments with their suggestions accepted. */
const accepted = (segments: Segment[]) =>
  segments.map((s) => ({
    ...s,
    atoms: s.atoms
      .filter((a) => !a.del)
      .map(({ ins: _, restyled, ...a }) => ({ ...a, marks: restyled ?? a.marks, styleChanges: [] })),
  }));

/** A doc from MARKDOWN with a comment on "ship to all workspaces". */
async function commentedDoc(api: Api, title: string) {
  const id = await api.createDoc(title, MARKDOWN);
  const range = findText(await api.getDoc(id), "ship to all workspaces");
  await api.update(id, [{ insertComment: { content: "Which first?", range } }]);
  return id;
}

describeAccounts((account) => {
  test("create_doc imports Markdown into the app's folder", async () => {
    const api = await connect(account);
    const [result] = await createDoc(api, "gdocs-artifacts test: create_doc", MARKDOWN);
    const id = result?.match(/doc ID ([\w-]+)/)?.[1] ?? "";
    try {
      expect(shown(await api.getDoc(id))).toEqual(compared(asShown(parse(MARKDOWN))));
      const { data } = await api.drive.files.get({ fileId: id, fields: "parents" });
      const { data: folder } = await api.drive.files.get({ fileId: data.parents?.[0] ?? "", fields: "name" });
      expect(folder.name).toBe("gdocs-artifacts");
    } finally {
      await api.drive.files.delete({ fileId: id });
    }
  });

  test("direct edits read back as intended", async () => {
    const api = await connect(account);
    const id = await commentedDoc(api, "edit direct");
    const expected = intended(await api.getDoc(id), EDITS);
    const out = await edit(api, id, { mode: "direct", edits: EDITS });
    expect(out.join("\n")).not.toContain("doesn't read as intended");
    expect(shown(await api.getDoc(id))).toEqual(expected);
  });

  test("suggested edits read back as written, and as intended once accepted", async () => {
    const api = await connect(account);
    const id = await commentedDoc(api, "edit suggest");
    const expected = intended(await api.getDoc(id), SUGGESTIONS, accepted);
    const out = await edit(api, id, { edits: SUGGESTIONS });
    expect(out.join("\n")).not.toContain("doesn't read as intended");
    const doc = await api.getDoc(id);
    // Docs applies a style suggestion on a new paragraph only if it's accepted before the paragraph itself
    // (accepted after it, the paragraph keeps the style it inherited), so formatting goes first.
    const added = (s: { summaryText?: string | null }) => (s.summaryText?.startsWith("Add") ? 1 : 0);
    const ids = (doc.suggestions ?? []).toSorted((x, y) => added(x) - added(y)).map((s) => s.suggestionId ?? "");
    await api.update(
      id,
      ids.map((suggestionId) => ({ acceptSuggestion: { suggestionId } })),
    );
    expect(shown(await api.getDoc(id))).toEqual(expected);
  });

  test("removing commented text is refused and changes nothing", async () => {
    const api = await connect(account);
    const id = await api.createDoc("edit refused", MARKDOWN);
    await api.update(id, [
      { insertComment: { content: "Why plain?", range: findText(await api.getDoc(id), "plain") } },
    ]);
    const before = render(await api.getDoc(id));
    const old = before.match(/and \{==plain==\}\{>>c:.*?<<\} text/)?.[0] ?? "";
    const removed = old.replace("{==plain==}", "{=={--plain--}==}");
    await expect(edit(api, id, { edits: [{ old, new: removed }] })).rejects.toThrow(/comment thread .* on "plain"/);
    expect(render(await api.getDoc(id))).toBe(before);
  });
});
