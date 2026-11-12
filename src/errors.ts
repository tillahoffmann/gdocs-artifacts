// Structured errors that say what to do next, in words an agent can relay to the user as is.

export type ErrorCode =
  | "not_configured"
  | "not_authenticated"
  | "api_not_enabled"
  | "needs_file_grant"
  | "section_not_found"
  | "invalid_doc";

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export const notConfigured = () =>
  new ToolError(
    "not_configured",
    `gdocs-artifacts has no Google OAuth client yet.
Ask the user to run this in a terminal:  npx gdocs-artifacts setup
It asks for the client ID and secret of a Desktop OAuth client (from their organization, or one they create
in Google Cloud; the command explains how). Alternatively, set GDOCS_ARTIFACTS_CLIENT_ID and
GDOCS_ARTIFACTS_CLIENT_SECRET in the server's environment or a .env file in its working directory.
Then they run  npx gdocs-artifacts auth  and retry this request; no restart needed.`,
  );

export const notAuthenticated = (cause: string) =>
  new ToolError(
    "not_authenticated",
    `gdocs-artifacts ${cause}.
Ask the user to run this in a terminal:  npx gdocs-artifacts auth
It opens a browser to sign in with Google. The app only gets access to docs it creates or that the user
picks. Then retry this request; no restart needed.`,
  );

export const needsFileGrant = (docId: string, url: string) =>
  new ToolError(
    "needs_file_grant",
    `gdocs-artifacts can't open doc ${docId}: either it doesn't exist, or the user hasn't granted access to it
(the app only sees docs it created or that the user picked).
Ask the user to open this link and pick the doc:
${url}
Then retry this request. The link works while this server is running.`,
  );
