// Random docs for property tests: paragraphs, headings, list items and tables, with formatting, suggestions and
// comments where they're most likely to trip up docmd (punctuation and tildes at formatting edges, say).
import type { docs_v1 } from "googleapis";
import { type Block, docOf, type Part } from "./docs.js";

/** A seeded pseudo-random number generator (mulberry32). */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)] as T;
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}

const WORDS = [
  "a",
  "word",
  "n.",
  ".n",
  "x)",
  "(y",
  "colo",
  "ur",
  "中文",
  "~",
  "*",
  "_",
  "-",
  "+",
  "=",
  "}",
  ">",
  "1.",
  "#",
  "|",
  "\\",
  "<",
  "&",
  "`",
];
const STYLES: docs_v1.Schema$TextStyle[] = [
  { bold: true },
  { italic: true },
  { strikethrough: true },
  { bold: true, italic: true },
  { strikethrough: true, bold: true },
  { link: { url: "https://example.com" } },
  { weightedFontFamily: { fontFamily: "Roboto Mono" } },
];
const IDS = ["s1", "s2", "s3"];

/** A random doc of `n` blocks. */
export const randomDoc = (seed: number, n = 4) => docOf(randomBlocks(seed, n));

/** The blocks of a random doc. */
export function randomBlocks(seed: number, n = 4): Block[] {
  const r = random(seed);
  const part = (inCell: boolean): Part => {
    const p: Part = r.chance(0.08)
      ? { element: { dateElement: { dateElementProperties: { timestamp: "2026-12-01T00:00:00Z" } } } }
      : {
          text:
            Array.from({ length: 1 + r.int(2) }, () => r.pick(WORDS)).join(r.chance(0.5) ? " " : "") +
            (r.chance(0.4) ? " " : ""),
        };
    if (r.chance(0.5)) p.style = r.pick(STYLES);
    const s = r.next();
    if (s < 0.2) p.ins = r.pick(IDS);
    else if (s < 0.4) p.del = r.pick(IDS);
    else if (s < 0.45) {
      p.ins = "s1";
      p.del = "s2";
    } else if (s < 0.55) p.restyle = [r.pick(IDS), r.pick(STYLES)];
    if (r.chance(0.1) && !inCell) p.comment = r.pick(["Why?", "a | b", "Fine."]);
    return p;
  };
  const parts = (inCell = false) => Array.from({ length: 1 + r.int(4) }, () => part(inCell));
  const blocks: Block[] = [];
  for (let k = 0; k < n; k++) {
    const kind = r.next();
    if (kind < 0.1) {
      const columns = 1 + r.int(2);
      blocks.push({
        rows: Array.from({ length: 1 + r.int(2) }, () => Array.from({ length: columns }, () => parts(true))),
      });
    } else if (kind < 0.15) {
      // An empty paragraph, as a suggestion if it's new (pressing Enter in suggestion mode).
      blocks.push({ parts: [], ...(r.chance(0.5) ? { end: { ins: r.pick(IDS) } } : {}) });
    } else {
      const b: Block = { parts: parts() };
      if (kind < 0.25) b.heading = 1 + r.int(3);
      else if (kind < 0.5) {
        b.level = r.int(2);
        if (r.chance(0.3)) b.list = "numbered";
      }
      if (r.chance(0.15))
        b.suggested = r.chance(0.5)
          ? { id: r.pick(IDS), heading: r.int(3) }
          : { id: r.pick(IDS), bullet: r.chance(0.3) ? null : { list: r.pick(["list", "numbered"]), level: r.int(2) } };
      // (A paragraph of only inserted text that's joined with the next is empty in the doc as it is, and a new
      // one of only deleted text empty once the suggestions are accepted: Markdown can't show either.)
      const inserted = b.parts.every((p) => p.ins);
      const deleted = b.parts.every((p) => p.del && !p.ins);
      // (Nor a style change on a paragraph whose end is a suggestion; and edits can't split or join list items
      // yet.)
      if (r.chance(0.08) && !(inserted && deleted) && !b.suggested && b.level === undefined)
        b.end = (r.chance(0.5) || inserted) && !deleted ? { ins: r.pick(IDS) } : { del: r.pick(IDS) };
      blocks.push(b);
    }
  }
  // A paragraph before a table ends where it did: Docs can't join one with a table.
  blocks.forEach((b, k) => {
    const next = blocks[k + 1];
    if ("parts" in b && next && !("parts" in next)) delete b.end;
  });
  return blocks;
}
