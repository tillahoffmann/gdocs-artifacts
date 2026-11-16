// Docs built offline, as the Docs API returns them: paragraphs (headings, list items) and tables, with
// suggestions and comments on their text.
import type { docs_v1 } from "googleapis";
import type { Doc } from "./helpers.js";

export type Part = {
  text?: string;
  style?: docs_v1.Schema$TextStyle;
  ins?: string;
  del?: string;
  /** A suggested style change: its ID and the fields it sets. */
  restyle?: [string, docs_v1.Schema$TextStyle];
  element?: object;
  /** What a comment on the part says. */
  comment?: string;
};

/** A suggested change of a paragraph's style: to a heading level (0 for normal text), or of its bullet. */
export type BlockChange = { id: string; heading?: number; bullet?: { list?: string; level: number } | null };

export type Block =
  | {
      parts: Part[];
      heading?: number;
      /** A list item at this level, in `list` (default "list"; "numbered" is a numbered list). */
      level?: number;
      list?: string;
      /** A suggested heading (HEADING_2), with this ID; or another suggested change of the paragraph. */
      suggested?: string | BlockChange;
      /** Suggestions on the paragraph's end: a suggested new paragraph, or a suggested join with the next. */
      end?: { ins?: string; del?: string };
    }
  | { cells: Part[][] }
  | { rows: Part[][][] };

const LEVELS = (glyphType?: string) => ({
  listProperties: { nestingLevels: Array.from({ length: 9 }, () => (glyphType ? { glyphType } : {})) },
});

/** A doc of the blocks, then a paragraph "end". */
export function docOf(blocks: Block[]): Doc {
  let index = 1;
  const comments: { id: string; range: docs_v1.Schema$Range; text: string }[] = [];
  const paragraph = (parts: Part[], extra: docs_v1.Schema$Paragraph = {}, end: Part = {}) => {
    const startIndex = index;
    const elements = [...parts, { ...end, text: "\n" }].map(
      ({ text, style, ins, del, restyle, element, comment }: Part) => {
        const at = index;
        index += text?.length ?? 1;
        if (comment)
          comments.push({ id: `t${comments.length + 1}`, range: { startIndex: at, endIndex: index }, text: comment });
        const common = {
          textStyle: style ?? {},
          ...(ins ? { suggestedInsertionIds: [ins] } : {}),
          ...(del ? { suggestedDeletionIds: [del] } : {}),
          ...(restyle
            ? {
                suggestedTextStyleChanges: {
                  [restyle[0]]: {
                    textStyle: restyle[1],
                    textStyleSuggestionState: Object.fromEntries(
                      Object.keys(restyle[1]).map((k) => [`${k}Suggested`, true]),
                    ),
                  },
                },
              }
            : {}),
        };
        const [kind, value] = Object.entries(element ?? { textRun: { content: text } })[0] ?? [];
        return { startIndex: at, endIndex: index, [kind as string]: { ...value, ...common } };
      },
    );
    return { startIndex, endIndex: index, paragraph: { elements, ...extra } };
  };
  const table = (rows: Part[][][]) => {
    const startIndex = index;
    index++;
    const tableRows = rows.map((cells) => {
      const rowStart = index++;
      const tableCells = cells.map((parts) => ({ startIndex: index++, content: [paragraph(parts)] }));
      return { startIndex: rowStart, tableCells };
    });
    index++;
    return { startIndex, endIndex: index, table: { tableRows } };
  };
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  for (const block of blocks) {
    if ("cells" in block) content.push(table([block.cells]));
    else if ("rows" in block) content.push(table(block.rows));
    else {
      const change: BlockChange | undefined =
        typeof block.suggested === "string" ? { id: block.suggested, heading: 2 } : block.suggested;
      const named = (h: number) => (h ? `HEADING_${h}` : "NORMAL_TEXT");
      content.push(
        paragraph(
          block.parts,
          {
            ...(block.heading ? { paragraphStyle: { namedStyleType: named(block.heading) } } : {}),
            ...(block.level !== undefined
              ? { bullet: { listId: block.list ?? "list", nestingLevel: block.level } }
              : {}),
            ...(change?.heading !== undefined
              ? {
                  suggestedParagraphStyleChanges: {
                    [change.id]: {
                      paragraphStyle: { namedStyleType: named(change.heading) },
                      paragraphStyleSuggestionState: { namedStyleTypeSuggested: true },
                    },
                  },
                }
              : {}),
            ...(change?.bullet !== undefined
              ? {
                  suggestedBulletChanges: {
                    [change.id]: {
                      bullet: change.bullet
                        ? { listId: change.bullet.list ?? "list", nestingLevel: change.bullet.level }
                        : {},
                      bulletSuggestionState: { listIdSuggested: true, nestingLevelSuggested: true },
                    },
                  },
                }
              : {}),
          },
          block.end,
        ),
      );
    }
  }
  content.push(paragraph([{ text: "end" }]));
  const commentAnchors = Object.fromEntries(comments.map((c) => [c.id, { ranges: [c.range] }]));
  return {
    revisionId: "r",
    tabs: [
      {
        documentTab: {
          body: { content },
          commentAnchors,
          lists: { list: LEVELS(), other: LEVELS(), numbered: LEVELS("DECIMAL") },
        },
      },
    ],
    comments: comments.map((c) => ({
      commentId: c.id,
      anchorId: c.id,
      status: "OPEN",
      headPost: { author: { displayName: "Ann" }, content: c.text },
    })),
  } as Doc;
}
