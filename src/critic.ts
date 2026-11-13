// CriticMarkup as its spec defines it: a layer over the source text. Accepting every change keeps the new text,
// rejecting every change the old, and each result reads as Markdown. Here the docmd source is scanned for
// CriticMarkup, and projected to its accepted and rejected text, with each character's place in the source, so
// that the two Markdown readings can be put together again (see docmd.ts).

/** Markdown that docmd can't represent, or markup that edits can't create; where it is in the source, if known. */
export class Unsupported extends Error {
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message);
  }
}

/** A change: an insertion, a deletion or a substitution, with where its old and new text are in the source. */
export type Change = {
  kind: "{++" | "{--" | "{~~";
  /** The whole change, from its opening to its closing markup. */
  start: number;
  end: number;
  old?: [number, number];
  new?: [number, number];
  /** The change this one is in: a deletion in an insertion (someone suggests deleting suggested text). */
  parent?: Change;
};

/** Comment markup: highlight markers and comments, which take no text in either projection; or the placeholder
 * of a thread. */
export type Note = { at: number; value: string; thread?: string };

export type Scan = { changes: Change[]; notes: Note[] };

const CLOSE = { "{++": "++}", "{--": "--}", "{~~": "~~}" } as const;

/** The end of the `{>>…<<}` or `{{…}}` at `at`: its fields escape every `}` of their own, so the first
 * unescaped `}` belongs to its close. */
function enclosed(src: string, at: number, open: string, close: string) {
  for (let i = at + open.length; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "}") {
      const k = close.indexOf("}");
      return src.startsWith(close, i - k) ? i - k + close.length : -1;
    }
  }
  return -1;
}

/** The changes and comment markup in the source. As in MultiMarkdown, CriticMarkup isn't read in code spans. */
export function scan(src: string): Scan {
  const changes: Change[] = [];
  const notes: Note[] = [];
  const open: Change[] = [];
  for (let i = 0; i < src.length; ) {
    const at = (s: string) => src.startsWith(s, i);
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      let n = 0;
      while (src[i + n] === "`") n++;
      // A code span is within a paragraph: its closing backticks are before the next blank line.
      const fence = "`".repeat(n);
      const blank = /\n[ \t]*\n/g;
      blank.lastIndex = i + n;
      const limit = blank.exec(src)?.index ?? src.length;
      let j = src.indexOf(fence, i + n);
      while (j >= 0 && src[j + n] === "`") {
        let m = j;
        while (src[m] === "`") m++;
        j = src.indexOf(fence, m);
      }
      i = j < 0 || j >= limit ? i + n : j + n;
      continue;
    }
    if (at("{{")) {
      const end = enclosed(src, i, "{{", "}}");
      i = end < 0 ? i + 2 : end;
      continue;
    }
    if (at("{>>")) {
      const end = enclosed(src, i, "{>>", "<<}");
      if (end < 0) throw new Unsupported("{>> isn't closed with <<}.", i);
      notes.push({ at: i, value: src.slice(i, end) });
      i = end;
      continue;
    }
    // A thread's placeholder, where edits are matched (see edit.ts).
    if (src[i] === "\uE000") {
      const end = src.indexOf("\uE001", i);
      if (end > 0) {
        notes.push({ at: i, value: src.slice(i, end + 1), thread: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    const top = open.at(-1);
    const kind = (["{++", "{--", "{~~"] as const).find(at);
    if (kind) {
      const inserting = top && (top.kind === "{++" || top.new);
      if (top && !(kind === "{--" && inserting && open.length === 1))
        throw new Unsupported(
          `${kind} inside ${top.kind}: suggestions don't nest, so a new one can't hold a pending one. Suggest ` +
            "changes to the text around pending suggestions, or ask for them to be accepted or rejected first.",
          i,
        );
      const change: Change = { kind, start: i, end: -1, ...(top ? { parent: top } : {}) };
      if (kind === "{++") change.new = [i + 3, -1];
      else change.old = [i + 3, -1];
      open.push(change);
      changes.push(change);
      i += 3;
      continue;
    }
    if (at("~>") && top?.kind === "{~~" && !top.new) {
      if (top.old) top.old[1] = i;
      top.new = [i + 2, -1];
      i += 2;
      continue;
    }
    if (top && at(CLOSE[top.kind]) && (top.kind !== "{~~" || top.new)) {
      const range = top.kind === "{--" ? top.old : top.new;
      if (range) range[1] = i;
      top.end = i + 3;
      open.pop();
      i += 3;
      continue;
    }
    const stray = ["++}", "--}", "~~}", "~>"].find(at);
    if (stray) throw new Unsupported(`${stray} is out of place.`, i);
    if (at("{==") || at("==}")) {
      notes.push({ at: i, value: src.slice(i, i + 3) });
      i += 3;
      continue;
    }
    i++;
  }
  const unclosed = open.at(-1);
  if (unclosed) throw new Unsupported(`${unclosed.kind} isn't closed with ${CLOSE[unclosed.kind]}.`, unclosed.start);
  return { changes, notes };
}

/** One projection of the source: its text, and for each of its characters (and its end) the source index. */
export type Projection = { text: string; source: number[] };

/** The source with every change accepted or rejected, and without comment markup. A deletion in an insertion
 * stays in the accepted text: it's in the doc until someone accepts it. */
export function project(src: string, { changes, notes }: Scan, side: "accept" | "reject"): Projection {
  const drop = new Uint8Array(src.length);
  const cut = (from: number, to: number) => drop.fill(1, from, to);
  for (const c of changes) {
    // The markup itself.
    const [first, second] = c.kind === "{++" ? [c.new, undefined] : [c.old, c.new];
    cut(c.start, (first ?? [c.start + 3])[0]);
    if (second) cut((first ?? [0, 0])[1], second[0]);
    cut((second ?? first ?? [0, c.end])[1], c.end);
    if (c.parent) continue;
    const gone = side === "accept" ? c.old : c.new;
    if (gone) cut(gone[0], gone[1]);
  }
  for (const n of notes) cut(n.at, n.at + n.value.length);
  let text = "";
  const source: number[] = [];
  for (let i = 0; i < src.length; i++)
    if (!drop[i]) {
      text += src[i];
      source.push(i);
    }
  source.push(src.length);
  return { text, source };
}

/** The innermost change whose old (or new) text holds source index `i`. */
export function changeAt(changes: Change[], i: number, part: "old" | "new"): Change | undefined {
  let found: Change | undefined;
  for (const c of changes) {
    const r = c[part];
    if (r && i >= r[0] && i < r[1] && (!found || c.start > found.start)) found = c;
  }
  return found;
}
