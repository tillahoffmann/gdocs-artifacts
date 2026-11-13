// What an edit does besides changing text, read from the edited docmd: pending suggestions whose markup it
// removes are accepted or rejected (whichever the text says), {==text==}{>>comment<<} is a new comment, and a
// comment after a thread's last is a reply. (Resolved threads are read off the docmd text; see edit.ts.)
import { diffArrays } from "diff";
import type { docs_v1 } from "googleapis";
import { type Atom, asShown, type Choice, isFresh, resolved, type Segment, suggestions } from "./ir.js";
import type { Problem } from "./plan.js";
import { MARKS, unescapeField } from "./rules.js";

/** What distinguishes atoms when the edited docmd is compared with a resolved doc. */
const key = (a: Atom) => {
  const id = (s?: string) => (s === undefined ? "" : isFresh(s) ? "+" : s);
  const block = (p?: Atom["props"]) => p && [p.heading, p.list?.level, p.list?.ordered];
  const props = a.props && [block(a.props), block(a.reprops)];
  return [
    a.kind,
    a.key,
    MARKS.map((m) => a.marks[m.name] ?? "").join("\u0002"),
    JSON.stringify(props ?? null),
    id(a.ins),
    id(a.del),
    a.styleChanges.map(id).join(" "),
  ].join("\u0001");
};

/** How many atoms differ between the doc's segments and the edited ones. */
function distance(segments: Segment[], next: Segment[]) {
  let total = 0;
  for (const s of segments) {
    const edited = next.find((n) => n.id === s.id);
    if (!edited) continue;
    const changes = diffArrays(s.atoms.filter((a) => !a.hidden).map(key), edited.atoms.map(key));
    for (const c of changes) if (c.added || c.removed) total += c.count ?? c.value.length;
  }
  return total;
}

/**
 * The pending suggestions the edited docmd leaves out (their markup gone): each is accepted or
 * rejected, whichever makes the doc read closer to the edit. The rest of the edit is then planned against the
 * doc with these resolved.
 */
export function decide(
  segments: Segment[],
  next: Segment[],
  name: (id: string) => string,
): { choices: Map<string, Choice>; problems: Problem[] } {
  // A suggestion the docmd doesn't show (such as a new empty paragraph's) can't be left out of it: it stays.
  const shown = segments.flatMap((s) => s.atoms).filter((a) => !a.hidden);
  const kept = suggestions(next.flatMap((s) => s.atoms));
  const gone = [...suggestions(shown)].filter((id) => !kept.has(id));
  const problems: Problem[] = [];
  const choices = new Map<string, Choice>(gone.map((id) => [id, "accept"]));
  for (const id of choices.keys()) {
    const touched = segments.filter((s) => suggestions(s.atoms).has(id));
    const cost = (c: Choice) => distance(resolved(touched, new Map(choices).set(id, c)), next);
    const accept = cost("accept");
    const reject = cost("reject");
    if (accept === reject) problems.push({ code: "anchors_affected", message: ambiguous(name(id)) });
    else choices.set(id, accept < reject ? "accept" : "reject");
  }
  return { choices, problems };
}

const ambiguous = (name: string) =>
  `the pending suggestion "${name}": the edit reads neither as it accepted nor as it rejected. To accept it, ` +
  "write its new text without the markup; to reject it, its old text. Otherwise keep it as it is.";

/**
 * The doc's pending suggestions in the edited docmd: where its atoms are the doc's, in order, with a suggestion
 * of the same kind on them, they're the doc's suggestion (docmd doesn't show suggestion IDs). A change that's
 * partly one is all that one, edited. Other suggestions are new.
 */
export function adopt(segments: Segment[], next: Segment[]): Segment[] {
  const shape = (a: Atom) => [a.kind, a.key, !!a.ins, !!a.del, a.styleChanges.length > 0].join("\u0001");
  return next.map((edited) => {
    const doc = segments.find((s) => s.id === edited.id)?.atoms.filter((a) => !a.hidden) ?? [];
    const atoms = edited.atoms.map((a) => ({ ...a }));
    /** The doc's suggestion each new one is, where it's partly one. */
    const found = new Map<string, string>();
    let i = 0;
    let j = 0;
    for (const c of diffArrays(doc.map(shape), atoms.map(shape))) {
      const count = c.count ?? c.value.length;
      if (!c.added && !c.removed)
        for (let k = 0; k < count; k++) {
          const d = doc[i + k] as Atom;
          const a = atoms[j + k] as Atom;
          for (const field of ["ins", "del"] as const) {
            const id = a[field];
            const theirs = d[field];
            if (id && theirs) {
              if (isFresh(id)) found.set(id, theirs);
              a[field] = theirs;
            }
          }
          const id = a.styleChanges[0];
          if (id && d.styleChanges.length) {
            if (isFresh(id)) found.set(id, d.styleChanges.join(" "));
            a.styleChanges = d.styleChanges;
          }
        }
      if (!c.added) i += count;
      if (!c.removed) j += count;
    }
    for (const a of atoms) {
      for (const field of ["ins", "del"] as const) {
        const id = a[field];
        if (id && found.has(id)) a[field] = found.get(id);
      }
      const id = a.styleChanges[0];
      if (id && found.has(id)) a.styleChanges = (found.get(id) ?? "").split(" ");
    }
    return { ...edited, atoms };
  });
}

/** A comment the edit adds: what it says and the atoms it's on, in one segment of the edited docmd. */
export type NewComment = { content: string; segment: string; on: Atom[] };
/** A reply the edit adds to a thread. */
export type Reply = { thread: string; content: string };

const isPost = (a?: Atom) => a?.kind === "annotation" && !a.thread && a.key.startsWith("{>>");

/**
 * The posts the edited docmd adds, as CriticMarkup comments without an ID: right after a thread, a reply to
 * it; right after {==text==}, a new comment on that text. Returns them, and the docmd without them, as the
 * rest of the edit is planned.
 */
export function newPosts(next: Segment[]) {
  const comments: NewComment[] = [];
  const replies: Reply[] = [];
  const problems: Problem[] = [];
  const problem = (message: string) => {
    problems.push({ code: "comments_read_only", message });
  };
  const out = next.map(({ id, atoms }) => {
    const drop = new Set<number>();
    for (const [k, a] of atoms.entries()) {
      if (!isPost(a)) continue;
      const content = unescapeField(a.key.slice(3, -3)).trim();
      if (!content) {
        problem("a new comment or reply {>><<} is empty.");
        continue;
      }
      if (Buffer.byteLength(content) > 2048) {
        problem("a comment or reply can be at most 2048 bytes long.");
        continue;
      }
      // Earlier posts in a row go to the same thread.
      let p = k - 1;
      while (isPost(atoms[p])) p--;
      const before = atoms[p];
      if (before?.kind === "annotation" && before.thread) {
        replies.push({ thread: before.thread, content });
        drop.add(k);
        continue;
      }
      if (p !== k - 1) {
        problem(REPLY_TO_NEW);
        continue;
      }
      let q = k - 2;
      while (q >= 0 && !ofKind(atoms[q], "end", "boundary") && !/^(\{==|==\})$/.test(atoms[q]?.key ?? "")) q--;
      const on = atoms.slice(q + 1, k - 1);
      if (before?.key !== "==}" || atoms[q]?.key !== "{==" || !on.some((x) => /\S/u.test(x.key))) {
        problem(NEW_COMMENT);
        continue;
      }
      comments.push({ content, segment: id, on });
      for (const d of [q, k - 1, k]) drop.add(d);
    }
    return { id, atoms: atoms.filter((_, k) => !drop.has(k)) };
  });
  return { next: out, comments, replies, problems };
}

const ofKind = (a: Atom | undefined, ...kinds: Atom["kind"][]) => !!a && kinds.includes(a.kind);

const NEW_COMMENT =
  "a new comment goes right after the text it's on, highlighted within one paragraph: {==text==}{>>comment<<} " +
  "(the text can't hold the {== or ==} of another thread); a reply goes after its thread's last comment.";

const REPLY_TO_NEW = "a reply to a new comment can't be added in the same edit; add it once the comment exists.";

/**
 * Where the new comments go in the doc as written: the edited docmd's atoms (without the comments) are matched
 * with the doc's in order. Returns the insertComment requests, and the comments that couldn't be placed.
 */
export function placeComments(next: Segment[], written: Segment[], comments: NewComment[], tabId?: string) {
  const requests: docs_v1.Schema$Request[] = [];
  const unplaced: NewComment[] = [];
  for (const segment of new Set(comments.map((c) => c.segment))) {
    const edited = next.find((s) => s.id === segment);
    const doc = written.find((s) => s.id === segment);
    if (!edited || !doc) {
      unplaced.push(...comments.filter((c) => c.segment === segment));
      continue;
    }
    // asShown keeps the atoms in order, so positions in it are positions in `edited`.
    const shown = (asShown([edited])[0]?.atoms ?? []).flatMap((a, k) => (a.hidden ? [] : [{ a, k }]));
    const visible = doc.atoms.filter((a) => !a.hidden);
    const match = (a: Atom) => `${a.kind}${a.key}`;
    /** The doc's atom for each shown atom of `edited`, by position. */
    const placed = new Map<number, Atom>();
    let i = 0;
    let j = 0;
    for (const c of diffArrays(
      shown.map(({ a }) => match(a)),
      visible.map(match),
    )) {
      const count = c.count ?? c.value.length;
      if (!c.added && !c.removed)
        for (let m = 0; m < count; m++) placed.set(shown[i + m]?.k ?? -1, visible[j + m] as Atom);
      if (!c.added) i += count;
      if (!c.removed) j += count;
    }
    const isShown = new Set(shown.map(({ k }) => k));
    for (const c of comments.filter((x) => x.segment === segment)) {
      const ks = c.on
        .map((a) => edited.atoms.indexOf(a))
        .filter((k) => isShown.has(k) && edited.atoms[k]?.kind !== "annotation");
      const on = ks.map((k) => placed.get(k));
      const first = on[0];
      const last = on.at(-1);
      if (!first || !last || on.some((a) => !a)) {
        unplaced.push(c);
        continue;
      }
      const range = {
        startIndex: first.index,
        endIndex: (last.index ?? 0) + (last.size ?? 0),
        ...(segment ? { segmentId: segment } : {}),
        ...(tabId ? { tabId } : {}),
      };
      requests.push({ insertComment: { content: c.content, range } });
    }
  }
  return { requests, unplaced };
}
