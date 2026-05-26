# arche.nvim

Syntax highlighting for the [Arche](https://github.com/Truc4/arche) language in
Neovim — driven by the **arche compiler's own lossless CST**, so it always matches
the language instead of drifting like a separately-maintained grammar.

It is a small LSP server that emits [semantic tokens](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_semanticTokens),
which Neovim renders natively. Types, fields, function calls, parameters and
variables are distinguished because they come from arche's real concrete syntax
tree, not from pattern guesses.

> Replaces the old tree-sitter grammar. See the design write-up in the arche repo:
> `docs/LOSSLESS_CST.md`.

## How it works

```
arche source ─▶ arche-cst-tokens ─▶ arche.nvim LSP server ─▶ Neovim semantic tokens
                (in the arche repo,    (server/, TypeScript)     (@lsp.type.* groups)
                 walks the lossless CST)
```

`arche-cst-tokens` is built from the arche compiler and reuses its lexer + parser,
so new keywords/constructs in the language flow through to highlighting with no
changes here.

## Requirements

- Neovim 0.10+ (built-in LSP semantic tokens)
- `node` (runs the bundled server)
- `arche-cst-tokens` on your `PATH` — build it from the arche repo:
  ```sh
  cd /path/to/arche && make build/arche-cst-tokens
  # then put build/arche-cst-tokens on PATH, or pass tokens_path (see Setup)
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
    -- tokens_path = "/path/to/arche/build/arche-cst-tokens", -- if not on PATH
  },
}
```

Or any plugin manager — the plugin auto-starts on `arche` files.

## Setup

`require("arche").setup{}` is called automatically with defaults. Re-call it to
customise (idempotent):

| option        | type    | default                        | meaning                                            |
|---------------|---------|--------------------------------|----------------------------------------------------|
| `tokens_path` | string  | `nil` (uses `arche-cst-tokens` on PATH) | path to the `arche-cst-tokens` binary    |
| `cmd`         | table   | bundled `node server/out/server.js --stdio` | override the server launch command   |
| `highlights`  | boolean | `true`                         | set default `@lsp.type.*` → highlight-group links  |

## Highlight groups

The server's semantic-token types map to: `@keyword`, `@string`, `@number`,
`@comment`, `@operator`, `Delimiter` (punctuation), `@variable`, `@type`,
`@property`, `@function`, `@variable.parameter`. All links are set with
`default = true`, so your colorscheme wins.
