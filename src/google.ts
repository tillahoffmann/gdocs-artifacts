// Google API clients from the stored credentials, with Google's errors turned into ones that say what to do.
import { type docs_v1, google } from "googleapis";
import { authClient, type OAuthClient, PICKER_PARAMS, signIn } from "./auth.js";
import { loadClient, loadToken, saveToken } from "./config.js";
import { notAuthenticated, notConfigured, ToolError } from "./errors.js";

/** The doc ID from a doc ID or any docs.google.com URL. */
export function docId(doc: string) {
  const id = doc.match(/\/document\/(?:u\/\d+\/)?d\/([\w-]+)/)?.[1] ?? doc.trim();
  if (!/^[\w-]{20,}$/.test(id))
    throw new ToolError("invalid_doc", `"${doc}" is neither a doc ID nor a Google Docs URL.`);
  return id;
}

/** The doc doesn't exist, or the user hasn't granted the app access to it; both are a 404. */
export class DocNotFound extends Error {
  constructor(readonly docId: string) {
    super(`doc ${docId} not found, or not granted to the app`);
  }
}

/** Clients from the stored credentials. */
export function connect() {
  const client = loadClient();
  if (!client) throw notConfigured();
  const refreshToken = loadToken();
  if (!refreshToken) throw notAuthenticated("isn't signed in to Google");
  return clients(client, refreshToken);
}

/** Docs and Drive clients for one OAuth client and refresh token. */
export function clients(client: OAuthClient, refreshToken: string) {
  const auth = authClient(client, refreshToken);
  const docs = google.docs({ version: "v1", auth });
  return {
    docs,
    drive: google.drive({ version: "v3", auth }),
    call,
    /** The full doc: all tabs, suggestions inline, comments included. */
    async getDoc(id: string): Promise<docs_v1.Schema$Document> {
      const { data } = await call(
        () =>
          docs.documents.get({
            documentId: id,
            includeTabsContent: true,
            suggestionsViewMode: "SUGGESTIONS_INLINE",
            commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
          }),
        id,
      );
      return data;
    },
  };
}

type GoogleError = {
  status?: number;
  message?: string;
  response?: { data?: { error?: string | { details?: { reason?: string; metadata?: Record<string, string> }[] } } };
};

/** Runs a Google API call; errors the user can fix become ToolErrors, and a 404 on `docId` a DocNotFound. */
async function call<T>(fn: () => Promise<T>, docId?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as GoogleError;
    const data = err.response?.data?.error;
    if (data === "invalid_grant") {
      throw notAuthenticated("can't use its Google sign-in anymore: it expired or was revoked");
    }
    const disabled = typeof data === "object" && data.details?.find((d) => d.reason === "SERVICE_DISABLED");
    if (disabled) {
      const { service, consumer, activationUrl } = disabled.metadata ?? {};
      const project = consumer?.replace("projects/", "");
      throw new ToolError(
        "api_not_enabled",
        `${service} isn't enabled in the Cloud project of the OAuth client (project ${project}).
Ask the user to enable it at ${activationUrl}
or run  gcloud services enable ${service} --project ${project}
then retry this request after a minute.`,
      );
    }
    if (err.status === 404 && docId) throw new DocNotFound(docId);
    throw e;
  }
}

/** Picker links in flight, by doc ID; each has a loopback listener waiting for Google's redirect. */
const pending = new Map<string, Promise<string>>();

/** A Picker link for the doc; picking it grants the app access. Works while this process runs. */
export function grantUrl(client: OAuthClient, docId: string) {
  let url = pending.get(docId);
  if (!url) {
    url = new Promise<string>((resolve, reject) => {
      signIn(client, resolve, { ...PICKER_PARAMS, file_ids: docId })
        // Picking signs in again; keep the newest token.
        .then(({ refreshToken }) => saveToken(refreshToken))
        .catch((e: Error) => {
          console.error(`gdocs-artifacts: picking ${docId} failed: ${e.message}`);
          reject(e);
        })
        .finally(() => pending.delete(docId));
    });
    pending.set(docId, url);
  }
  return url;
}
