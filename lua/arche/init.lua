-- arche.nvim — editor support for the Arche language.
--
-- Driven by an LSP server (server/out/server.js) that relays to the arche
-- compiler's warm analysis service (`arche-analyzer --serve`). It provides
-- semantic-token highlighting and "explicit view" inlay hints (inferred types,
-- type-alias backing, …) — both from the compiler's own CST + semantics, so they
-- track the language instead of drifting like a separate grammar.
--
-- Requirements:
--   * node (to run the bundled server)
--   * `arche-analyzer` on PATH, or pass `analyzer_path` to setup().
--     Build it from the arche repo: `make build/arche-analyzer`.

local M = {}

-- Root of this plugin (…/arche.nvim), derived from this file's path.
local function plugin_root()
  local src = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(src, ":h:h:h") -- lua/arche/init.lua -> plugin root
end

local function default_cmd()
  return { "node", plugin_root() .. "/server/out/server.js", "--stdio" }
end

-- Map the server's semantic-token types to highlight groups, and style inlay
-- hints so the synthetic (implicit) text reads as not-real. All set with
-- `default = true` so themes and user config still win.
local function apply_highlights()
  local links = {
    keyword = "@keyword",
    string = "@string",
    number = "@number",
    comment = "@comment",
    operator = "@operator",
    punctuation = "Delimiter",
    variable = "@variable",
    type = "@type",
    property = "@property",
    ["function"] = "@function",
    parameter = "@variable.parameter",
  }
  for tok, group in pairs(links) do
    vim.api.nvim_set_hl(0, "@lsp.type." .. tok, { link = group, default = true })
  end
  -- Inlay hints are virtual text (they never enter the buffer): dim + italic so
  -- the "written-longhand" explicit view is clearly synthetic.
  vim.api.nvim_set_hl(0, "LspInlayHint", { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, "@arche.implicit", { link = "LspInlayHint", default = true })
end

-- Buffer-local goto keymaps. The server advertises definition / type-definition / implementation /
-- declaration providers (all backed by the compiler's real resolution), but the default LSP maps for
-- these vary across nvim versions — bind them explicitly so `gd` & co. work everywhere.
local function set_goto_keymaps(bufnr)
  local map = function(lhs, fn, desc)
    vim.keymap.set("n", lhs, fn, { buffer = bufnr, silent = true, desc = desc })
  end
  map("gd", vim.lsp.buf.definition, "Arche: goto definition")
  map("gD", vim.lsp.buf.declaration, "Arche: goto declaration")
  map("gy", vim.lsp.buf.type_definition, "Arche: goto type definition")
  map("gri", vim.lsp.buf.implementation, "Arche: goto implementation")
end

-- Enable inlay hints for a buffer across the nvim 0.10/0.11 API shapes.
local function enable_inlay_hints(bufnr)
  local ih = vim.lsp.inlay_hint
  if not ih then
    return
  end
  -- 0.10.0+: enable(enable, filter); older 0.10 nightly: enable(bufnr, enable).
  local ok = pcall(function()
    ih.enable(true, { bufnr = bufnr })
  end)
  if not ok then
    pcall(function()
      ih.enable(bufnr, true)
    end)
  end
end

-- opts:
--   cmd            (table)  override the server launch command
--   analyzer_path  (string) path to the arche-analyzer binary (else server uses PATH)
--   highlights     (bool)   set default @lsp.type.* + inlay-hint links (default true)
--   inlay_hints    (bool)   enable inlay hints on attach (default true)
function M.setup(opts)
  opts = opts or {}

  if opts.highlights ~= false then
    apply_highlights()
  end

  local cmd = opts.cmd or default_cmd()
  local init_options = opts.analyzer_path and { analyzerPath = opts.analyzer_path } or nil
  local want_hints = opts.inlay_hints ~= false

  local group = vim.api.nvim_create_augroup("ArcheLsp", { clear = true })
  vim.api.nvim_create_autocmd("FileType", {
    group = group,
    pattern = "arche",
    callback = function(ev)
      local fname = vim.api.nvim_buf_get_name(ev.buf)
      local root = vim.fs.root and vim.fs.root(ev.buf, { ".git", "Makefile" })
      root = root or (fname ~= "" and vim.fs.dirname(fname)) or vim.loop.cwd()
      vim.lsp.start({
        name = "arche-ls",
        cmd = cmd,
        root_dir = root,
        init_options = init_options,
        on_attach = function(_, bufnr)
          set_goto_keymaps(bufnr)
          if want_hints then
            enable_inlay_hints(bufnr)
          end
        end,
      }, { bufnr = ev.buf })
    end,
  })
end

return M
