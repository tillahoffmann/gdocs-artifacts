// Markdown import through Drive: what create_doc can rely on, and what it must convert itself.
import { expect, test } from "vitest";
import { bodyText, connect, describeAccounts, firstTab, paragraph, run } from "./helpers.js";

const MARKDOWN = `# Heading 1

## Heading 2

Some **bold**, *italic*, ~~strike~~, \`code\` and a [link](https://example.com).

- bullet
  - nested bullet

1. first
2. second

- [ ] open task
- [x] done task

| A | B |
| --- | --- |
| 1 | 2 |

{++added++} {==highlight==}{>>a comment<<}

@[Jane Doe](mailto:jane@example.com) {{date:2026-12-01}}
`;

describeAccounts((account) => {
  test("text/markdown imports as a Google Doc", async () => {
    const { drive } = await connect(account);
    const { data } = await drive.about.get({ fields: "importFormats" });
    expect(data.importFormats?.["text/markdown"]).toContain("application/vnd.google-apps.document");
  });

  test("Markdown structure survives the import; our own syntax arrives as literal text", async () => {
    const { drive, createDoc, getDoc } = await connect(account);
    const id = await createDoc("markdown import", MARKDOWN);
    const doc = await getDoc(id);
    const tab = firstTab(doc);

    expect(paragraph(doc, "Heading 1").paragraphStyle?.namedStyleType).toBe("HEADING_1");
    expect(paragraph(doc, "Heading 2").paragraphStyle?.namedStyleType).toBe("HEADING_2");
    expect(run(doc, "bold").textStyle?.bold).toBe(true);
    expect(run(doc, "italic").textStyle?.italic).toBe(true);
    expect(run(doc, "strike").textStyle?.strikethrough).toBe(true);
    expect(run(doc, "code").textStyle?.weightedFontFamily?.fontFamily).toBe("Roboto Mono");
    expect(run(doc, "link").textStyle?.link?.url).toBe("https://example.com");

    expect(paragraph(doc, "nested bullet").bullet?.nestingLevel).toBe(1);
    const numbered = paragraph(doc, "first").bullet;
    expect(tab.lists?.[numbered?.listId ?? ""]?.listProperties?.nestingLevels?.[0]?.glyphType).toBe("DECIMAL");
    expect(paragraph(doc, "done task").bullet).toBeDefined();

    const table = tab.body?.content?.find((el) => el.table)?.table;
    const cells = table?.tableRows?.map((r) =>
      r.tableCells?.map((c) =>
        c.content?.map((el) => el.paragraph?.elements?.map((pe) => pe.textRun?.content).join("")).join(""),
      ),
    );
    expect(cells).toEqual([
      ["A\n", "B\n"],
      ["1\n", "2\n"],
    ]);

    // CriticMarkup and our tokens are not interpreted: no comments, suggestions or chips.
    expect(bodyText(doc)).toContain("{++added++} {==highlight==}{>>a comment<<}");
    expect(bodyText(doc)).toContain("{{date:2026-12-01}}");
    expect(doc.comments ?? []).toEqual([]);
    expect(doc.suggestions ?? []).toEqual([]);
    expect(bodyText(doc)).not.toMatch(/\[(person|dateElement)\]/);
    expect(run(doc, "Jane Doe").textStyle?.link?.url).toBe("mailto:jane@example.com");

    // The Docs API has no field for a checklist item's checked state; the Markdown export does.
    const { data: exported } = await drive.files.export(
      { fileId: id, mimeType: "text/markdown" },
      { responseType: "text" },
    );
    expect(exported).toContain("- [ ] open task");
    expect(exported).toContain("- [x] done task");
  });
});
