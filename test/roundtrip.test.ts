// docmd reads back as what it was rendered from: rendered docmd parses to the same atoms, and an edit that leaves
// it as it is plans nothing; and docs that differ only in what docmd doesn't show (whitespace, empty paragraphs,
// how text is split in runs and suggestions) have the same docmd. Checked on shapes that are easy to get wrong,
// and on random docs.
import { describe, expect, test } from "vitest";
import { adopt } from "../src/actions.js";
import { load, parse, renderTab, shownAs } from "../src/docmd.js";
import { planEdit } from "../src/edit.js";
import { type Block, docOf } from "./docs.js";
import type { Doc } from "./helpers.js";
import { docFor, IRRELEVANT, random, randomBlocks, randomDoc } from "./random.js";

/** The doc's docmd, after checking that it reads back as the doc and that leaving it as it is plans nothing. */
function roundTrip(doc: Doc) {
  const { segments } = load(doc);
  const { docmd, opaque, segments: shown } = renderTab(segments);
  const parsed = adopt(
    shown,
    parse(
      docmd,
      segments.slice(1).map((s) => s.id),
    ),
  );
  expect(shownAs(parsed), docmd).toEqual(shownAs(shown));
  const { batch, problems } = planEdit(doc, { edits: [{ old: docmd, new: docmd }] });
  expect({ batch, problems }, docmd).toEqual({ batch: [], problems: [] });
  return { docmd: docmd.replace(/\n\nend\n$/, ""), opaque };
}

const STRIKE = { strikethrough: true };
const CODE = { weightedFontFamily: { fontFamily: "Roboto Mono" } };

describe("each reading of the docmd is the serializer's Markdown of it", () => {
  test.each<[string, Block[], string]>([
    [
      "struck new text, then struck text",
      [
        {
          parts: [
            { text: "old", del: "s1" },
            { text: "new", ins: "s1", style: STRIKE },
            { text: "a", style: STRIKE },
          ],
        },
      ],
      "{~~old~~~>~~new~~}a~~",
    ],
    [
      "struck text, deleted, then struck text",
      [
        {
          parts: [
            { text: "x", del: "s1", style: STRIKE },
            { text: "a", style: STRIKE },
          ],
        },
      ],
      "~~{--x--}a~~",
    ],
    [
      "bold text, inserted, then bold text",
      [
        {
          parts: [
            { text: "x", ins: "s1", style: { bold: true } },
            { text: "a", style: { bold: true } },
          ],
        },
      ],
      "**{++x++}a**",
    ],
    [
      // The new reading writes the x as a character reference, so that the strikethrough closes before it; the x
      // reads the same in both, so it's written so in both.
      "punctuation at the edge of struck new text",
      [{ parts: [{ text: "old", del: "s1" }, { text: "n.", ins: "s1", style: STRIKE }, { text: "x" }] }],
      "{~~old~>~~n.~~~~}&#x78;",
    ],
    [
      // Formatting that's open stays open: the bold goes inside the italic.
      "a word in italic text suggested bold",
      [
        {
          parts: [
            { text: "some ", style: { italic: true } },
            { text: "words", style: { italic: true }, restyle: ["s1", { bold: true }] },
            { text: " here" },
          ],
        },
      ],
      "*some {~~words~>__words__~~}* here",
    ],
    [
      "a struck word, part of it replaced with plain text",
      [
        {
          parts: [
            { text: "colo", style: STRIKE },
            { text: "ur", del: "s1", style: STRIKE },
            { text: "r", ins: "s1" },
          ],
        },
      ],
      "~~colo{~~ur~~~>~~r~~}",
    ],
    [
      "a list item suggested to be a paragraph",
      [
        { parts: [{ text: "a" }], level: 0 },
        { parts: [{ text: "b" }], level: 0, suggested: { id: "s1", bullet: null } },
        { parts: [{ text: "c" }], level: 0 },
      ],
      "- a\n\n{~~- b~>b~~}\n\n- c",
    ],
    [
      "a heading's level suggested",
      [{ parts: [{ text: "Title" }], heading: 2, suggested: { id: "s1", heading: 3 } }],
      "{~~## Title~>### Title~~}",
    ],
    [
      "a new paragraph",
      [
        { parts: [{ text: "Before." }] },
        { parts: [{ text: "New.", ins: "s1" }], end: { ins: "s1" } },
        { parts: [{ text: "After." }] },
      ],
      "Before.\n\n{++New.++}\n\nAfter.",
    ],
    [
      // Docs suggests a new paragraph as an inserted end, then the text, before the old end; it reads as new,
      // end and all, and the old text's end is the old one.
      "a new paragraph as Docs writes it",
      [{ parts: [{ text: "Before." }], end: { ins: "s1" } }, { parts: [{ text: "New.", ins: "s1" }] }],
      "Before.\n\n{++New.++}",
    ],
    [
      "a new paragraph under a heading whose level is suggested, as Docs writes it",
      [
        { parts: [{ text: "Section" }], heading: 3, end: { ins: "s1" } },
        { parts: [{ text: "New.", ins: "s1" }], heading: 2, suggested: { id: "s2", heading: 0 } },
      ],
      "{~~## Section~>### Section~~}\n\n{++New.++}",
    ],
    [
      "a new list item as Docs writes it",
      [
        { parts: [{ text: "two" }], level: 0, end: { ins: "s1" } },
        { parts: [{ text: "three", ins: "s1" }], level: 0 },
      ],
      "- two\n{++- three++}",
    ],
    [
      "a deleted list item",
      [
        { parts: [{ text: "a" }], level: 0 },
        { parts: [{ text: "b", del: "s1" }], level: 0, end: { del: "s1" } },
        { parts: [{ text: "c" }], level: 0 },
      ],
      "- a\n{--- b--}\n- c",
    ],
    [
      "a paragraph split",
      [{ parts: [{ text: "one" }], end: { ins: "s1" } }, { parts: [{ text: "two" }] }],
      "one{++\n\n++}two",
    ],
    [
      // CriticMarkup isn't read in code: a change in code is of the whole code span.
      "a suggestion in code",
      [{ parts: [{ text: "a" }, { text: "b", ins: "s1" }, { text: "c" }].map((p) => ({ ...p, style: CODE })) }],
      "{~~`ac`~>`abc`~~}",
    ],
    [
      // Nor is a comment's highlight: it's of the whole code span.
      "a comment on part of a code span",
      [
        {
          parts: [
            { text: "ab", comment: "Why?" },
            { text: "c", ins: "s1" },
          ].map((p) => ({ ...p, style: CODE })),
        },
      ],
      "{=={~~`ab`~>`abc`~~}==}{>>@Ann: Why?<<}",
    ],
  ])("%s", (_, blocks, expected) => {
    expect(roundTrip(docOf(blocks)).docmd).toBe(expected);
  });

  test("a paragraph docmd can't show is a token, with its comments, that edits keep", () => {
    // A heading whose text and heading are both suggested away: once accepted, it's an empty paragraph, which
    // Markdown can't show.
    const { docmd, opaque } = roundTrip(
      docOf([{ parts: [{ text: "ab", del: "s1", comment: "Why?" }], heading: 2, suggested: { id: "s1", heading: 0 } }]),
    );
    expect(docmd).toBe("## {{opaque:paragraph:ab}}{>>@Ann: Why?<<}");
    expect(opaque).toHaveLength(1);
  });
});

test("a suggestion says who made it, once for changes next to each other by the same people", () => {
  const doc = docOf([
    {
      parts: [
        { text: "a" },
        { text: "b", ins: "s1" },
        { text: "c", del: "s2" },
        { text: " d" },
        { text: "e", ins: "s3" },
        { text: "f", del: "s1" },
        { text: " g", restyle: ["s2", { bold: true }] },
      ],
    },
  ]);
  const by = (suggestionId: string, displayName: string) => ({ suggestionId, headPost: { author: { displayName } } });
  doc.suggestions = [by("s1", "Ann Kim"), by("s2", "Ann Kim"), by("s3", "Bob: B; Lee")];
  expect(roundTrip(doc).docmd).toBe(
    "a{++b++}{--c--}{>>@Ann Kim<<} d{++e++}{>>@Bob\\: B\\; Lee<<}{--f--}{>>@Ann Kim<<} {~~g~>**g**~~}{>>@Ann Kim<<}",
  );
});

test("random docs read back as themselves", () => {
  let paragraphs = 0;
  let opaque = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const doc = randomDoc(seed, 6);
    paragraphs += load(doc).segments[0]?.atoms.filter((a) => a.kind === "end").length ?? 0;
    opaque += roundTrip(doc).opaque.length;
  }
  // The random docs have far more suggestions in code than docs do; still, few paragraphs are tokens.
  expect(opaque / paragraphs).toBeLessThan(0.02);
});

test("docs that differ only in what docmd doesn't show have the same docmd", () => {
  const docmd = (doc: Doc) => renderTab(load(doc).segments).docmd;
  for (let seed = 1; seed <= 300; seed++) {
    const blocks = randomBlocks(seed, 6);
    const expected = docmd(docFor(blocks, seed));
    for (const [change, apply] of Object.entries(IRRELEVANT)) {
      const changed = structuredClone(blocks);
      if (apply(changed, random(seed * 31 + change.length)))
        expect(docmd(docFor(changed, seed)), `${change}, seed ${seed}`).toBe(expected);
    }
  }
});
