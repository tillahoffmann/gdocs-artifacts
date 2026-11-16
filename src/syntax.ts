// docmd's {{…}} tokens for the Markdown parser: each becomes an mdast `html` node holding its source, as the
// renderer emits them. (CriticMarkup is read before Markdown, as its spec says; see critic.ts.) The renderer
// escapes every literal `{`, so doc text never parses as one.
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Code, Construct, Extension, State } from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    docmdMarkup: "docmdMarkup";
  }
}

const code = (s: string) => [...s].map((c) => c.charCodeAt(0));
const BACKSLASH = 92;
const CLOSE_BRACE = 125;
const isLineEnding = (c: Code) => c === null || c === -5 || c === -4 || c === -3;

/** `open`, then any text on one line with backslash escapes, then `close`. Fields escape every `}` of their
 * own, so the first unescaped `}` belongs to `close`. */
function enclosed(open: string, close: string): Construct {
  const opening = code(open);
  const before = code(close.slice(0, close.indexOf("}")));
  const after = code(close.slice(close.indexOf("}") + 1));
  return {
    name: "docmdEnclosed",
    tokenize(effects, ok, nok) {
      let i = 0;
      const recent: Code[] = [];
      const start: State = (c) => {
        if (c !== opening[i]) return nok(c);
        if (i === 0) effects.enter("docmdMarkup");
        effects.consume(c);
        return ++i === opening.length ? inside : start;
      };
      const inside: State = (c) => {
        if (isLineEnding(c)) return nok(c);
        if (c === CLOSE_BRACE) {
          const tail = recent.slice(recent.length - before.length);
          if (tail.length < before.length || tail.some((b, k) => b !== before[k])) return nok(c);
          effects.consume(c);
          i = 0;
          return closing;
        }
        effects.consume(c);
        if (c === BACKSLASH) return escaped;
        recent.push(c);
        return inside;
      };
      const closing: State = (c) => {
        if (i === after.length) {
          effects.exit("docmdMarkup");
          return ok(c);
        }
        if (c !== after[i]) return nok(c);
        effects.consume(c);
        i++;
        return closing;
      };
      const escaped: State = (c) => {
        if (isLineEnding(c)) return nok(c);
        effects.consume(c);
        recent.push(null);
        return inside;
      };
      return start;
    },
  };
}

const constructs = (...cs: Construct[]) => cs;

/** The micromark syntax extension. */
export const docmdSyntax: Extension = { text: { 123: constructs(enclosed("{{", "}}")) } };

/** The mdast extension: each piece of markup is an `html` node with its source. */
export const docmdFromMarkdown: FromMarkdownExtension = {
  enter: {
    docmdMarkup(token) {
      this.enter({ type: "html", value: "" }, token);
    },
  },
  exit: {
    docmdMarkup(token) {
      const node = this.stack.at(-1);
      if (node?.type === "html") node.value = this.sliceSerialize(token);
      this.exit(token);
    },
  },
};
