// Google Picker through the sign-in flow: picking a doc the app didn't create grants the existing token access
// to it. Interactive, so it only runs with GDOCS_PICKER=1. Before running, create a doc by hand in each account;
// set GDOCS_PICKER_DOC to its ID to also check it's inaccessible before picking, with the Picker filtered to it.
import { describe, expect, test } from "vitest";
import { PICKER_PARAMS, signIn } from "../src/auth.js";
import { accounts, bodyText, connect, oauthClient, openInBrowser } from "./helpers.js";

const interactive = process.env.GDOCS_PICKER === "1";

describe.skipIf(!interactive || accounts.length === 0).each(accounts)("%s", (account) => {
  test("a picked doc becomes readable and writable with the existing token", async () => {
    // The token from .env, not the one the Picker flow returns.
    const { getDoc, update } = await connect(account);
    const known = process.env.GDOCS_PICKER_DOC;
    if (known) await expect(getDoc(known)).rejects.toThrow();

    const { redirect } = await signIn(
      oauthClient(account),
      openInBrowser(account, "Pick a doc you created by hand"),
      known ? { ...PICKER_PARAMS, file_ids: known } : PICKER_PARAMS,
    );
    const picked = redirect.get("picked_file_ids")?.split(",") ?? [];
    expect(picked.length).toBeGreaterThan(0);
    const documentId = picked[0]!;
    if (known) expect(documentId).toBe(known);
    const before = bodyText(await getDoc(documentId));
    await update(documentId, [{ insertText: { location: { index: 1 }, text: "picker test " } }]);
    expect(bodyText(await getDoc(documentId))).toBe(`picker test ${before}`);
    await update(documentId, [{ deleteContentRange: { range: { startIndex: 1, endIndex: 13 } } }]);
    expect(bodyText(await getDoc(documentId))).toBe(before);
  });
});
