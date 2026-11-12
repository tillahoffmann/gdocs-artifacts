// What happens to a comment anchor when text at its edges, inside it, or all of it is edited, and when its list
// item changes nesting level.
import { describe, expect, test } from "vitest";
import { accounts, connect, type Doc, findText, firstTab, paragraph, type Request } from "./helpers.js";

/** Text in the first tab's body between two indexes (text runs only). */
function textAt(doc: Doc, start: number, end: number) {
  let out = "";
  for (const el of firstTab(doc).body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const s = pe.startIndex!;
      out += (pe.textRun?.content ?? "").slice(Math.max(0, start - s), Math.max(0, end - s));
    }
  }
  return out;
}

/** The text each range of the doc's only comment covers now; empty if the comment lost its anchor. */
function anchoredText(doc: Doc) {
  expect(doc.comments).toHaveLength(1);
  const comment = doc.comments![0]!;
  expect(comment.status).toBe("OPEN");
  const ranges = firstTab(doc).commentAnchors?.[comment.anchorId!]?.ranges ?? [];
  return ranges.map((r) => textAt(doc, r.startIndex!, r.endIndex!));
}

type Range = { startIndex: number; endIndex: number };
type Mode = "EDIT" | "SUGGEST";

// Text "alpha beta gamma delta", comment on "beta gamma". Expected anchored text after each edit, per mode.
const CASES: [string, (a: Range) => Request[], Record<Mode, string[]>][] = [
  [
    "insert at the anchor's start lands outside it",
    (a) => [{ insertText: { location: { index: a.startIndex }, text: "NEW " } }],
    { EDIT: ["beta gamma"], SUGGEST: ["beta gamma"] },
  ],
  [
    "insert in the middle extends it",
    (a) => [{ insertText: { location: { index: a.startIndex + 4 }, text: "NEW " } }],
    { EDIT: ["betaNEW  gamma"], SUGGEST: ["betaNEW  gamma"] },
  ],
  [
    "insert at the anchor's end lands outside it",
    (a) => [{ insertText: { location: { index: a.endIndex }, text: " NEW" } }],
    { EDIT: ["beta gamma"], SUGGEST: ["beta gamma"] },
  ],
  [
    "deleting all of it unanchors the comment (suggest mode keeps it)",
    (a) => [{ deleteContentRange: { range: a } }],
    { EDIT: [], SUGGEST: ["beta gamma"] },
  ],
  [
    "replacing all of it unanchors the comment (suggest mode keeps it)",
    (a) => [
      { insertText: { location: { index: a.endIndex }, text: "replacement" } },
      { deleteContentRange: { range: a } },
    ],
    { EDIT: [], SUGGEST: ["beta gamma"] },
  ],
];

describe.skipIf(accounts.length === 0).each(accounts)("%s", (account) => {
  for (const mode of ["EDIT", "SUGGEST"] as const) {
    const opts = { mode: mode === "SUGGEST" ? ("SUGGEST" as const) : undefined };

    test.each(CASES)(`${mode}: %s`, async (name, requests, expected) => {
      const { createDoc, getDoc, update } = await connect(account);
      const id = await createDoc(`anchor ${mode} ${name}`);
      await update(id, [{ insertText: { location: { index: 1 }, text: "alpha beta gamma delta\n" } }]);
      const anchor = findText(await getDoc(id), "beta gamma");
      await update(id, [{ insertComment: { content: "on 'beta gamma'", range: anchor } }]);
      await update(id, requests(anchor), opts);
      expect(anchoredText(await getDoc(id))).toEqual(expected[mode]);
    });

    test(`${mode}: changing a list item's nesting level keeps its anchor`, async () => {
      const { createDoc, getDoc, update } = await connect(account);
      const id = await createDoc(`anchor ${mode} list nesting`);
      await update(id, [
        { insertText: { location: { index: 1 }, text: "item one\nitem two\n" } },
        {
          createParagraphBullets: { range: { startIndex: 1, endIndex: 18 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
        },
      ]);
      // The anchor starts exactly at the paragraph start, where the tab goes.
      const anchor = findText(await getDoc(id), "item two");
      await update(id, [{ insertComment: { content: "on 'item two'", range: anchor } }]);

      // Delete bullets on the whole list, insert a tab at the item's start, re-create bullets on the whole list
      // (which consumes the tab). Deleting and re-creating only the moved item leaves it at level 0.
      const list = { startIndex: 1, endIndex: anchor.endIndex + 1 };
      await update(
        id,
        [
          { deleteParagraphBullets: { range: list } },
          { insertText: { location: { index: anchor.startIndex }, text: "\t" } },
          {
            createParagraphBullets: {
              range: { ...list, endIndex: list.endIndex + 1 },
              bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
            },
          },
        ],
        opts,
      );

      const doc = await getDoc(id);
      expect(anchoredText(doc)).toEqual(["item two"]);
      const moved = paragraph(doc, "item two");
      if (mode === "EDIT") {
        expect(moved.bullet?.nestingLevel).toBe(1);
      } else {
        // Suggest mode: the inline view keeps the old level; the new one is in the suggested bullet change.
        expect(moved.bullet?.nestingLevel ?? 0).toBe(0);
        const changes = Object.values(moved.suggestedBulletChanges ?? {});
        expect(changes.map((c) => c.bullet?.nestingLevel)).toEqual([1]);
      }
    });
  }
});
