// docmd reads CriticMarkup as its spec defines it (https://github.com/CriticMarkup/CriticMarkup-toolkit): a layer
// over the text. Accepting or rejecting every change in what docmd parses must read, as Markdown, the same as
// accepting or rejecting it in the text, as the reference implementation does (the patterns of the toolkit's
// CLI/criticParser_CLI.py). Fixtures are from MultiMarkdown 6's tests (MIT;
// https://github.com/fletcher/MultiMarkdown-6/tree/master/tests), the spec's examples, and docmd's own block
// changes.
import { micromark } from "micromark";
import { gfmStrikethrough, gfmStrikethroughHtml } from "micromark-extension-gfm-strikethrough";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";
import { describe, expect, test } from "vitest";
import { parse, toDocmd } from "../src/docmd.js";
import { asShown, resolved, suggestions } from "../src/ir.js";

type Side = "accept" | "reject";

/** The reference implementation's text substitution: comments go, highlights keep their text. */
function reference(src: string, side: Side) {
  return src
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1")
    .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, (_, a, b) => (side === "accept" ? b : a))
    .replace(/\{\+\+([\s\S]*?)\+\+\}/g, (_, a) => (side === "accept" ? a : ""))
    .replace(/\{--([\s\S]*?)--\}/g, (_, a) => (side === "accept" ? "" : a));
}

/** What docmd parses, with every change accepted or rejected, without comments, as docmd. */
function ours(src: string, side: Side) {
  const segments = parse(src);
  const ids = suggestions(segments.flatMap((s) => s.atoms));
  const choice = side === "accept" ? "accept" : "reject";
  const all = resolved(segments, new Map([...ids].map((id) => [id, choice] as const)));
  return toDocmd(asShown(all.map((s) => ({ ...s, atoms: s.atoms.filter((a) => a.kind !== "annotation") }))));
}

/** HTML, without the paragraphs of a loose list (Docs has no loose lists), and with a run of spaces as one
 * (docmd shows one). */
const html = (markdown: string) =>
  micromark(markdown, {
    extensions: [gfmStrikethrough({ singleTilde: false }), gfmTable()],
    htmlExtensions: [gfmStrikethroughHtml(), gfmTableHtml()],
  })
    .replace(/<li>\n<p>([\s\S]*?)<\/p>\n<\/li>/g, "<li>$1</li>")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const reads = (src: string) => {
  for (const side of ["accept", "reject"] as const)
    expect(html(ours(src, side)), side).toBe(html(reference(src, side)));
};

describe("MultiMarkdown 6: tests/CriticMarkup", () => {
  test.each([
    "This is a *single* paragraph {++\n\n++}that was split in two.\n",
    "This is *two* paragraphs {--\n\n--}joined together.\n",
    "This is two paragraphs{~~\n\nwith nothing ~>\n\nWith a *new* paragraph inserted\n\n~~}between them.\n",
    "{++foo++}\n\n{--bar--}\n\n{~~foo~>bar~~}\n\n{>>foo<<}\n\n{==bar==}\n",
  ])("%j", reads);
});

describe("MultiMarkdown 6: tests/MMD6Tests/CriticMarkup", () => {
  test.each([
    "foo{++ bar++}",
    "foo{-- bar--}",
    "foo {~~foo~>bar~~}",
    "foo {>>bar<<}",
    "foo {==bar==}",
    "foo{++ **bar**++}",
    "foo{-- **bar**--}",
    "foo {~~**bar**~>**bar**~~}",
    "foo {>>**bar**<<}",
    "foo {==**bar**==}",
    "foo **{~~foo~>bar~~}**",
    "foo **{>>bar<<}**",
    "foo **{==bar==}**",
  ])("%j", reads);

  // Rejecting the insertion (or accepting the deletion) leaves "foo ****" or "foo **" in the text: the markers
  // of emphasis the change emptied. As MultiMarkdown reads the first, it's bold text inserted or deleted.
  test.each(["foo **{++bar++}**", "foo **{--bar--}**", "foo **{++bar**++}", "foo **{--bar**--}"])("%j", (src) => {
    const [kept, gone] = src.includes("++") ? (["accept", "reject"] as const) : (["reject", "accept"] as const);
    expect(html(ours(src, kept))).toBe(html("foo **bar**"));
    expect(html(ours(src, gone))).toBe(html("foo"));
  });

  // As in MultiMarkdown, CriticMarkup isn't read in code (the reference implementation doesn't know code).
  test.each(["`{++foo++}`", "`{--bar--}`", "`{~~foo~>bar~~}`", "`{>>foo<<}`", "`{==bar==}`"])("%j", (src) => {
    for (const side of ["accept", "reject"] as const) expect(html(ours(src, side))).toBe(html(src));
  });

  // Changes don't nest in changes (the reference implementation's patterns don't either); docmd refuses them
  // rather than guess. (A deletion of suggested text, in an insertion, is how the doc can hold both.)
  test.each(["{++foo{++ bar++}++}", "{--foo{-- bar--}--}"])("%j", (src) => {
    expect(() => parse(src)).toThrow();
  });
});

describe("the spec's examples", () => {
  test.each([
    "Lorem ipsum dolor{++ sit++} amet, consectetur adipiscing elit.",
    "Lorem{-- ipsum--} dolor sit amet.",
    "Lorem {~~hipster~>ipsum~~} dolor sit amet.",
    "Lorem ipsum dolor sit amet.{>>This is a comment<<}",
    "Lorem ipsum dolor sit amet, {==consectetur adipiscing==}{>>is this right?<<} elit.",
  ])("%j", reads);
});

describe("block changes, written as changes of the block's Markdown", () => {
  test.each([
    "{~~## Section~>### Section~~}\n",
    "{++## ++}Section\n",
    "{--## --}Section\n",
    "## {~~Section~>Part~~}\n",
    "- a\n\n{~~- b~>b~~}\n\n- c\n",
    "Text\n\n{~~Item~>- Item~~}\n",
    "{++New paragraph.++}\n\nNext.\n",
    "Before.\n\n{--Gone.--}\n\nAfter.\n",
    "a {~~b~>**b**~~} c\n",
    "**a{--b--}** c\n",
    "**x {++y++} z**\n",
    "x {++new++}{>>s:abc<<} y {--old--}{>>s:def<<} z\n",
    // Strikethrough right next to a substitution's tildes: each reading is Markdown without them.
    "{~~~~a~~~>b~~}\n",
    "{~~a~>~~b~~~~}\n",
    // A code span is within a paragraph: a lone backtick doesn't make the next paragraph's markup code.
    "Press the ` key.\n\nWe {--really --}mean it, `ls`.\n",
  ])("%j", reads);

  test.each(["{~~~~a~~~>b~~}\n", "{~~a~>~~b~~~~}\n"])("%j is written as read", (src) => {
    expect(toDocmd(parse(src))).toBe(src);
  });

  test("text a change leaves at a paragraph's edge is the doc's", () => {
    reads("Section {++x++}\n");
  });
});
