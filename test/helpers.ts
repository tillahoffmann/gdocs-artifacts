// Test helpers: the test accounts configured in .env, and doc helpers for the live tests against Google.
// An account without a refresh token signs in through the browser once; the token is saved to .env.

import { appendFileSync, existsSync } from "node:fs";
import type { docs_v1, drive_v3 } from "googleapis";
import { afterAll, describe, test } from "vitest";
import { type OAuthClient, openBrowser, signIn } from "../src/auth.js";
import { clients } from "../src/google.js";

const ENV_FILE = ".env";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export type Account = "gmail" | "workspace";
export type Doc = docs_v1.Schema$Document;
export type Request = docs_v1.Schema$Request;

const ALL: Account[] = ["gmail", "workspace"];
const envKey = (account: Account, name: string) => `GDOCS_${account.toUpperCase()}_${name}`;

/** Accounts that have an OAuth client configured; tests run once per account. */
export const accounts = ALL.filter((a) => process.env[envKey(a, "CLIENT_ID")]);

/**
 * Defines the tests in `fn` once per configured account. Without accounts (as in CI) or with `skip` set, the
 * tests are reported as skipped rather than failing for lack of a suite.
 */
export function describeAccounts(fn: (account: Account) => void, skip?: string) {
  const reason = skip ?? (accounts.length === 0 ? "no Google accounts in .env" : undefined);
  if (reason) describe.skip(reason, () => test.skip("skipped", () => {}));
  else describe.each(accounts)("%s", fn);
}

export function oauthClient(account: Account): OAuthClient {
  const clientId = process.env[envKey(account, "CLIENT_ID")];
  const clientSecret = process.env[envKey(account, "CLIENT_SECRET")];
  if (!clientId || !clientSecret) throw new Error(`${account}: client ID or secret missing in .env`);
  return { clientId, clientSecret };
}

/** Opens the sign-in URL in the browser and says which account to use. */
export function openInBrowser(account: Account, what: string) {
  return (url: string) => {
    console.log(`\n[${account}] ${what} with your ${account} account in the browser:\n${url}\n`);
    openBrowser(url);
  };
}

async function accountToken(account: Account) {
  const client = oauthClient(account);
  let refreshToken = process.env[envKey(account, "REFRESH_TOKEN")];
  if (!refreshToken) {
    ({ refreshToken } = await signIn(client, openInBrowser(account, "Sign in")));
    appendFileSync(ENV_FILE, `${envKey(account, "REFRESH_TOKEN")}=${refreshToken}\n`);
    process.env[envKey(account, "REFRESH_TOKEN")] = refreshToken;
  }
  return refreshToken;
}

/** Docs created by this test file; deleted after its tests. */
const created: { drive: drive_v3.Drive; id: string }[] = [];
afterAll(() => Promise.all(created.map(({ drive, id }) => drive.files.delete({ fileId: id }))));

/** The server's Docs and Drive clients for one account, plus helpers to create and change docs. */
export async function connect(account: Account) {
  const google = clients(oauthClient(account), await accountToken(account));
  const { drive, docs } = google;
  return {
    ...google,
    /** Creates a doc, empty or imported from Markdown; it's deleted after the test file finishes unless `keep`. */
    async createDoc(name: string, markdown?: string, { keep = false } = {}) {
      const { data } = await drive.files.create({
        requestBody: { name: `gdocs-artifacts test: ${name}`, mimeType: "application/vnd.google-apps.document" },
        media: markdown === undefined ? undefined : { mimeType: "text/markdown", body: markdown },
        fields: "id",
      });
      if (!keep) created.push({ drive, id: data.id! });
      return data.id!;
    },
    async update(documentId: string, requests: Request[], opts: { mode?: "SUGGEST"; revision?: string } = {}) {
      const { data } = await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests, writeControl: { writeMode: opts.mode, requiredRevisionId: opts.revision } },
      });
      return data;
    },
  };
}

export type Api = Awaited<ReturnType<typeof connect>>;

/** The first tab's document tab. */
export function firstTab(doc: Doc) {
  const tab = doc.tabs?.[0]?.documentTab;
  if (!tab) throw new Error("doc has no tabs");
  return tab;
}

/** The first tab's body paragraphs, outside tables. */
export function paragraphs(doc: Doc) {
  return (firstTab(doc).body?.content ?? []).flatMap((el) => (el.paragraph ? [el.paragraph] : []));
}

/** Plain text of the first tab's body; chips and other non-text elements as their kind in brackets. */
export function bodyText(doc: Doc) {
  return paragraphs(doc)
    .flatMap((p) => p.elements ?? [])
    .map((pe) => pe.textRun?.content ?? `[${Object.keys(pe).find((k) => !k.endsWith("Index"))}]`)
    .join("");
}

/** The text run whose content is exactly `text`. */
export function run(doc: Doc, text: string) {
  const found = paragraphs(doc)
    .flatMap((p) => p.elements ?? [])
    .find((pe) => pe.textRun?.content === text);
  if (!found?.textRun) throw new Error(`no text run: ${text}`);
  return found.textRun;
}

/** The paragraph whose text is exactly `text` (without its trailing newline). */
export function paragraph(doc: Doc, text: string) {
  const found = paragraphs(doc).find(
    (p) => p.elements?.map((pe) => pe.textRun?.content ?? "").join("") === `${text}\n`,
  );
  if (!found) throw new Error(`no paragraph: ${text}`);
  return found;
}

/** Start and end index of the first occurrence of `text` in the first tab's text runs. */
export function findText(doc: Doc, text: string) {
  for (const pe of paragraphs(doc).flatMap((p) => p.elements ?? [])) {
    const at = pe.textRun?.content?.indexOf(text) ?? -1;
    if (at >= 0) return { startIndex: pe.startIndex! + at, endIndex: pe.startIndex! + at + text.length };
  }
  throw new Error(`text not found: ${text}`);
}
