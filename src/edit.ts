// The edit and create_doc tools. An edit replaces text in a tab's docmd; the planner turns the edited docmd
// into batchUpdate requests, which are written as suggestions (or directly) and checked by reading back.
import { diffLines } from "diff";
import { comparable, load, parse, toDocmd, Unsupported } from "./docmd.js";
import { ToolError } from "./errors.js";
import type { clients } from "./google.js";
import { asShown, suggestions } from "./ir.js";
import { plan } from "./plan.js";

type Api = ReturnType<typeof clients>;

export type Edit = { old: string; new: string; nth?: number };

/** A thread in docmd: its ID, then what it says. */
const THREAD = /(?<!\\)\{>>c:([^\s<]+)(?:\\.|[^\\\n])*?<<\}/g;
/** Threads reduced to their IDs, so that `old` still matches after someone replies to a thread. */
const threadIds = (s: string) => s.replace(THREAD, "{>>c:$1<<}");
const threads = (s: string) => new Map([...s.matchAll(THREAD)].map((m) => [m[1], m[0]]));

/** Applies the edits in order, each to the result of the ones before. Threads compare by ID only. */
export function applyEdits(docmd: string, edits: Edit[]): string {
  const known = threads(docmd);
  return edits.reduce((text, e, k) => {
    const label = `edit ${k + 1}`;
    // A thread in new reads as in the doc, as in old (read before a reply came in), or shortened to its ID.
    const before = threads(e.old);
    for (const [id, body] of threads(e.new))
      if (known.has(id) && ![known.get(id), before.get(id), `{>>c:${id}<<}`].includes(body))
        throw new ToolError(
          "comments_read_only",
          `${label} changes what comment thread ${id} says; comments can't be changed through edits.`,
        );
    const old = threadIds(e.old);
    if (!old) throw new ToolError("anchor_not_found", `${label}: old is empty; include the text next to the change.`);
    const found: number[] = [];
    for (let at = text.indexOf(old); at >= 0; at = text.indexOf(old, at + 1)) found.push(at);
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
    return text.slice(0, at) + threadIds(e.new) + text.slice(at + old.length);
  }, threadIds(docmd));
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

export async function edit(
  api: Api,
  id: string,
  opts: { tab?: string; mode?: "suggest" | "direct"; edits: Edit[]; allowDetach?: string[] },
): Promise<string[]> {
  const suggest = opts.mode !== "direct";
  // The doc is read right before planning, and the write is guarded by that revision; if someone changed the
  // doc in between, the same text edits are planned again on the new revision.
  for (let attempt = 1; ; attempt++) {
    const doc = await api.getDoc(id);
    // Edits apply to docmd as read shows it by default, with open threads inline.
    const { segments, threads } = load(doc, { tabId: opts.tab });
    const pending = suggestions(segments.flatMap((s) => s.atoms));
    const docmd = toDocmd(segments);
    const target = applyEdits(docmd, opts.edits);
    const next = parsed(
      target,
      segments.slice(1).map((s) => s.id),
    );
    const { requests, problems } = plan(segments, next, {
      tabId: opts.tab,
      suggest,
      threads: threads.map(({ comment, ranges }) => ({
        id: comment.commentId ?? "",
        quote: comment.plainTextQuote ?? "",
        ranges,
      })),
      allowDetach: opts.allowDetach ?? [],
      mine: (doc.suggestions ?? []).filter((s) => s.headPost?.author?.me).map((s) => s.suggestionId ?? ""),
      docmd: (atoms) => comparable([{ id: "", atoms }], pending).trim(),
    });
    if (problems.length) {
      const code = (["unsupported_edit", "comments_read_only", "anchors_affected"] as const).find((c) =>
        problems.some((p) => p.code === c),
      );
      throw new ToolError(
        code ?? "unsupported_edit",
        `Nothing was changed.\n${problems.map((p) => `- ${p.message}`).join("\n")}`,
      );
    }
    if (!requests.length) return ["No changes: the edited text is what the doc already says."];

    let state: string | null | undefined;
    try {
      const { data } = await api.call(
        () =>
          api.docs.documents.batchUpdate({
            documentId: id,
            requestBody: {
              requests,
              writeControl: { requiredRevisionId: doc.revisionId, ...(suggest ? { writeMode: "SUGGEST" } : {}) },
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

    // What read shows now; it should be the edited docmd, with IDs on the new suggestions.
    const written = load(await api.getDoc(id), { tabId: opts.tab }).segments;
    const out = [
      `Applied ${opts.edits.length === 1 ? "the edit" : `${opts.edits.length} edits`} ${suggest ? "as suggestions" : "directly"}. Changed lines:\n${changes(docmd, toDocmd(written))}`,
    ];
    if (state === "ALL_FAILED_UNKNOWN_REASON")
      out.push("Google reports that saving the suggestions failed; read the doc to check what it holds now.");
    const intended = comparable(asShown(next), pending);
    const now = comparable(written, pending);
    if (now !== intended)
      out.push(
        `The doc doesn't read as intended. Differences (- intended, + now in the doc):\n${changes(intended, now)}`,
      );
    return out;
  }
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
