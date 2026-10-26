# Editors beyond VS Code

Mira's **LSP companion** connects open HDL buffers from other editors to the desktop app. Start Mira for your project first, then enable this companion in the editor for the **same project root**. Only buffers opened by that client are shared; Mira does not scan your project or save your source files. One editor connection can own the workspace at a time, so disconnect the VS Code companion before connecting another client.

| Editor/client                                            | Mode                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neovim built-in LSP                                      | Two-way live buffers and versioned graph edits with native Undo                                                                                   |
| Vim with `prabirshrestha/vim-lsp`                        | Two-way live buffers and versioned graph edits with native Undo                                                                                   |
| Notepad++ with NppLspClient                              | Live buffers, graph viewing, layout and simulation; graph editing disabled                                                                        |
| Other LSP clients (for example Emacs Eglot, Sublime LSP) | Capability-based: two-way when versioned workspace edits are supported; otherwise live viewing. These clients need their own integration testing. |

Notepad++'s NppLspClient currently advertises `workspace.applyEdit: false` and `workspaceEdit.documentChanges: false`, and refuses `workspace/applyEdit` requests. Mira honors those capabilities rather than writing around the editor's buffer. Notepad++ without an LSP plugin and editors without LSP support are not connected by this companion.

## Locate the companion

In Mira, open **Setup help → Vim, Neovim, Notepad++ and other editors → Show other editor setup…**. Packaged installations include `resources/editors/mira-lsp.cjs`, launchers and these instructions. The launchers use the app's bundled runtime; a separate Node installation is unnecessary.

- **Debian:** `/opt/Mira Graphical/resources/editors/mira-lsp.sh`; launch as `sh '/opt/Mira Graphical/resources/editors/mira-lsp.sh'`.
- **Windows:** `<Mira installation>\resources\editors\mira-lsp.cmd`; launch through `cmd.exe /d /s /c ""<full path>\mira-lsp.cmd""`.
- **Source builds:** after `pnpm build`, use `node /absolute/path/to/Mira-Graphical/dist/editors/mira-lsp.cjs --stdio` with Node 24.

These commands speak LSP on standard input/output and are launched by your editor, not an additional desktop window. Use absolute paths. Do not put a connection token in editor configuration; the companion reads the selected project's local descriptor and reconnects after Mira restarts. Pending graph patches are never replayed across connections.

## Neovim

From your project directory, with Neovim's built-in LSP support, add a filetype autocmd to `init.lua`. This uses `vim.lsp.start` (Neovim 0.9+) and can coexist with a separate HDL completion/lint server:

```lua
vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'verilog', 'systemverilog', 'vhdl' },
  callback = function()
    vim.lsp.start({
      name = 'mira-graphical',
      cmd = { 'sh', '/opt/Mira Graphical/resources/editors/mira-lsp.sh' },
      root_dir = vim.fn.getcwd(), -- the exact folder selected in Mira
    })
  end,
})
```

On Windows, replace `cmd` with `{ 'cmd.exe', '/d', '/c', 'C:\\path\\to\\Mira Graphical\\resources\\editors\\mira-lsp.cmd' }`. Reopen the HDL buffer after changing configuration. Undo uses your normal `u` command; saving remains your decision.

## Vim

Install [vim-lsp](https://github.com/prabirshrestha/vim-lsp) using your preferred plugin manager, then register Mira in your vimrc. Start Vim in the project folder, or use `:lcd` to select it before connecting:

```vim
augroup mira_lsp
  autocmd!
  autocmd User lsp_setup call lsp#register_server({
        \ 'name': 'mira-graphical',
        \ 'cmd': {info -> ['sh', '/opt/Mira Graphical/resources/editors/mira-lsp.sh']},
        \ 'root_uri': {info -> lsp#utils#path_to_uri(getcwd())},
        \ 'allowlist': ['verilog', 'systemverilog', 'vhdl'],
        \ })
augroup END
```

For Windows, use `['cmd.exe', '/d', '/c', 'C:\path\to\Mira Graphical\resources\editors\mira-lsp.cmd']` for the command list. This requires Vim's job/channel support and the LSP plugin; plain legacy Vim without those features is unsupported.

## Notepad++

Install [NppLspClient](https://github.com/Ekopalypse/NppLspClient) for a supported Notepad++ version. Use **Folder as Workspace** to open the exact folder selected in Mira, then open the plugin's configuration. Its TOML configuration associates server commands with Notepad++ language names. For example:

```toml
[lspservers.verilog]
mode = "io"
executable = 'C:\Windows\System32\cmd.exe'
args = '/d /s /c ""C:\path\to\Mira Graphical\resources\editors\mira-lsp.cmd""'
auto_start_server = false
```

Replace the installation path, then use **Start server for current language**. For VHDL or a custom SystemVerilog language, use that language's exact configuration key as documented by the plugin. Edits, including unsaved changes, update the circuit after Mira's normal 15-second delay. Viewing and simulation work; graph-side source editing requires a client that supports versioned edits. The plugin's own [setup notes and reload limitations](https://github.com/Ekopalypse/NppLspClient/blob/main/tips.md) still apply. Do not use cloned buffers with that plugin.

## Behavior and troubleshooting

- The companion provides synchronization, not HDL completion, formatting or a full language implementation. It uses Mira's existing supported HDL subset.
- Source positions use UTF-16, including files with Unicode comments and CRLF line endings. Full-buffer synchronization is requested; well-formed incremental changes are also accepted.
- Graph patches are independently replayed/validated before a versioned `workspace/applyEdit`. Mira acknowledges them only after both the client's successful response and the actual updated buffer arrive. A refusal, mismatch or timeout retains a conflict/recovery snapshot.
- A client must advertise both `workspace.applyEdit` and `workspace.workspaceEdit.documentChanges` for graph editing. Set `initializationOptions.readOnly = true` to request live viewing deliberately. The app visibly labels that connection and blocks writes in the core as well as the UI.
- If no graph appears, check the LSP log and project root. Mira's `.hdlgraph/connection.json` belongs to that project and contains local credentials; do not share or commit it. Files outside the project and non-file/untitled URIs are refused.
- After a conflict, restart/reopen the LSP connection to negotiate the current buffer. Use Mira's Recovery panel to copy recovered text; opening a recovered copy directly in the editor remains a VS Code companion feature.

The automated editor tests run real Vim/vim-lsp and Neovim processes and check unsaved changes, graph edits, native Undo and unchanged disk contents. Notepad++'s read-only negotiation is covered by protocol tests and its documented client capabilities; that does not claim a human Notepad++ walkthrough.
