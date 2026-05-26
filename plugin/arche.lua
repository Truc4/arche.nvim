-- Auto-load: start the Arche language server on `arche` buffers with defaults.
-- Re-call require("arche").setup{...} from your config to customise (e.g. set
-- tokens_path or a custom server cmd); setup() is idempotent.
if vim.g.loaded_arche then
  return
end
vim.g.loaded_arche = true

require("arche").setup()
