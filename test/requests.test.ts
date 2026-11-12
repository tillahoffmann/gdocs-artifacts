// The request shapes the server relies on: revision checks, chips, comments and suggestions.
import { expect, test } from "vitest";
import { bodyText, connect, describeAccounts, findText, firstTab, paragraphs, run } from "./helpers.js";

const end = { endOfSegmentLocation: {} };

describeAccounts((account) => {
  test("a write guarded by a stale revision is rejected", async () => {
    const { createDoc, getDoc, update } = await connect(account);
    const id = await createDoc("revision");
    const { revisionId } = await getDoc(id);
    const res = await update(id, [{ insertText: { location: { index: 1 }, text: "first\n" } }], {
      revision: revisionId!,
    });
    expect(res.commentUpdateState).toBe("NO_UPDATES_REQUESTED");
    await expect(
      update(id, [{ insertText: { location: { index: 1 }, text: "second\n" } }], { revision: revisionId! }),
    ).rejects.toThrow();
    expect(bodyText(await getDoc(id))).toBe("first\n\n");
  });

  test("chips: person, date, rich link, dropdown", async () => {
    const { drive, createDoc, getDoc, update } = await connect(account);
    const { data: about } = await drive.about.get({ fields: "user(emailAddress)" });
    const me = about.user!.emailAddress!;
    const id = await createDoc("chips");

    await update(id, [
      // Our own email, so no one else gets notified.
      { insertPerson: { ...end, personProperties: { email: me } } },
      {
        insertDate: {
          ...end,
          dateElementProperties: { timestamp: "2026-12-01T12:00:00Z", dateFormat: "DATE_FORMAT_ISO8601" },
        },
      },
      { insertRichLink: { ...end, richLinkProperties: { uri: `https://docs.google.com/document/d/${id}/edit` } } },
      // Definition and dropdown in one batch, with our own IDs.
      {
        createDropdownDefinition: {
          dropdownDefinition: {
            dropdownDefinitionId: "kix.status1",
            dropdownDefinitionProperties: {
              title: "Status",
              options: [
                { optionId: "dropdownItem.open", displayValue: "Open" },
                { optionId: "dropdownItem.done", displayValue: "Done" },
              ],
            },
          },
        },
      },
      { insertDropdown: { ...end, dropdownDefinitionId: "kix.status1", selectedOptionId: "dropdownItem.done" } },
    ]);

    const doc = await getDoc(id);
    const elements = paragraphs(doc).flatMap((p) => p.elements ?? []);
    const person = elements.find((pe) => pe.person)?.person?.personProperties;
    expect(person?.email).toBe(me);
    expect(person?.name).toBeTruthy(); // filled in by Google
    expect(elements.find((pe) => pe.dateElement)?.dateElement?.dateElementProperties?.displayText).toBe("2026-12-01");
    const link = elements.find((pe) => pe.richLink)?.richLink?.richLinkProperties;
    expect(link?.title).toBe("gdocs-artifacts test: chips");
    expect(link?.mimeType).toBe("application/vnd.google-apps.kix");
    expect(elements.find((pe) => pe.dropdown)?.dropdown?.dropdownProperties?.displayValue).toBe("Done");
    expect(firstTab(doc).dropdownDefinitions?.["kix.status1"]?.dropdownDefinitionProperties?.title).toBe("Status");

    // Rich links accept only Drive URLs.
    await expect(
      update(id, [{ insertRichLink: { ...end, richLinkProperties: { uri: "https://example.com" } } }]),
    ).rejects.toThrow("The URL is invalid");
  });

  test("comments: insert, reply, resolve, reopen", async () => {
    const { createDoc, getDoc, update } = await connect(account);
    const id = await createDoc("comments");
    await update(id, [{ insertText: { location: { index: 1 }, text: "We will ship to all workspaces in Q3.\n" } }]);
    const range = findText(await getDoc(id), "ship to all workspaces");

    const inserted = await update(id, [{ insertComment: { content: "Which workspaces first?", range } }]);
    expect(inserted.commentUpdateState).toBe("ALL_SAVED");
    const thread = inserted.replies?.[0]?.insertComment?.commentThread;
    expect(thread?.plainTextQuote).toBe("ship to all workspaces");
    const commentId = thread?.commentId;

    await update(id, [{ addCommentReply: { commentId, post: { content: "EU first, then US." } } }]);
    // The action goes inside the post.
    await update(id, [{ addCommentReply: { commentId, post: { content: "Done.", commentAction: "RESOLVE" } } }]);
    let doc = await getDoc(id);
    expect(doc.comments?.[0]?.status).toBe("RESOLVED");
    expect(doc.comments?.[0]?.replies?.map((p) => p.content)).toEqual(["EU first, then US.", "Done."]);

    await update(id, [{ addCommentReply: { commentId, post: { content: "Reopening.", commentAction: "REOPEN" } } }]);
    doc = await getDoc(id);
    expect(doc.comments?.[0]?.status).toBe("OPEN");
  });

  test("suggest mode: one replace is one suggestion, and accepting it applies it", async () => {
    const { createDoc, getDoc, update } = await connect(account);
    const id = await createDoc("suggestions");
    await update(id, [{ insertText: { location: { index: 1 }, text: "Pricing is $20 per seat.\n" } }]);
    const old = findText(await getDoc(id), "$20");

    const res = await update(
      id,
      [{ insertText: { location: { index: old.endIndex }, text: "$25" } }, { deleteContentRange: { range: old } }],
      { mode: "SUGGEST" },
    );
    expect(res.commentUpdateState).toBe("ALL_SAVED");
    let doc = await getDoc(id);
    expect(doc.suggestions).toHaveLength(1);
    const suggestion = doc.suggestions![0]!;
    expect(suggestion.summaryText).toBe("Replace: “$20” with “$25”");
    // Both sides are inline; only the per-run suggestion IDs tell them apart.
    expect(bodyText(doc)).toBe("Pricing is $20$25 per seat.\n\n");
    expect(run(doc, "$20").suggestedDeletionIds).toEqual([suggestion.suggestionId]);
    expect(run(doc, "$25").suggestedInsertionIds).toEqual([suggestion.suggestionId]);

    await update(id, [{ acceptSuggestion: { suggestionId: suggestion.suggestionId } }]);
    doc = await getDoc(id);
    expect(bodyText(doc)).toBe("Pricing is $25 per seat.\n\n");
    expect(doc.suggestions?.[0]?.status).toBe("ACCEPTED");
  });
});
