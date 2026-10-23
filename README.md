# Mira Graphical

A local, bidirectional Verilog, SystemVerilog and VHDL graph companion. Write RTL in VS Code; construct, wire and inspect supported circuits in a separate desktop window. Semantic edits synchronize after **15 seconds of inactivity**. Original code is **GPL-3.0-only**.

Version 0.5.0 adds native SystemVerilog and VHDL combinational RTL support and a resizable canvas-first workspace. Each language supports source synchronization, construction, wiring, hierarchy, clipboard actions and local simulation within the [documented subset](docs/supported-syntax.md). Clocked logic, testbenches and full language standards remain outside this version.

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
3. In that window, open the same project folder selected for the graph app, and open a `.v`, `.sv`, `.vhd` or `.vhdl` file.
4. Run **RTL Graph: Open Current Module** from the command palette or editor context menu.

Only explicitly shared documents participate. Use **RTL Graph: Connect/Disconnect** to disconnect; use **RTL Graph: Show Sync Status** for details. After a service restart, reconnect and run Open Current Module again to negotiate the current buffer. One desktop workspace and one VS Code adapter connection are supported at a time, with multiple shared document sessions. No extension marketplace publishing or native desktop installer is provided yet.

To use the packaged companion, run `pnpm package:extension`, then choose **Extensions: Install from VSIX…** in VS Code and select `dist/packages/mira-graphical-0.5.0.vsix`. Keep the desktop app running for the same workspace and share a `.v`, `.sv`, `.vhd` or `.vhdl` file with Open Current Module. The official [VS Code packaging tool](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions) creates the unsigned VSIX; this does not publish to the Marketplace or create/sign a desktop installer. CI uploads the VSIX with its test artifacts.

## Adder demo

1. Start the app in this repository and open `fixtures/adder.v` in the Extension Development Host.
2. Run Open Current Module. After 15 quiet seconds, the canvas shows inputs `a` and `b`, an ADD operation, and output `sum`, all with eight-bit widths.
3. Select ADD and click **MUL** in the inspector. After another 15 quiet seconds, VS Code changes only `+` to `*`. The comment and spacing remain unchanged; the document may remain unsaved. Press Undo in VS Code to reverse the patch.
4. Type `-` into the live buffer without saving. Wait 15 seconds: the graph shows SUB.
5. Drag the operation to a custom position. No source edit occurs. Quit and restart the graph app, then reopen the module through the extension: the position persists.
6. Leave a half-written expression and wait 15 seconds: a diagnostic appears while the last valid graph stays visible. Finish the expression to resume synchronization.

Later semantic user edits take priority over pending earlier edits. Movement may restart the inactivity interval but never changes that priority. Superseded work is saved under `.hdlgraph/recovery-*.json`; see [recovery and architecture](docs/architecture.md). The conservative graph-last rebase only patches selected operators and retains unrelated source work. Changed operands, ambiguous source or precedence changes are refused visibly.

## Build and wire a circuit

Share a supported module (including `module blank(); endmodule`), wait for synchronization, then click **Add component**. Create arithmetic/bitwise operations, muxes, constants, fixed slices, named wires, input ports or output ports. New operations and muxes start with explicit zero inputs.

Drag a named signal or component result handle to an input socket, or select a component and use the inspector's **Source signal** and **Connect** buttons. Rewiring replaces that input. Result names are the declared wires assigned by components; nested expressions need a named result before they can be shared. Mux selectors require a one-bit signal. Combinational cycles are rejected.

Changes preview immediately and synchronize as one native VS Code edit after 15 quiet seconds. **Undo pending**, **Redo pending** and **Discard pending** manage the current batch; after synchronization use VS Code's native Undo. Structural changes wait while newer source text is pending. Superseded/discarded drafts have full preview text in recovery snapshots.

The inspector can disconnect a named driver, remove an unused component, or explicitly replace an expression with zero. Undriven wires and outputs are visibly marked. Removing a result still used elsewhere is refused; disconnect consumers first. Ports stay in the module interface, shared wire declarations must be split in VS Code before deletion, and edits that would delete comments are refused. Verilog/SystemVerilog use assignment extension/truncation; VHDL enforces exact types and widths and emits explicit conversions/resizes when wiring requires them.

## Buses, diagnostics and faster editing

Use **concat** to join a comma-separated list of signals in most-significant-first order. Use **split** with a source bus and chunk width to create named slice results, `_0` starting at the least-significant end. Ascending declarations are respected. A fixed slice such as `[3]` selects one bit. Each concatenation part has its own wiring socket.

The canvas flags undriven and unused signals, width extension, truncation and vector selectors. Expand **circuit warnings** in the inspector to select the relevant component. Verilog/SystemVerilog widths follow unsigned context rules; a wider arithmetic destination can preserve carry/product bits. VHDL follows native numeric_std result widths and requires explicit resize/conversion nodes.

Search the component palette by name or by “bus”/“port”. Drag a selection box on empty canvas, or hold Shift while dragging; Ctrl/Meta-click adds nodes. Use **Copy**, **Paste**, **Duplicate**, or Ctrl/Meta+C/V/D while the canvas is focused. Ctrl/Meta+K opens the palette. The clipboard stays inside Mira. Named subgraphs preserve internal connections, create unique names and retain external references only when those signals exist in the destination. Select a root expression to duplicate its result as a wire; selecting a port explicitly duplicates that interface port, which can be refused if it would invalidate existing instances. **Wire labels** shows signal names and widths.

## Workspace controls

The circuit uses the full workspace until you select a component or open **Inspector**. Close the inspector to reclaim that space. Drag the divider to resize it; focused dividers also accept arrow keys, Home and End. Pane sizes are remembered locally.

**Add component** and **Simulation** stay on the main toolbar. **Edit** contains Undo/Redo, discard and clipboard actions; the selected component also offers Copy/Duplicate in its inspector. **View** contains wire labels and **Readable zoom**. The fit control gives a complete overview; Readable zoom favors legible nodes, with pan/zoom for larger circuits.

Simulation docks below the circuit. Drag its top divider, minimize it to keep samples while reclaiming canvas space, or close it. Inputs sit beside waveforms, with trace choices under **Signals**. The page itself does not scroll; each open pane owns its content scrolling.

## Simulation and waveforms

Open **Simulation**, set top-level inputs using decimal, `0x` hex, `0b` binary or `x`, then click **Sample inputs**. Values appear on nodes and in the waveform panel. Each click records an input vector, not a timed clock cycle. Choose up to 16 traces, inspect the latest 64 samples, or copy the trace as CSV. Samples reset when source/draft semantics change or modules change; layout-only movement preserves them.

The built-in evaluator supports this unsigned combinational subset, including concatenations, ascending/descending slices, muxes and nested module instances. It retains unknown bits: bitwise operations and unknown-selector muxes can resolve known bits; arithmetic involving unknown operands is pessimistic. Undriven nets display `x` (the viewer does not distinguish high impedance). No sequential/event-driven timing, clocks, testbench language or synthesis is implemented. Simulation is local and never edits source. It is bounded to 4096-bit values and 512 expanded signals.

## Reusable modules

Try `fixtures/hierarchy.v`. Select the `add_stage` instance and choose **Open module**, or use the **Module definition** picker. Child edits target the child definition and affect every instance after synchronization. Node identities, manual positions and module viewports survive navigation. Synchronize or discard a pending batch before switching modules.

Choose **module** in the palette to add an empty definition, then select it after synchronization and construct its interface/body. Choose **instance** to place an existing definition: inputs start tied to zero and outputs get named wires. Wire each named input socket; result wires can feed other components. For definitions in another file, explicitly share that file and use **Import from another shared file** in the construction panel. Mira copies the selected definition and its dependencies into the target document; it does not create a live cross-file link. Duplicate module names are refused. All instance definitions must be present in the resulting document, with each named port connected exactly once. Recursive, parameterized, positional and black-box instances are unsupported. Removing an instance leaves its result wires visibly undriven.

## Commands and tests

```powershell
pnpm lint       # strict TypeScript check
pnpm test       # unit + authenticated localhost protocol integration
pnpm run licenses # locked installed dependency licenses + full notices
pnpm build      # desktop UI, core and bundled VS Code extension
pnpm smoke      # desktop + isolated VSIX install + two real editor passes
pnpm package:extension # build an unsigned installable VSIX
pnpm test:reference # Verilog differential test; requires Icarus Verilog in PATH
pnpm test:languages # VHDL/SystemVerilog differential test; requires GHDL and Icarus
pnpm audit      # online dependency vulnerability check
pnpm format:check # consistent source and documentation formatting
```

The smoke runner uses actual 15-second timers, writes to isolated test workspaces, captures the desktop canvas in `test-results/desktop-smoke.png`, and writes JSON results. It downloads an isolated official VS Code test runtime on first run and uses separate user data. It does not change your installed VS Code, settings or source files. Set `MIRA_CODE_EXE` to use a particular executable. A graphical desktop session and permission to bind loopback sockets are required. See [test coverage and remaining manual checks](docs/testing.md).

## Supported scope and limitations

Supports up to 64 combinational ANSI-style module definitions per file, named-port instances, concatenations; scalar/vector input and output ports; internal wires; continuous assignments; unsigned decimal and sized binary/octal/decimal/hex constants; fixed bit/part selections; parentheses; binary `+`, `-`, `*`, `&`, `|`, `^`; and ternary mux expressions. The inspector can change operators, literal tokens, slice ranges, and simple scalar mux selectors. See the [exact syntax matrix](docs/supported-syntax.md).

Try `fixtures/combinational.v`: select `8'h0F` and queue `8'h2A`, select `a[7:0]` and queue `[3:0]`, or select MUX and choose `select_b`. Each change stays within its exact source span after 15 quiet seconds. Invalid digits, overflowing constants, out-of-bounds slices, cycles and unsafe precedence changes are rejected.

Keyboard arrow keys move selected nodes and save their positions. Newly shared modules open automatically in the module picker. Window bounds are saved on close and restored on a connected monitor; unplugged-monitor bounds are clamped back on screen.

Unsupported constructs reject the projection rather than silently disappearing. Layout and graph identities are independent of source formatting and operator spelling. New nodes receive left-to-right dependency placement; a committed removal discards their old position. Renames and structural expression rewrites may create new identities. Recovery restore is manual. Sequential simulation, synthesis, multi-workspace window management and arbitrary Verilog support remain outside this version.

## Repository map

- `packages/protocol`: versioned messages, validation, operator/patch types.
- `packages/core`: scheduler, arbitration, recovery, identities/layout and local service.
- `packages/verilog`: Chevrotain lexer, restricted parser, graph projection and exact token patches.
- `apps/graph`: Electron shell, secured preload, React Flow canvas and inspector.
- `extensions/vscode`: unsaved document sharing and guarded native WorkspaceEdit patches.
- `tests`, `fixtures`, `scripts`: fake-clock tests, protocol fixtures and real-app smoke runners.
- `docs`: design decisions, syntax, tests, dependency licenses and third-party notices.

Dependency licenses are audited from the actual installed dependency closure. Generated notices retain MIT/BSD/ISC/Apache/MPL terms; dual licenses use their permissive option. Electron's binary also ships Chromium notices in `node_modules/electron/dist/LICENSES.chromium.html`, which must accompany any future packaged desktop distribution. See [license audit notes](docs/licenses.md).

Desktop installation/signing is deferred. Further work includes sequential logic, broader Verilog syntax, live cross-file elaboration and richer routing/layout.
