// The OAuth client and its refresh token, in one file: ~/.config/gdocs-artifacts/credentials.json (like
// ~/.ssh). The client can also come from GDOCS_ARTIFACTS_CLIENT_ID and _CLIENT_SECRET, set in the environment
// or in a .env file in the working directory (they win), for CI, managed setups and development.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthClient } from "./auth.js";

if (existsSync(".env")) process.loadEnvFile(".env");

type Credentials = OAuthClient & { refreshToken?: string };

export const CREDENTIALS_FILE = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "gdocs-artifacts",
  "credentials.json",
);

function read(): Credentials | undefined {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as Credentials;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function write({ clientId, clientSecret, refreshToken }: Credentials) {
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, `${JSON.stringify({ clientId, clientSecret, refreshToken }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(CREDENTIALS_FILE, 0o600);
}

export function loadClient(): OAuthClient | undefined {
  const { GDOCS_ARTIFACTS_CLIENT_ID: clientId, GDOCS_ARTIFACTS_CLIENT_SECRET: clientSecret } = process.env;
  if (clientId && clientSecret) return { clientId, clientSecret };
  const saved = read();
  return saved && { clientId: saved.clientId, clientSecret: saved.clientSecret };
}

/** The saved refresh token, if it was issued to `client`: Google refreshes a token only with its own client. */
export function loadToken(client: OAuthClient) {
  const saved = read();
  return saved?.clientId === client.clientId ? saved.refreshToken : undefined;
}

/** Saves the client, keeping the token if it belongs to it. */
export const saveClient = (client: OAuthClient) => write({ ...client, refreshToken: loadToken(client) });

/** Saves the token with the client it was issued to. */
export const saveToken = (client: OAuthClient, refreshToken: string) => write({ ...client, refreshToken });
