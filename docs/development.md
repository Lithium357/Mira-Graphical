# Development

## Build and run

Requires Node **22.12+**, pnpm **11.25.0**, and VS Code **1.96+**. Windows is the development/test platform; Linux and macOS releases have not been verified. Install requires internet access for packages and Electron; normal editing runs offline.

```powershell
git clone https://github.com/Lithium357/Mira-Graphical.git
cd Mira-Graphical
pnpm install
pnpm run licenses
pnpm build
pnpm exec electron .
```

The app shares the current working directory. For another project, run `pnpm exec electron . "--workspace=C:\path\to\your\project"`. Leave the separate desktop window running. Electron downloads its binary the first time it runs if necessary. `pnpm dev` builds and launches in one step.

To run the companion extension from source:

1. Open this repository folder in VS Code.
2. Press **F5**, choosing **Mira: Extension Development Host** if prompted. This loads the built extension in a separate VS Code window.
3. In that window, open the same project folder selected for the graph app, and open a `.v`, `.sv`, `.vhd` or `.vhdl` file.
4. Run **RTL Graph: Open Current Module** from the command palette or editor context menu.

Only explicitly shared documents participate. Use **RTL Graph: Connect/Disconnect** to disconnect; use **RTL Graph: Show Sync Status** for details. After a service restart, reconnect and run Open Current Module again to negotiate the current buffer. One desktop workspace and one VS Code adapter connection are supported at a time, with multiple shared document sessions. The unsigned Windows installer is available; Marketplace publishing and signing remain separate.

To use the packaged companion, run `pnpm package:extension`, then choose **Extensions: Install from VSIX…** in VS Code and select `dist/packages/mira-graphical-0.8.0.vsix`. Keep the desktop app running for the same workspace and share a `.v`, `.sv`, `.vhd` or `.vhdl` file with Open Current Module. The official [VS Code packaging tool](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions) creates the unsigned VSIX; this does not publish to the Marketplace or create/sign a desktop installer. CI uploads the VSIX with its test artifacts. **Setup help** in the app shows workspace, connection status and troubleshooting. See [distribution and checksum verification](distribution.md) and [external-project compatibility limits](compatibility.md).

## Commands and tests

```powershell
pnpm lint       # strict TypeScript check
pnpm test       # unit + authenticated localhost protocol integration
pnpm run licenses # locked installed dependency licenses + full notices
pnpm build      # desktop UI, core and bundled VS Code extension
pnpm smoke      # desktop + isolated VSIX install + two real editor passes
pnpm package:extension # build an unsigned installable VSIX
pnpm package:windows   # build the unsigned Windows installer from a clean commit
pnpm test:reference # Verilog differential test; requires Icarus Verilog in PATH
pnpm test:languages # VHDL/SystemVerilog differential test; requires GHDL and Icarus
pnpm audit      # online dependency vulnerability check
pnpm format:check # consistent source and documentation formatting
```

The smoke runner uses actual 15-second timers, writes to isolated test workspaces, captures the desktop canvas in `test-results/desktop-smoke.png`, and writes JSON results. It downloads an isolated official VS Code test runtime on first run and uses separate user data. It does not change your installed VS Code, settings or source files. Set `MIRA_CODE_EXE` to use a particular executable. A graphical desktop session and permission to bind loopback sockets are required. See [test coverage and remaining manual checks](testing.md).

## Repository map

- `packages/protocol`: versioned messages, validation, operator/patch types.
- `packages/core`: scheduler, arbitration, recovery, identities/layout and local service.
- `packages/verilog`: Chevrotain lexer, restricted parser, graph projection and exact token patches.
- `packages/vhdl`: native typed VHDL frontend and source construction adapter.
- `apps/graph`: Electron shell, secured preload, React Flow canvas and inspector.
- `extensions/vscode`: unsaved document sharing and guarded native WorkspaceEdit patches.
- `tests`, `fixtures`, `scripts`: fake-clock tests, protocol fixtures and real-app smoke runners.
- `docs`: design decisions, syntax, tests, dependency licenses and third-party notices.

Dependency licenses are audited from the actual installed dependency closure. Generated notices retain MIT/BSD/ISC/Apache/MPL terms; dual licenses use their permissive option. The Windows distribution includes Electron and Chromium notices alongside project and dependency licenses. See [license audit notes](licenses.md).
