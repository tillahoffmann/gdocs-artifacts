// The MCP server over stdio. stdout is the MCP channel, so anything else goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { docs_v1 } from "googleapis";
import { z } from "zod";
import { loadClient } from "./config.js";
import { render } from "./docmd.js";
import { createDoc, edit } from "./edit.js";
import { needsFileGrant, notConfigured, ToolError } from "./errors.js";
import { connect, DocNotFound, docId, grantUrl } from "./google.js";

const doc = z.string().describe("Doc ID or docs.google.com URL");

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a tool; our errors become error results with their instructions, anything else is rethrown. */
async function run(fn: () => Promise<string[]>): Promise<Result> {
  try {
    return { content: (await fn()).map((text) => ({ type: "text", text })) };
  } catch (e) {
    const err = e instanceof DocNotFound ? await fileGrant(e.docId) : e;
    if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

async function fileGrant(id: string) {
  const client = loadClient();
  return client ? needsFileGrant(id, await grantUrl(client, id)) : notConfigured();
}

const allTabs = (tabs: docs_v1.Schema$Tab[]): docs_v1.Schema$Tab[] =>
  tabs.flatMap((t) => [t, ...allTabs(t.childTabs ?? [])]);

export async function serve(version: string) {
  const server = new McpServer({ name: "gdocs-artifacts", version });

  server.registerTool(
    "read",
    {
      description:
        "Read one tab of a Google Doc as Markdown. Open comment threads and pending suggestions are inline as " +
        "CriticMarkup: {==quoted text==}{>>c:<threadId> Author: text · Author: reply<<}, and {++inserted++}, " +
        "{--deleted--} or {~~old~>new~~} followed by {>>s:<suggestionId><<}. People are @[Name](mailto:email); " +
        "dates, Drive links and dropdowns are {{date:…}}, {{link:<url>|<title>}} and {{dropdown:<title>=<option>}}; " +
        "anything else without a Markdown form is {{opaque:<kind>:<id>}}. A line break within a paragraph is " +
        "{{br}}. Literal { in doc text is escaped as \\{.",
      inputSchema: {
        doc,
        tab: z.string().optional().describe("Tab ID; defaults to the first tab"),
        comments: z
          .enum(["open", "all", "none"])
          .optional()
          .describe("Which comment threads to show inline: open (default), all (resolved ones marked), or none"),
        section: z.string().optional().describe("Only the section under the heading with this exact text"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ doc: d, tab, comments, section }) =>
      run(async () => {
        const id = docId(d);
        const data = await connect().getDoc(id);
        const markdown = render(data, { tabId: tab, comments, section });
        const open = (data.comments ?? []).filter((c) => c.status === "OPEN").length;
        const pending = (data.suggestions ?? []).filter((s) => s.status === "OPEN").length;
        const notes = [`${open} open comment threads and ${pending} pending suggestions in the doc.`];
        const tabs = allTabs(data.tabs ?? []);
        if (tabs.length > 1) {
          const shown = tab ?? tabs[0]?.tabProperties?.tabId;
          const others = tabs.filter((t) => t.tabProperties?.tabId !== shown);
          notes.push(
            `Other tabs: ${others.map((t) => `"${t.tabProperties?.title}" (${t.tabProperties?.tabId})`).join(", ")}.`,
          );
        }
        return [markdown, notes.join(" ")];
      }),
  );

  server.registerTool(
    "doc_info",
    {
      description:
        "A Google Doc's title, URL, owners, last change and sharing; the tab tree if it has more than one tab.",
      inputSchema: { doc },
      annotations: { readOnlyHint: true },
    },
    ({ doc: d }) =>
      run(async () => {
        const id = docId(d);
        const { docs, drive, call } = connect();
        const { data } = await call(
          () =>
            docs.documents.get({
              documentId: id,
              includeTabsContent: true,
              fields: "tabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties)))",
            }),
          id,
        );
        const { data: file } = await call(
          () =>
            drive.files.get({
              fileId: id,
              fields:
                "name,webViewLink,modifiedTime,owners(displayName,emailAddress)," +
                "permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery)",
            }),
          id,
        );
        const tree = (tabs: docs_v1.Schema$Tab[]): unknown[] =>
          tabs.map((t) => ({
            id: t.tabProperties?.tabId,
            title: t.tabProperties?.title,
            ...(t.childTabs?.length ? { children: tree(t.childTabs) } : {}),
          }));
        const info = {
          title: file.name,
          url: file.webViewLink,
          owners: file.owners,
          modified: file.modifiedTime,
          sharing: file.permissions,
          ...(allTabs(data.tabs ?? []).length > 1 ? { tabs: tree(data.tabs ?? []) } : {}),
        };
        return [JSON.stringify(info, null, 2)];
      }),
  );

  server.registerTool(
    "edit",
    {
      description:
        "Edit one tab of a Google Doc by replacing text in its docmd (the Markdown that read returns). Each " +
        "edit replaces `old`, which must match exactly once (or pass nth), with `new`; edits apply in order. " +
        "Copy old as read shows it, comment markup included; comments are read-only, so keep {==, ==} and " +
        "{>>c:…<<} as they are (a thread may be shortened to {>>c:<id><<}). Formatting is Markdown: **bold**, " +
        "*italic*, ~~strike~~, `code`, [links](url), # headings, new paragraphs and list items. By default " +
        "changes are suggestions the doc's editors accept or reject, written in CriticMarkup without an ID: " +
        "{++added++}, {--removed--}, {~~old~>new~~}, and formatting as {~~word~>**word**~~}; a new paragraph " +
        "or list item is all {++…++}. Text outside the markup stays as read shows it. The doc then reads as " +
        'written, with IDs on the new suggestions. In mode "direct" (only when the user asked for direct ' +
        "edits) write the change itself. Leave pending suggestions (with their {>>s:…<<}) as they are. Text " +
        "with open comments can be edited, but removing all of a thread's text is refused unless allowDetach " +
        "names the thread (it stays, unanchored); use that only when the user asked for the text to go. " +
        "Returns the changed lines.",
      inputSchema: {
        doc,
        tab: z.string().optional().describe("Tab ID; defaults to the first tab"),
        mode: z.enum(["suggest", "direct"]).optional().describe('"suggest" (default) or "direct"'),
        edits: z
          .array(
            z.object({
              old: z.string().describe("Text to replace, copied from the docmd"),
              new: z.string().describe("Replacement docmd"),
              nth: z.number().int().min(1).optional().describe("Which match of old, if it occurs more than once"),
            }),
          )
          .min(1),
        allowDetach: z.array(z.string()).optional().describe("Comment thread IDs whose text may go"),
      },
    },
    ({ doc: d, ...opts }) => run(() => edit(connect(), docId(d), opts)),
  );

  server.registerTool(
    "create_doc",
    {
      description:
        "Create a Google Doc from Markdown (headings, paragraphs, bold, italic, strikethrough, inline code, " +
        "links, lists, tables). It goes into the gdocs-artifacts folder in the user's My Drive unless " +
        "folderId is given, and is shared with no one. Returns its URL and doc ID.",
      inputSchema: {
        title: z.string().describe("The doc's title"),
        markdown: z.string().describe("The content"),
        folderId: z.string().optional().describe("Drive folder ID to create the doc in"),
      },
    },
    ({ title, markdown, folderId }) => run(() => createDoc(connect(), title, markdown, folderId)),
  );

  await server.connect(new StdioServerTransport());
}
