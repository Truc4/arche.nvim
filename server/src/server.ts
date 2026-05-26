/*
 * Arche language server.
 *
 * Highlighting is derived entirely from the arche compiler's own lexer: this
 * server is a thin translator. For each document it pipes the (possibly
 * unsaved) buffer into the `arche-tokens` binary, which prints one token per
 * line as `offset length line col CATEGORY`, and re-encodes those as LSP
 * semantic tokens. Because the lexer is the single source of truth, the
 * highlighting tracks the language automatically as arche evolves.
 */
import { spawn } from "node:child_process";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  SemanticTokensBuilder,
  type InitializeParams,
  type InitializeResult,
  type SemanticTokens,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

/*
 * Categories emitted by arche-tokens, mapped to LSP semantic token types.
 * Most map to standard types that editors already theme; `identifier` maps to
 * `variable`. Unknown (future) categories fall back to `variable` so a new
 * token kind still renders sensibly before anyone touches this file.
 */
const CATEGORY_TO_TYPE: Record<string, string> = {
  keyword: "keyword",
  number: "number",
  string: "string",
  comment: "comment",
  operator: "operator",
  punctuation: "punctuation",
  identifier: "variable",
  // CST-derived identifier roles (from arche-cst-tokens)
  variable: "variable",
  type: "type",
  property: "property",
  function: "function",
  parameter: "parameter",
};

const TOKEN_TYPES: string[] = [
  "keyword",
  "number",
  "string",
  "comment",
  "operator",
  "punctuation",
  "variable",
  "type",
  "property",
  "function",
  "parameter",
];
const TOKEN_TYPE_INDEX = new Map(TOKEN_TYPES.map((t, i) => [t, i]));
const FALLBACK_TYPE_INDEX = TOKEN_TYPE_INDEX.get("variable")!;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/* Resolved on initialize; defaults to the binary on PATH. */
let tokensPath = "arche-cst-tokens";
let warnedMissingBinary = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const opts = (params.initializationOptions ?? {}) as { tokensPath?: string };
  tokensPath = opts.tokensPath || process.env.ARCHE_CST_TOKENS || "arche-cst-tokens";

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      semanticTokensProvider: {
        legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] },
        full: true,
      },
    },
  };
});

/* Run arche-tokens over `text`, piping it via stdin. Resolves to its stdout. */
function runArcheTokens(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tokensPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.on("error", reject);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (code !== 0 && stderr) {
        connection.console.warn(`arche-tokens exited ${code}: ${stderr.trim()}`);
      }
      resolve(stdout);
    });

    child.stdin.write(text);
    child.stdin.end();
  });
}

connection.languages.semanticTokens.on(async (params): Promise<SemanticTokens> => {
  const builder = new SemanticTokensBuilder();
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return builder.build();
  }

  let output: string;
  try {
    output = await runArcheTokens(doc.getText());
  } catch (err) {
    if (!warnedMissingBinary) {
      warnedMissingBinary = true;
      connection.window.showWarningMessage(
        `arche: could not run '${tokensPath}'. Build it from the arche repo (make arche-tokens) ` +
          `and put it on PATH or set initializationOptions.tokensPath. (${(err as Error).message})`,
      );
    }
    return builder.build();
  }

  /*
   * Each line: "offset length line col CATEGORY". We use 1-based line/col from
   * the lexer (converted to 0-based) and the byte length directly. arche source
   * is ASCII, so byte offsets equal UTF-16 units; multibyte text would need
   * conversion here.
   */
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split(" ");
    if (parts.length < 5) continue;

    const lineNum = Number(parts[2]) - 1;
    const colNum = Number(parts[3]) - 1;
    const length = Number(parts[1]);
    const category = parts[4];
    if (lineNum < 0 || colNum < 0 || !Number.isFinite(length)) continue;

    const typeIndex = TOKEN_TYPE_INDEX.get(CATEGORY_TO_TYPE[category] ?? "") ?? FALLBACK_TYPE_INDEX;
    builder.push(lineNum, colNum, length, typeIndex, 0);
  }

  return builder.build();
});

documents.listen(connection);
connection.listen();
