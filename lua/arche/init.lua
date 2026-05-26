-- arche.nvim — syntax highlighting for the Arche language.
--
-- Highlighting is driven by an LSP server (server/out/server.js) that emits
-- semantic tokens derived from the arche compiler's own lossless CST, via the
-- `arche-cst-tokens` binary. It therefore tracks the language automatically
-- instead of being a separately-maintained grammar.
--
-- Requirements:
--   * node (to run the bundled server)
--   * `arche-cst-tokens` on PATH, or pass `tokens_path` to setup().
--     Build it from the arche repo: `make build/arche-cst-tokens`.

local M = {}

-- Root of this plugin (…/arche.nvim), derived from this file's path.
local function plugin_root()
  local src = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(src, ":h:h:h") -- lua/arche/init.lua -> plugin root
end

local function default_cmd()
  return { "node", plugin_root() .. "/server/out/server.js", "--stdio" }
end

-- Map the server's semantic-token types to highlight groups. Most standard
-- types Neovim auto-links; we set them all with `default = true` so themes and
-- user config still win, and so the non-standard `punctuation` type renders.
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
end

-- opts:
--   cmd          (table)  override the server launch command
--   tokens_path  (string) path to the arche-cst-tokens binary (else server uses PATH)
--   highlights   (bool)   set default @lsp.type.* links (default true)
function M.setup(opts)
  opts = opts or {}

  if opts.highlights ~= false then
    apply_highlights()
  end

  local cmd = opts.cmd or default_cmd()
  local init_options = opts.tokens_path and { tokensPath = opts.tokens_path } or nil

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
      }, { bufnr = ev.buf })
    end,
  })
end

return M
