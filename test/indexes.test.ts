// Docs indexes count UTF-16 code units, like JavaScript string lengths, and a chip takes up one index.
import { describe, expect, test } from "vitest";
import { accounts, connect, findText, paragraphs } from "./helpers.js";

// An emoji (2 code units), a precomposed é (1), CJK (1 each), and e + combining accent (2).
const PREFIX = "😀 é 中文 é ";

describe.skipIf(accounts.length === 0).each(accounts)("%s", (account) => {
  test("indexes match JavaScript string lengths; a chip is one index", async () => {
    const { drive, createDoc, getDoc, update } = await connect(account);
    const { data: about } = await drive.about.get({ fields: "user(emailAddress)" });
    const id = await createDoc("indexes");
    await update(id, [{ insertText: { location: { index: 1 }, text: `${PREFIX}end\n` } }]);
    expect(findText(await getDoc(id), "end").startIndex).toBe(1 + PREFIX.length);

    await update(id, [
      {
        insertPerson: {
          location: { index: 1 + PREFIX.length },
          personProperties: { email: about.user!.emailAddress! },
        },
      },
    ]);
    const doc = await getDoc(id);
    const elements = paragraphs(doc).flatMap((p) => p.elements ?? []);
    for (const pe of elements) {
      const length = pe.textRun ? (pe.textRun.content ?? "").length : 1;
      expect(pe.endIndex! - pe.startIndex!).toBe(length);
    }
    expect(elements.find((pe) => pe.person)?.startIndex).toBe(1 + PREFIX.length);
    expect(findText(doc, "end").startIndex).toBe(1 + PREFIX.length + 1);
    expect(elements[0]?.textRun?.content).toBe(PREFIX);
  });
});
