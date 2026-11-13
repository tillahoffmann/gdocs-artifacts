// Rendering docs as docmd. The input is a real doc's JSON, captured from the personal account with
// GDOCS_REGENERATE=1 and saved without the account owner's name and email. The doc is kept, so it can be
// inspected in the Docs UI; see CONTRIBUTING.md.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { render } from "../src/docmd.js";
import { accounts, connect, type Doc, findText, firstTab, type Request } from "./helpers.js";

const FIXTURE = new URL("fixtures/doc.json", import.meta.url);

const MARKDOWN = `# Heading 1

## Heading 2

Some **bold**, *italic*, ***both***, ~~strike~~, \`code\` and a [link with **bold**](https://example.com).

- bullet
  - nested bullet
    - deeper
- back out

1. first
   1. sub
2. second

- [ ] open task
- [x] done task

| A | **B** |
| --- | --- |
| 1 | 2 |
`;

const end = { endOfSegmentLocation: {} };
const text = (t: string): Request => ({ insertText: { ...end, text: t } });

async function capture() {
  const { drive, createDoc, getDoc, update } = await connect("gmail");
  const id = await createDoc("render fixture", MARKDOWN, { keep: true });

  await update(id, [
    text("Literal: *stars* _under_ {{token}} {==crit==} <tag> ~tilde~ [brackets] back\\slash\n"),
    text("# not a heading\n- not a list\n1. not a list\n"),
    text("Bold with a trailing space here.\n"),
    text(" Spaces at both edges. \n"),
    text("line one\u000bline two\n"),
    text("Chips: "),
    { insertPerson: { ...end, personProperties: { email: (await me(drive)).email } } },
    text(" "),
    { insertDate: { ...end, dateElementProperties: { timestamp: "2026-12-01T12:00:00Z" } } },
    text(" "),
    { insertRichLink: { ...end, richLinkProperties: { uri: `https://docs.google.com/document/d/${id}/edit` } } },
    text(" "),
    {
      createDropdownDefinition: {
        dropdownDefinition: {
          dropdownDefinitionId: "kix.status",
          dropdownDefinitionProperties: {
            title: "Status",
            options: [
              { optionId: "dropdownItem.open", displayValue: "Open" },
              { optionId: "dropdownItem.done", displayValue: "Done" },
            ],
          },
        },
      },
    },
    { insertDropdown: { ...end, dropdownDefinitionId: "kix.status", selectedOptionId: "dropdownItem.done" } },
    text("\nOpaque: image "),
    {
      insertInlineImage: {
        ...end,
        uri: "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png",
      },
    },
    text(" footnote"),
    { createFootnote: { ...end } },
    text(" page break"),
    { insertPageBreak: { ...end } },
    text("We will ship to all workspaces in Q3.\n"),
    text("Pricing is $20 per seat.\n"),
    text("This is really important.\n"),
    text("temporary text\n"),
  ]);

  let doc = await getDoc(id);
  const footnoteId = Object.keys(firstTab(doc).footnotes ?? {})[0];
  await update(id, [
    { insertText: { location: { segmentId: footnoteId, index: 1 }, text: "A footnote with a comment." } },
  ]);
  const bold = findText(doc, "trailing space ");
  await update(id, [{ updateTextStyle: { range: bold, textStyle: { bold: true }, fields: "bold" } }]);

  // A thread on "comment" in the footnote (its text starts after the footnote's leading space, at index 1).
  const at = 1 + "A footnote with a ".length;
  const range = { segmentId: footnoteId, startIndex: at, endIndex: at + "comment".length };
  await update(id, [{ insertComment: { content: "In a footnote.", range } }]);
  // An open thread with a reply, a resolved one, and one whose text was deleted.
  const open = await update(id, [
    { insertComment: { content: "Which workspaces first?", range: findText(doc, "ship to all workspaces") } },
  ]);
  const openId = open.replies?.[0]?.insertComment?.commentThread?.commentId;
  await update(id, [{ addCommentReply: { commentId: openId, post: { content: "EU first, then US." } } }]);
  const resolved = await update(id, [{ insertComment: { content: "Is Q3 firm?", range: findText(doc, "Q3") } }]);
  const resolvedId = resolved.replies?.[0]?.insertComment?.commentThread?.commentId;
  await update(id, [
    { addCommentReply: { commentId: resolvedId, post: { content: "Yes.", commentAction: "RESOLVE" } } },
  ]);
  const temporary = findText(doc, "temporary text\n");
  await update(id, [{ insertComment: { content: "Gone soon.", range: findText(doc, "temporary") } }]);
  await update(id, [{ deleteContentRange: { range: temporary } }]);

  // Suggestions: a replace, a deletion, a new paragraph and a style change.
  doc = await getDoc(id);
  const price = findText(doc, "$20");
  const really = findText(doc, "really ");
  const important = findText(doc, "important");
  await update(
    id,
    [
      { updateTextStyle: { range: important, textStyle: { bold: true }, fields: "bold" } },
      { deleteContentRange: { range: really } },
      { insertText: { location: { index: price.endIndex }, text: "$25" } },
      { deleteContentRange: { range: price } },
    ],
    { mode: "SUGGEST" },
  );
  doc = await getDoc(id);
  await update(
    id,
    [
      {
        insertText: {
          location: { index: findText(doc, "This is").startIndex },
          text: "A newly suggested paragraph.\n",
        },
      },
    ],
    {
      mode: "SUGGEST",
    },
  );

  const { name, email } = await me(drive);
  const json = JSON.stringify(await getDoc(id), null, 2)
    .replaceAll(email, "test@example.com")
    .replaceAll(name, "Test User");
  writeFileSync(FIXTURE, `${json}\n`);
  console.log(`Fixture doc: https://docs.google.com/document/d/${id}/edit (update CONTRIBUTING.md)`);
}

async function me(drive: Awaited<ReturnType<typeof connect>>["drive"]) {
  const { data } = await drive.about.get({ fields: "user(displayName,emailAddress)" });
  return { name: data.user!.displayName!, email: data.user!.emailAddress! };
}

test.skipIf(process.env.GDOCS_REGENERATE !== "1" || !accounts.includes("gmail"))("capture the fixture", capture);

const doc = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as Doc;

test("renders structure, escapes, chips, footnotes, opaque elements, open threads and pending suggestions", () => {
  // Checklist items have no checked state in the API, so they render as plain bullets.
  expect(render(doc())).toBe(String.raw`# Heading 1

## Heading 2

Some **bold**, *italic*, **_both_**, ~~strike~~, ${"`"}code${"`"} and a [link with **bold**](https://example.com).

- bullet
  - nested bullet
    - deeper
- back out

1. first
   1. sub
2. second

- open task
- done task

| **A** | **B** |
| - | - |
| 1 | 2 |

Literal: \*stars\* \_under\_ \{\{token}} \{==crit==\} \<tag> \~tilde\~ \[brackets] back\slash

\# not a heading

\- not a list

1\. not a list

Bold with a **trailing space** here.

Spaces at both edges.

line one{{br}}line two

Chips: @[Test User](mailto:test@example.com) {{date:2026-12-01}} {{link:https://docs.google.com/document/d/17WiXL47IJFSgzTREfMWyaSBnbBlFgdw15tRsr3VeXvs/edit|gdocs-artifacts test: render fixture}} {{dropdown:Status=Done}}

Opaque: image {{opaque:inlineObjectElement:kix.6bppohf4ny26}} footnote[^1] page break{{opaque:pageBreak}}

We will {==ship to all workspaces==}{>>c:doco.p09L3euGEQOxA40zwaHU6A Test User: Which workspaces first? · Test User: EU first, then US.<<} in Q3.

Pricing is {~~$20~>$25~~}{>>s:suggest.2cmsco9u7wix<<} per seat.

{++A newly suggested paragraph.++}{>>s:suggest.oztokew7cofb<<}

This is {--really --}{>>s:suggest.kofj33at3kam<<}{~~important~>**important**~~}{>>s:suggest.lelfozq0mw3i<<}.

{>>c:doco.wY-1dDsUeApJ0aHPsiqZFg Test User: Gone soon.<<}

[^1]: A footnote with a {==comment==}{>>c:doco._e6AaL_wIoUwA7KW-htung Test User: In a footnote.<<}.
`);
});

test("comments: all includes resolved threads, none drops them", () => {
  expect(render(doc(), { comments: "all" })).toContain(
    "in {==Q3==}{>>c:doco.pi08HFI3PqJbWPSQmgt23Q resolved · Test User: Is Q3 firm? · Test User: Yes.<<}.",
  );
  const none = render(doc(), { comments: "none" });
  expect(none).toContain("We will ship to all workspaces in Q3.\n");
  expect(none).not.toContain("{>>c:");
});
