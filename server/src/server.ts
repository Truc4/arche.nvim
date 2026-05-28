/*
 * Arche language server.
 *
 * A thin LSP relay over the arche compiler's warm analysis service. It spawns one
 * long-lived `arche-analyzer --serve` process and keeps it warm across edits: the
 * analyzer holds each open document's parsed CST + semantic state (with core.arche
 * and `use` modules parsed once) and answers position-keyed queries. This server
 * only translates LSP ↔ the analyzer's line protocol, so highlighting AND the
 * "explicit view" inlay hints (inferred types, type-alias backing, …) both come
 * from the compiler's single source of truth and track the language automatically.
 *
 * Protocol (newline-delimited; every response ends with a blank line):
 *   UPDATE <bytelen> <path>\n<bytes>   (re)analyze a document, keep it warm
 *   TOKENS <path>\n                     -> `offset length line col CATEGORY` lines
 *   HINTS  <path>\n                     -> `SYN line col side kind text` lines
 *   CLOSE  <path>\n
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  SemanticTokensBuilder,
  InlayHintKind,
  DiagnosticSeverity,
  type Diagnostic,
  type InlayHint,
  type InitializeParams,
  type InitializeResult,
  type SemanticTokens,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

/* Highlighting categories (from the analyzer's TOKENS) → LSP semantic token types. */
const CATEGORY_TO_TYPE: Record<string, string> = {
  keyword: "keyword",
  number: "number",
  string: "string",
  comment: "comment",
  operator: "operator",
  punctuation: "punctuation",
  identifier: "variable",
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

/* file:// URI → filesystem path. The path is the analyzer's document id and is
 * what it resolves `use` modules against; non-file URIs are passed through as an
 * opaque id (the analyzer falls back to cwd for module resolution). */
function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
}

/*
 * Sequential client for the warm analyzer process. Requests are answered FIFO and
 * each response is terminated by a blank line, so we frame stdout by collecting
 * non-empty lines until the blank line, then resolve the head of the queue.
 */
class Analyzer {
  private proc: ChildProcess | null = null;
  private buf = "";
  private queue: Array<{ resolve: (lines: string[]) => void; lines: string[] }> = [];
  private warnedMissing = false;

  constructor(private cmd: string) {}

  private ensure(): boolean {
    if (this.proc) return true;
    try {
      this.proc = spawn(this.cmd, ["--serve"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.warnMissing((err as Error).message);
      return false;
    }
    this.proc.on("error", (err) => this.warnMissing(err.message));
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    // The analyzer prints lints/errors to stderr (and on combined-coord lines); log, don't parse.
    this.proc.stderr!.on("data", (c) => connection.console.log(`arche-analyzer: ${String(c).trim()}`));
    this.proc.on("exit", (code) => {
      connection.console.warn(`arche-analyzer exited (${code}); will respawn on next request`);
      this.proc = null;
      // Fail any in-flight requests so handlers don't hang.
      for (const q of this.queue) q.resolve(q.lines);
      this.queue = [];
      this.buf = "";
    });
    return true;
  }

  private warnMissing(msg: string) {
    if (this.warnedMissing) return;
    this.warnedMissing = true;
    connection.window.showWarningMessage(
      `arche: could not run '${this.cmd}'. Build it from the arche repo (make build/arche-analyzer) ` +
        `and put it on PATH or set initializationOptions.analyzerPath. (${msg})`,
    );
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const cur = this.queue[0];
      if (!cur) continue;
      if (line === "") {
        this.queue.shift();
        cur.resolve(cur.lines);
      } else {
        cur.lines.push(line);
      }
    }
  }

  /* Send a command (a single line) plus optional raw body bytes; resolve with the
   * response's non-empty lines. Resolves empty if the process can't be started. */
  private request(cmdLine: string, body?: Buffer): Promise<string[]> {
    if (!this.ensure()) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.queue.push({ resolve, lines: [] });
      this.proc!.stdin!.write(cmdLine);
      if (body) this.proc!.stdin!.write(body);
    });
  }

  update(path: string, text: string): Promise<string[]> {
    const body = Buffer.from(text, "utf8");
    return this.request(`UPDATE ${body.length} ${path}\n`, body);
  }
  tokens(path: string): Promise<string[]> {
    return this.request(`TOKENS ${path}\n`);
  }
  hints(path: string): Promise<string[]> {
    return this.request(`HINTS ${path}\n`);
  }
  diags(path: string): Promise<string[]> {
    return this.request(`DIAG ${path}\n`);
  }
  close(path: string): void {
    void this.request(`CLOSE ${path}\n`);
  }
}

let analyzer: Analyzer;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const opts = (params.initializationOptions ?? {}) as { analyzerPath?: string };
  const cmd = opts.analyzerPath || process.env.ARCHE_ANALYZER || "arche-analyzer";
  analyzer = new Analyzer(cmd);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      semanticTokensProvider: {
        legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] },
        full: true,
      },
      inlayHintProvider: true,
    },
  };
});

/* Convert one "DIAG line col severity name msg…" line into an LSP Diagnostic.
 * The range is a single-character span at the reported position — enough for
 * nvim to anchor the message; better widths can come once we surface token
 * lengths through the protocol. */
function parseDiagLine(line: string): Diagnostic | null {
  const parts = line.split(" ");
  if (parts[0] !== "DIAG" || parts.length < 6) return null;
  const lineNum = Number(parts[1]) - 1;
  const colNum = Number(parts[2]) - 1;
  const sev = parts[3] === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
  const name = parts[4];
  const message = parts.slice(5).join(" ");
  if (lineNum < 0 || colNum < 0) return null;
  return {
    range: {
      start: { line: lineNum, character: colNum },
      end: { line: lineNum, character: colNum + 1 },
    },
    severity: sev,
    source: "arche",
    code: name,
    message,
  };
}

/* Re-analyze a document and republish its diagnostics. The UPDATE and DIAG
 * requests queue FIFO behind any prior work, so this stays per-document
 * sequential without explicit locking. */
async function refreshDoc(uri: string): Promise<void> {
  const doc = documents.get(uri);
  if (!doc) return;
  const path = uriToPath(uri);
  await analyzer.update(path, doc.getText());
  const lines = await analyzer.diags(path);
  const diagnostics: Diagnostic[] = [];
  for (const line of lines) {
    const d = parseDiagLine(line);
    if (d) diagnostics.push(d);
  }
  connection.sendDiagnostics({ uri, diagnostics });
}

documents.onDidOpen((e) => void refreshDoc(e.document.uri));
documents.onDidChangeContent((e) => void refreshDoc(e.document.uri));
documents.onDidClose((e) => {
  /* Clear stale diagnostics so they don't linger after the file is closed. */
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  analyzer.close(uriToPath(e.document.uri));
});

connection.languages.semanticTokens.on(async (params): Promise<SemanticTokens> => {
  const builder = new SemanticTokensBuilder();
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return builder.build();

  /* Each line: "offset length line col CATEGORY" (1-based line/col, byte length).
   * arche source is ASCII, so byte offsets equal UTF-16 units; multibyte text
   * would need conversion here. */
  for (const line of await analyzer.tokens(uriToPath(params.textDocument.uri))) {
    const parts = line.split(" ");
    if (parts.length < 5) continue;
    const lineNum = Number(parts[2]) - 1;
    const colNum = Number(parts[3]) - 1;
    const length = Number(parts[1]);
    if (lineNum < 0 || colNum < 0 || !Number.isFinite(length)) continue;
    const typeIndex = TOKEN_TYPE_INDEX.get(CATEGORY_TO_TYPE[parts[4]] ?? "") ?? FALLBACK_TYPE_INDEX;
    builder.push(lineNum, colNum, length, typeIndex, 0);
  }
  return builder.build();
});

connection.languages.inlayHint.on(async (params): Promise<InlayHint[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  /* Each line: "SYN line col padL padR kind text...". The analyzer decides the
   * anchor + padding so the rendered virtual text reads as the surrounding
   * longhand (e.g. `r : int = e` slotting the type between `:` and `=`). */
  const hints: InlayHint[] = [];
  for (const line of await analyzer.hints(uriToPath(params.textDocument.uri))) {
    const parts = line.split(" ");
    if (parts[0] !== "SYN" || parts.length < 7) continue;
    const lineNum = Number(parts[1]) - 1;
    const colNum = Number(parts[2]) - 1;
    const padL = parts[3] === "1";
    const padR = parts[4] === "1";
    const kind = parts[5];
    const label = parts.slice(6).join(" ");
    if (lineNum < 0 || colNum < 0) continue;
    hints.push({
      position: { line: lineNum, character: colNum },
      label,
      kind: kind === "param" ? InlayHintKind.Parameter : InlayHintKind.Type,
      paddingLeft: padL,
      paddingRight: padR,
    });
  }
  return hints;
});

documents.listen(connection);
connection.listen();
