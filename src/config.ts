// The OAuth client and refresh token, as plain files in ~/.config/gdocs-artifacts (like ~/.ssh). The client
// can also come from GDOCS_ARTIFACTS_CLIENT_ID and _CLIENT_SECRET, set in the environment or in a .env file in
// the working directory (the environment wins), for CI, managed setups and development.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthClient } from "./auth.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gdocs-artifacts");
const CLIENT_FILE = join(DIR, "client.json");
const tokenFile = () => process.env.GDOCS_ARTIFACTS_TOKEN_FILE ?? join(DIR, "token.json");

function read<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadClient(): OAuthClient | undefined {
  const { GDOCS_ARTIFACTS_CLIENT_ID: clientId, GDOCS_ARTIFACTS_CLIENT_SECRET: clientSecret } = process.env;
  if (clientId && clientSecret) return { clientId, clientSecret };
  return read<OAuthClient>(CLIENT_FILE);
}

export const saveClient = (client: OAuthClient) => write(CLIENT_FILE, client);

export const loadToken = () => read<{ refreshToken: string }>(tokenFile())?.refreshToken;

export const saveToken = (refreshToken: string) => write(tokenFile(), { refreshToken });

export const CONFIG_DIR = DIR;
