# arche.nvim

Editor support for the [Arche](https://github.com/Truc4/arche) language in
Neovim — driven by the **arche compiler's own CST + semantics**, so it always
matches the language instead of drifting like a separately-maintained grammar.

It is a small LSP server backed by the compiler's warm analysis service. It gives:

- **Semantic-token highlighting** — types, fields, calls, parameters and variables
  distinguished from arche's real concrete syntax tree, not pattern guesses.
- **"Explicit view" inlay hints** — the implicit information the compiler infers,
  shown inline as virtual text (dim, never in the buffer). Hints anchor at the
  real CST tokens, so the rendered view reads as the longhand: `r := e` shows as
  `r : int = e` (type slotted between the `:` and `=`); alias use as
  `a: count (int) = 10`; call sites as gopls-style `add(a: 1, b: 2)` with an
  `own` prefix when the parameter takes ownership.
- **Diagnostics** — semantic errors and lints from the compiler, surfaced via
  `vim.diagnostic` with the lint name as the code.

> Replaces the old tree-sitter grammar. See the design write-up in the arche repo:
> `docs/LOSSLESS_CST.md`.

## How it works

```
arche source ─▶ arche-analyzer --serve ─▶ arche.nvim LSP server ─▶ Neovim
                (warm: parses core + use-modules    (server/,        (semantic tokens
                 once, holds per-doc CST+semantics,   TypeScript       + inlay hints)
                 answers TOKENS / HINTS queries)      relay)
```

`arche-analyzer` is built from the arche compiler and reuses its lexer, parser and
semantic analysis, so new keywords / constructs / inferred facts flow through with
no changes here. One long-lived process stays warm across edits.

## Requirements

- Neovim 0.10+ (built-in LSP semantic tokens + inlay hints)
- `node` (runs the bundled server)
- `arche-analyzer` on your `PATH` — build it from the arche repo:
  ```sh
  cd /path/to/arche && make build/arche-analyzer
  # then put build/arche-analyzer on PATH, or pass analyzer_path (see Setup)
  ```

## Install

Build the server once (it ships as TypeScript):

```sh
cd arche.nvim/server && npm install && npm run build
```

Then with [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "Truc4/arche.nvim",
  build = "cd server && npm install && npm run build",
  ft = "arche",
  opts = {
    -- analyzer_path = "/path/to/arche/build/arche-analyzer", -- if not on PATH
  },
}
```

Or any plugin manager — the plugin auto-starts on `arche` files.

## Setup

`require("arche").setup{}` is called automatically with defaults. Re-call it to
customise (idempotent):

| option          | type    | default                        | meaning                                            |
|-----------------|---------|--------------------------------|----------------------------------------------------|
| `analyzer_path` | string  | `nil` (uses `arche-analyzer` on PATH) | path to the `arche-analyzer` binary         |
| `cmd`           | table   | bundled `node server/out/server.js --stdio` | override the server launch command   |
| `highlights`    | boolean | `true`                         | set default `@lsp.type.*` + inlay-hint links       |
| `inlay_hints`   | boolean | `true`                         | enable inlay hints on attach                       |

## Highlight groups

The server's semantic-token types map to: `@keyword`, `@string`, `@number`,
`@comment`, `@operator`, `Delimiter` (punctuation), `@variable`, `@type`,
`@property`, `@function`, `@variable.parameter`. All links are set with
`default = true`, so your colorscheme wins.
