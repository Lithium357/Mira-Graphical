# Mira Graphical

A local, bidirectional Verilog graph companion. Write RTL in VS Code; inspect and change supported operators in a separate desktop window. Semantic edits synchronize after **15 seconds of inactivity**. Original code is **GPL-3.0-only**.

Version 0.2.0 includes the Milestone 0/1 foundation and the first Milestone 2 combinational editing features. It is an RTL expression viewer/editor for a documented subset, not a synthesized schematic or general SystemVerilog IDE.

## Install and run

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
3. In that window, open the same project folder selected for the graph app, and open a `.v` file.
4. Run **RTL Graph: Open Current Module** from the command palette or editor context menu.

Only explicitly shared documents participate. Use **RTL Graph: Connect/Disconnect** to disconnect; use **RTL Graph: Show Sync Status** for details. After a service restart, reconnect and run Open Current Module again to negotiate the current buffer. One desktop workspace and one VS Code adapter connection are supported at a time, with multiple shared document sessions. No extension marketplace publishing or native desktop installer is provided yet.

## Adder demo

1. Start the app in this repository and open `fixtures/adder.v` in the Extension Development Host.
2. Run Open Current Module. After 15 quiet seconds, the canvas shows inputs `a` and `b`, an ADD operation, and output `sum`, all with eight-bit widths.
3. Select ADD and click **MUL** in the inspector. After another 15 quiet seconds, VS Code changes only `+` to `*`. The comment and spacing remain unchanged; the document may remain unsaved. Press Undo in VS Code to reverse the patch.
4. Type `-` into the live buffer without saving. Wait 15 seconds: the graph shows SUB.
5. Drag the operation to a custom position. No source edit occurs. Quit and restart the graph app, then reopen the module through the extension: the position persists.
6. Leave a half-written expression and wait 15 seconds: a diagnostic appears while the last valid graph stays visible. Finish the expression to resume synchronization.

Later semantic user edits take priority over pending earlier edits. Movement may restart the inactivity interval but never changes that priority. Superseded work is saved under `.hdlgraph/recovery-*.json`; see [recovery and architecture](docs/architecture.md). The conservative graph-last rebase only patches selected operators and retains unrelated source work. Changed operands, ambiguous source or precedence changes are refused visibly.

## Commands and tests

```powershell
pnpm lint       # strict TypeScript check
pnpm test       # unit + authenticated localhost protocol integration
pnpm run licenses # locked installed dependency licenses + full notices
pnpm build      # desktop UI, core and bundled VS Code extension
pnpm smoke      # real Electron window + official VS Code extension host
pnpm audit      # online dependency vulnerability check
pnpm format:check # consistent source and documentation formatting
```

The smoke runner uses actual 15-second timers, writes to isolated test workspaces, captures the desktop canvas in `test-results/desktop-smoke.png`, and writes JSON results. It downloads an isolated official VS Code test runtime on first run and uses separate user data. It does not change your installed VS Code, settings or source files. Set `MIRA_CODE_EXE` to use a particular executable. A graphical desktop session and permission to bind loopback sockets are required. See [test coverage and remaining manual checks](docs/testing.md).

## Supported scope and limitations

Supports one combinational ANSI-style module per file; scalar/vector input and output ports; internal wires; continuous assignments; unsigned decimal and sized binary/octal/decimal/hex constants; fixed bit/part selections; parentheses; binary `+`, `-`, `*`, `&`, `|`, `^`; and ternary mux expressions. The inspector can change operators, literal tokens, slice ranges, and simple scalar mux selectors. See the [exact syntax matrix](docs/supported-syntax.md).

Try `fixtures/combinational.v`: select `8'h0F` and queue `8'h2A`, select `a[7:0]` and queue `[3:0]`, or select MUX and choose `select_b`. Each change stays within its exact source span after 15 quiet seconds. Invalid digits, overflowing constants, out-of-bounds slices, cycles and unsafe precedence changes are rejected.

Keyboard arrow keys move selected nodes and save their positions. Newly shared modules open automatically in the module picker. Window bounds are saved on close and restored on a connected monitor; unplugged-monitor bounds are clamped back on screen.

Unsupported constructs reject the projection rather than silently disappearing. Layout and graph identities are independent of source formatting and operator spelling. New nodes receive left-to-right dependency placement; a committed removal discards their old position. Renames and structural expression rewrites may create new identities. Recovery restore is manual. No circuit construction, rewiring, simulation, synthesis, multi-workspace window management or arbitrary Verilog support is claimed.

## Repository map

- `packages/protocol`: versioned messages, validation, operator/patch types.
- `packages/core`: scheduler, arbitration, recovery, identities/layout and local service.
- `packages/verilog`: Chevrotain lexer, restricted parser, graph projection and exact token patches.
- `apps/graph`: Electron shell, secured preload, React Flow canvas and inspector.
- `extensions/vscode`: unsaved document sharing and guarded native WorkspaceEdit patches.
- `tests`, `fixtures`, `scripts`: fake-clock tests, protocol fixtures and real-app smoke runners.
- `docs`: design decisions, syntax, tests, dependency licenses and third-party notices.

Dependency licenses are audited from the actual installed dependency closure. Generated notices retain MIT/BSD/ISC/Apache/MPL terms; dual licenses use their permissive option. Electron's binary also ships Chromium notices in `node_modules/electron/dist/LICENSES.chromium.html`, which must accompany any future packaged desktop distribution. See [license audit notes](docs/licenses.md).

The remaining Milestone 2 work is concatenation, richer expression construction, safe node insertion/removal and connection editing. No graph construction or rewiring is advertised yet.
