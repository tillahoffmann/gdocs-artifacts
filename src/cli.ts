#!/usr/bin/env node
// gdocs-artifacts: without arguments, the MCP server over stdio; `setup` and `auth` are run once by the user.
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";
import { authClient, openBrowser, signIn } from "./auth.js";
import { CONFIG_DIR, loadClient, saveClient, saveToken } from "./config.js";
import { notConfigured } from "./errors.js";
import { serve } from "./server.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const SETUP = `gdocs-artifacts needs a Desktop OAuth client from a Google Cloud project.
If your organization shares one, paste its client ID and secret below. Otherwise create one (about 5 minutes):

1. Create or pick a project: https://console.cloud.google.com/projectcreate
2. Enable the Google Docs and Google Drive APIs:
   https://console.cloud.google.com/apis/enableflow?apiid=docs.googleapis.com,drive.googleapis.com
   (or: gcloud services enable docs.googleapis.com drive.googleapis.com --project <project ID>)
3. Set up Google Auth Platform: https://console.cloud.google.com/auth/overview
   - Audience: Internal for a Google Workspace organization. For a personal Gmail account: External, then
     add yourself as a test user (sign-in then lasts 7 days).
   - Data access: add only the scope https://www.googleapis.com/auth/drive.file
4. Create an OAuth client of type "Desktop app": https://console.cloud.google.com/auth/clients/create
`;

async function setup() {
  console.log(SETUP);
  const rl = createInterface({ input: stdin, output: stdout });
  const clientId = (await rl.question("Client ID: ")).trim();
  const clientSecret = (await rl.question("Client secret: ")).trim();
  rl.close();
  if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("that isn't an OAuth client ID");
  saveClient({ clientId, clientSecret });
  console.log(`\nSaved to ${CONFIG_DIR}. Next, sign in:  npx gdocs-artifacts auth`);
}

async function auth() {
  const client = loadClient();
  if (!client) throw notConfigured();
  const { refreshToken } = await signIn(client, (url) => {
    console.log(`Opening the browser to sign in with Google. If it doesn't open, visit:\n${url}\n`);
    openBrowser(url);
  });
  saveToken(refreshToken);
  const drive = google.drive({ version: "v3", auth: authClient(client, refreshToken) });
  const { data } = await drive.about.get({ fields: "user(emailAddress)" });
  console.log(`Signed in as ${data.user?.emailAddress}. Saved to ${CONFIG_DIR}.`);
}

const commands: Record<string, () => Promise<void>> = { setup, auth };
const [command] = process.argv.slice(2);
const main = command === undefined ? () => serve(version) : commands[command];
if (!main) {
  console.error("Usage: gdocs-artifacts [setup | auth]\nWithout a command, runs the MCP server over stdio.");
  process.exit(1);
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
