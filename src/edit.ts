// The edit and create_doc tools. An edit replaces text in a tab's docmd; the planner turns the edited docmd
// into batchUpdate requests, which are written as suggestions (or directly) and checked by reading back.
import { diffLines } from "diff";
import type { docs_v1 } from "googleapis";
import { adopt, decide, type NewComment, newPosts, placeComments } from "./actions.js";
import { comparable, load, type Opaque, parse, renderTab, toDocmd, Unsupported } from "./docmd.js";
import { ToolError } from "./errors.js";
import type { clients } from "./google.js";
import {
  type Atom,
  asShown,
  isThread,
  paragraphs,
  posts,
  reblocks,
  resolved,
  type Segment,
  shifts,
  threadKey,
} from "./ir.js";
import { plan } from "./plan.js";
import { raw } from "./rules.js";

type Api = ReturnType<typeof clients>;
type Doc = docs_v1.Schema$Document;

export type Edit = { old: string; new: string; nth?: number };

/** A comment, as docmd shows a thread's posts. */
const POST = /\{>>(?:\\.|[^\\\n])*?<<\}/y;

/** The comments right after `at` in `s`. */
function postsAt(s: string, at: number) {
  const posts: string[] = [];
  POST.lastIndex = at;
  for (let m = POST.exec(s); m; m = POST.exec(s)) posts.push(m[0]);
  return posts;
}

/** Each thread's comments as docmd shows them (in a table cell, too), by thread ID. */
export type Threads = Map<string, string[]>;

export function threadsOf(segments: Segment[]): Threads {
  const out: Threads = new Map();
  for (const a of segments.flatMap((s) => s.atoms)) if (a.thread && isThread(a)) out.set(a.thread, posts(a));
  return out;
}

/**
 * `s` with each run of a thread's comments (from its first, as far as they're its comments) replaced by the
 * thread's placeholder, which the parser reads as the thread. Comments after them in the run stay: replies.
 * With `whole`, the run must have all of the thread's comments: `s` is the doc's docmd, edited.
 */
function placeholders(s: string, threads: Threads, whole = false) {
  const is = (post: string | undefined, ours: string | undefined) =>
    post !== undefined && ours !== undefined && (post === ours || post === ours.replace(/\|/g, "\\|"));
  let out = "";
  let i = 0;
  // Threads that say the same are told apart by their order, which is the doc's.
  const used = new Set<string>();
  while (i < s.length) {
    const at = s.indexOf("{>>", i);
    if (at < 0) break;
    const posts = postsAt(s, at);
    if (!posts.length) {
      out += s.slice(i, at + 3);
      i = at + 3;
      continue;
    }
    // The thread whose comments start the run (the most of them), then any others whose comments all follow it
    // (threads that end at the same place); comments after them are replies.
    let rest = posts;
    let replaced = "";
    for (let first = true; rest.length; first = false) {
      let best: [string, number] | undefined;
      for (const [id, ours] of threads) {
        if (!first && used.has(id)) continue;
        let n = 0;
        while (n < rest.length && n < ours.length && is(rest[n], ours[n])) n++;
        if (!first && n < ours.length) continue;
        if (n && (!best || n > best[1] || (n === best[1] && used.has(best[0]) && !used.has(id)))) best = [id, n];
      }
      if (!best) break;
      used.add(best[0]);
      if (whole && best[1] < (threads.get(best[0])?.length ?? 0))
        throw new ToolError(
          "comments_read_only",
          "the edits change what a comment thread says, which can't be changed. To reply, add {>>your reply<<} " +
            "after its last comment; to resolve it, remove its highlight and comments.",
        );
      replaced += threadKey(best[0]);
      rest = rest.slice(best[1]);
    }
    const run = posts.join("").length;
    out += s.slice(i, at) + replaced + rest.join("");
    i = at + run;
  }
  return out + s.slice(i);
}

/** Applies the edits in order, each to the result of the ones before. Returns the edited docmd with each
 * thread's comments as its placeholder; comments added after them are replies (see actions.ts). */
export function applyEdits(docmd: string, edits: Edit[], threads: Threads = new Map()): string {
  const text = edits.reduce((text, e, k) => {
    const label = `edit ${k + 1}`;
    if (!e.old) throw new ToolError("anchor_not_found", `${label}: old is empty; include the text next to the change.`);
    // A match can't end within a thread's comments: old from before a reply would leave it out.
    const all = (t: string, old: string) => {
      const found: number[] = [];
      for (let at = t.indexOf(old); at >= 0; at = t.indexOf(old, at + 1))
        if (!old.endsWith("<<}") || !postsAt(t, at + old.length).length) found.push(at);
      return found;
    };
    // Old as read shows the doc now, or from before someone replied to a thread in it: then threads compare by
    // their placeholders.
    let [t, old, next] = [text, e.old, e.new];
    let found = all(t, old);
    if (!found.length) {
      [t, old, next] = [placeholders(text, threads), placeholders(e.old, threads), placeholders(e.new, threads)];
      found = all(t, old);
    }
    if (!found.length || (e.nth && found[e.nth - 1] === undefined))
      throw new ToolError(
        "anchor_not_found",
        `${label}: old doesn't match the tab's docmd${found.length ? ` ${e.nth} times` : ""}. Copy it exactly ` +
          "from read with its default comments (open threads shown inline).",
      );
    if (found.length > 1 && !e.nth)
      throw new ToolError(
        "anchor_ambiguous",
        `${label}: old matches ${found.length} times; add surrounding text, or pass nth (1 to ${found.length}).`,
      );
    const at = found[(e.nth ?? 1) - 1] ?? 0;
    return t.slice(0, at) + next + t.slice(at + old.length);
  }, docmd);
  return placeholders(text, threads, true);
}

/**
 * The parsed segments with each paragraph that docmd showed as {{opaque:paragraph:…}} as the doc has it. It can be
 * kept or removed whole, with its comments, but not changed.
 */
function expandOpaque(segments: Segment[], opaque: Opaque[]): Segment[] {
  if (!segments.some((s) => s.atoms.some((a) => a.key.startsWith("{{opaque:paragraph:")))) return segments;
  const used = new Set<Opaque>();
  const refuse = (key: string) =>
    new ToolError(
      "unsupported_edit",
      `${key} stands for a paragraph that docmd can't show (with its formatting and suggestions); edits can keep it ` +
        "or remove it, with its comments, but not change it.",
    );
  return segments.map(({ id, atoms }) => {
    const out: Atom[] = [];
    for (const { content, end: a } of paragraphs(atoms)) {
      const paragraph = [...content, ...(a ? [a] : [])];
      const token = content.find((x) => x.key.startsWith("{{opaque:paragraph:"));
      if (!token) {
        out.push(...paragraph);
        continue;
      }
      const o = opaque.find((x) => x.key === token.key && !used.has(x));
      if (!o) throw refuse(token.key);
      used.add(o);
      const threads = (as: Atom[]) => as.flatMap((x) => (x.kind === "annotation" ? [x.key] : []));
      const theirs = o.atoms.filter(isThread);
      const end = o.atoms.at(-1);
      const same =
        paragraph.filter((x) => x.kind !== "annotation").length === 2 &&
        paragraph[0] === token &&
        threads(paragraph).join() === threads(theirs).join() &&
        a?.kind === "end" &&
        end?.kind === "end" &&
        !reblocks(a.props, end.props);
      if (!same) throw refuse(token.key);
      // (In the list the parser read it in.)
      const list = a.props?.list;
      out.push(
        ...o.atoms.map((x) =>
          x === end && x.props?.list && list
            ? { ...x, props: { ...x.props, list: { ...x.props.list, id: list.id } } }
            : { ...x },
        ),
      );
    }
    return { id, atoms: out };
  });
}

function parsed(markdown: string, footnotes: string[] = []) {
  try {
    return parse(markdown, footnotes);
  } catch (e) {
    if (e instanceof Unsupported) throw new ToolError("unsupported_edit", e.message);
    throw e;
  }
}

/** The changed lines between two docmd versions. */
function changes(before: string, after: string) {
  return diffLines(before, after)
    .flatMap((c) =>
      c.added || c.removed
        ? c.value
            .split("\n")
            .filter(Boolean)
            .map((line) => `${c.added ? "+" : "-"} ${line}`)
        : [],
    )
    .join("\n");
}

const isConflict = (e: unknown) => /does not match the latest revision/.test((e as Error).message ?? "");

export type EditOptions = { tab?: string; mode?: "suggest" | "direct"; edits: Edit[]; allowDetach?: boolean };

/** Plans the edits on the doc: the requests of one batchUpdate, then the comments to add once it's written. */
export function planEdit(doc: Doc, opts: EditOptions) {
  const suggest = opts.mode !== "direct";
  // Edits apply to docmd as read shows it by default, with open threads inline.
  const { segments, threads: anchoredThreads } = load(doc, { tabId: opts.tab });
  const { docmd, opaque } = renderTab(segments);
  const known = threadsOf(segments);
  const target = applyEdits(docmd, opts.edits, known);
  // Suggestions in the edited docmd that are where the doc's pending ones are, as they are, are those.
  const {
    next,
    comments,
    replies,
    problems: commentProblems,
  } = newPosts(
    adopt(
      segments,
      expandOpaque(
        parsed(
          target,
          segments.slice(1).map((s) => s.id),
        ),
        opaque,
      ),
    ),
  );
  // Pending suggestions the edit leaves out are accepted or rejected, and threads it leaves out are resolved
  // (unless their text goes too, with allowDetach); the rest is planned on the doc as it is once they are.
  const summaries = new Map((doc.suggestions ?? []).map((s) => [s.suggestionId ?? "", s.summaryText ?? ""]));
  const name = (id: string) => summaries.get(id)?.replace(/\s+/g, " ") || "a pending suggestion";
  const { choices, problems: choiceProblems } = decide(segments, next, name);
  const gone = [...known.keys()].filter((t) => !target.includes(threadKey(t)));
  const unthreaded = segments.map((s) => ({
    ...s,
    atoms: s.atoms.filter((a) => !(a.thread && gone.includes(a.thread))),
  }));
  const base = resolved(unthreaded, choices);
  const shift = shifts(unthreaded, choices);
  const quotes = new Map(anchoredThreads.map(({ comment }) => [comment.commentId ?? "", comment.plainTextQuote ?? ""]));
  const shown = (atoms: Atom[]) =>
    atoms.map((a) => (a.thread && isThread(a) ? { ...a, nodes: (known.get(a.thread) ?? []).map(raw) } : a));
  const planned = plan(base, next, {
    tabId: opts.tab,
    suggest,
    threads: anchoredThreads.map(({ comment, ranges }) => ({
      id: comment.commentId ?? "",
      quote: comment.plainTextQuote ?? "",
      ranges: ranges.map((r) => ({
        ...r,
        startIndex: shift(r.segmentId ?? "", r.startIndex ?? 0),
        endIndex: shift(r.segmentId ?? "", r.endIndex ?? 0),
      })),
    })),
    allowDetach: !!opts.allowDetach,
    mine: (doc.suggestions ?? []).filter((s) => s.headPost?.author?.me).map((s) => s.suggestionId ?? ""),
    docmd: (atoms) => toDocmd([{ id: "", atoms: shown(atoms) }]).trim(),
    name,
  });
  // A thread whose text all goes is detached (it stays, open); one whose markup goes and text stays, resolved.
  const resolving = gone.filter((t) => !planned.detached.includes(t));
  // A new comment on a thread's text, as the thread goes: most likely, what the thread says was edited.
  const rewritten = comments.filter((c) => {
    const quote = c.on.map((a) => (a.kind === "text" ? a.key : "")).join("");
    return resolving.some((t) => quotes.get(t) === quote);
  });
  const requests = planned.requests;
  const batch = [
    ...[...choices].map(([suggestionId, c]) =>
      c === "accept" ? { acceptSuggestion: { suggestionId } } : { rejectSuggestion: { suggestionId } },
    ),
    ...requests,
    ...replies.map(({ thread, content }) => ({ addCommentReply: { commentId: thread, post: { content } } })),
    ...resolving.map((commentId) => ({ addCommentReply: { commentId, post: { commentAction: "RESOLVE" } } })),
  ];
  // The planner's problems follow from these, so they're left out until these are fixed.
  const first = rewritten.length
    ? [{ code: "comments_read_only" as const, message: REWRITTEN }]
    : [...commentProblems, ...choiceProblems];
  const problems = first.length ? first : planned.problems;
  const outcome = [
    ...[...choices].map(([id, c]) => `${c === "accept" ? "Accepted" : "Rejected"} the suggestion "${name(id)}".`),
    ...[...new Set(replies.map((r) => r.thread))].map((t) => `Replied to the comment on "${quotes.get(t) ?? ""}".`),
    ...resolving.map((t) => `Resolved the comment on "${quotes.get(t) ?? ""}".`),
    ...planned.detached.map((t) => `The comment on "${quotes.get(t) ?? ""}" stays, without its text.`),
  ];
  return { docmd, next, batch, requests, problems, comments, outcome };
}

const REWRITTEN =
  "what a comment thread says can't be changed. To reply, add {>>your reply<<} after its last comment; to " +
  "resolve it, remove its highlight and comments.";

export async function edit(api: Api, id: string, opts: EditOptions): Promise<string[]> {
  const suggest = opts.mode !== "direct";
  // The doc is read right before planning, and the write is guarded by that revision; if someone changed the
  // doc in between, the same text edits are planned again on the new revision.
  for (let attempt = 1; ; attempt++) {
    const doc = await api.getDoc(id);
    const { docmd, next, batch, requests, problems, comments, outcome } = planEdit(doc, opts);
    if (problems.length) {
      const code = (["unsupported_edit", "comments_read_only", "anchors_affected"] as const).find((c) =>
        problems.some((p) => p.code === c),
      );
      const messages = [...new Set(problems.map((p) => p.message))];
      throw new ToolError(
        code ?? "unsupported_edit",
        `Nothing was changed.\n${messages.map((m) => `- ${m}`).join("\n")}`,
      );
    }
    if (!batch.length && !comments.length) return ["No changes: the edited text is what the doc already says."];

    let state: string | null | undefined;
    if (batch.length)
      try {
        const { data } = await api.call(
          () =>
            api.docs.documents.batchUpdate({
              documentId: id,
              requestBody: {
                requests: batch,
                writeControl: {
                  requiredRevisionId: doc.revisionId,
                  ...(suggest && requests.length ? { writeMode: "SUGGEST" } : {}),
                },
              },
            }),
          id,
        );
        state = data.commentUpdateState;
      } catch (e) {
        if (!isConflict(e)) throw e;
        if (attempt < 3) continue;
        throw new ToolError(
          "revision_conflict",
          "The doc keeps changing while the edit is planned; read it again and retry.",
        );
      }

    // What read shows now; it should be the edited docmd.
    let written = batch.length ? await api.getDoc(id) : doc;
    const writtenSegments = load(written, { tabId: opts.tab }).segments;
    const out: string[] = [];
    if (requests.length) out.push(`Applied the text changes ${suggest ? "as suggestions" : "directly"}.`);
    out.push(...outcome);
    if (state === "ALL_FAILED_UNKNOWN_REASON")
      out.push("Google reports that saving comments or suggestions failed; read the doc to check what it holds now.");
    const intended = comparable(asShown(next));
    const now = comparable(writtenSegments);
    if (now !== intended)
      out.push(
        `The doc doesn't read as intended. Differences (- intended, + now in the doc):\n${changes(intended, now)}`,
      );

    // New comments go on the text as written, now that it is.
    if (comments.length) {
      const added = await addComments(api, id, next, comments, opts.tab, written);
      if (added.doc) written = added.doc;
      out.push(...added.notes);
    }
    const after = toDocmd(load(written, { tabId: opts.tab }).segments);
    out.push(`Changed lines:\n${changes(docmd, after) || "(none)"}`);
    return out;
  }
}

/** Inserts the new comments on the doc as `doc` holds it; if the doc changes in between, they're placed again. */
async function addComments(
  api: Api,
  id: string,
  next: Segment[],
  comments: NewComment[],
  tab: string | undefined,
  doc: Doc,
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { requests, unplaced } = placeComments(next, load(doc, { tabId: tab }).segments, comments, tab);
    const notes = unplaced.map(
      (c) => `The comment "${c.content}" wasn't added: its text isn't in the doc as the edit wrote it.`,
    );
    if (!requests.length) return { notes };
    try {
      await api.call(
        () =>
          api.docs.documents.batchUpdate({
            documentId: id,
            requestBody: { requests, writeControl: { requiredRevisionId: doc.revisionId } },
          }),
        id,
      );
      const n = requests.length;
      return { doc: await api.getDoc(id), notes: [`Added ${n === 1 ? "a comment" : `${n} comments`}.`, ...notes] };
    } catch (e) {
      if (!isConflict(e)) throw e;
      doc = await api.getDoc(id);
    }
  }
  return { notes: ["The new comments weren't added: the doc kept changing. Read it and add them again."] };
}

const FOLDER = "gdocs-artifacts";
const FOLDER_TYPE = "application/vnd.google-apps.folder";

/** Creates a doc from Markdown, by default in the gdocs-artifacts folder in My Drive (created on first use). */
export async function createDoc(api: Api, title: string, markdown: string, folderId?: string): Promise<string[]> {
  const atoms = parsed(markdown).flatMap((s) => s.atoms);
  const special = atoms.find(
    (a) => a.kind === "element" || a.kind === "annotation" || a.ins || a.del || a.styleChanges.length,
  );
  if (special)
    throw new ToolError(
      "unsupported_edit",
      `create_doc takes plain Markdown; ${special.kind === "element" ? comparable([{ id: "", atoms: [special] }]).trim() : "CriticMarkup"} isn't supported in new docs yet.`,
    );
  const { drive, call } = api;
  let parent = folderId;
  if (!parent) {
    const { data } = await call(() =>
      drive.files.list({
        q: `name = '${FOLDER}' and mimeType = '${FOLDER_TYPE}' and trashed = false`,
        fields: "files(id)",
      }),
    );
    parent = data.files?.[0]?.id ?? undefined;
    if (!parent) {
      const { data: created } = await call(() =>
        drive.files.create({ requestBody: { name: FOLDER, mimeType: FOLDER_TYPE }, fields: "id" }),
      );
      parent = created.id ?? undefined;
    }
  }
  const { data } = await call(() =>
    drive.files.create({
      requestBody: { name: title, mimeType: "application/vnd.google-apps.document", parents: parent ? [parent] : [] },
      media: { mimeType: "text/markdown", body: markdown },
      fields: "id,webViewLink",
    }),
  );
  return [`Created "${title}" (doc ID ${data.id}): ${data.webViewLink}`];
}
