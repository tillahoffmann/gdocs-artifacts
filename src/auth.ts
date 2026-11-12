// Google OAuth for a Desktop app client: browser sign-in through a loopback redirect with PKCE, and
// authenticated clients from a stored refresh token. The only scope ever requested is drive.file.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Auth, google } from "googleapis";

export const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Parameters that turn sign-in into Google Picker: the user picks docs, which grants drive.file access to them. */
export const PICKER_PARAMS = {
  trigger_onepick: "true",
  allow_multiple: "true",
  mimetypes: "application/vnd.google-apps.document",
};

/**
 * Runs the sign-in flow. `onUrl` gets the URL the user must open in a browser; the promise settles when
 * Google redirects back to the loopback listener. Returns the refresh token and the redirect's query
 * parameters (with Picker, `picked_file_ids`).
 */
export async function signIn(
  { clientId, clientSecret }: OAuthClient,
  onUrl: (url: string) => void,
  extraParams: Record<string, string> = {},
): Promise<{ refreshToken: string; redirect: URLSearchParams }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new google.auth.OAuth2({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    scope: [SCOPE],
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: Auth.CodeChallengeMethod.S256,
    ...extraParams,
  });

  const redirect = await new Promise<URLSearchParams>((resolve, reject) => {
    server.on("request", (req, res) => {
      const params = new URL(req.url ?? "/", redirectUri).searchParams;
      const error = params.get("error");
      const code = params.get("code");
      if (!code && !error) return void res.writeHead(404).end();
      res.end(error ? `Sign-in failed: ${error}` : "Signed in. You can close this tab.");
      server.close();
      if (code) resolve(params);
      else reject(new Error(`sign-in failed: ${error}`));
    });
    onUrl(url);
  });

  const code = redirect.get("code") ?? "";
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token");
  if (tokens.scope !== SCOPE) throw new Error(`unexpected scopes granted: ${tokens.scope}`);
  return { refreshToken: tokens.refresh_token, redirect };
}

/** An authenticated client for Google APIs, refreshing access tokens as needed. */
export function authClient({ clientId, clientSecret }: OAuthClient, refreshToken: string) {
  const client = new google.auth.OAuth2({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/** Opens a URL in the default browser, if there is one; failures are ignored (the URL is also printed). */
export function openBrowser(url: string) {
  const [cmd, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawn(cmd ?? "open", args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
