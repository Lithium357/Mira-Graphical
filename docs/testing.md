# Verification report — 0.5.0

Windows verification with Node 24.19.0, pnpm 11.25.0, Electron 45.0.0 and an isolated official VS Code 1.143.1 runtime. Linux/macOS app releases have not been validated.

## Automated checks

- `pnpm test`: **90 passed, 0 failed**. Includes native Verilog/SystemVerilog/VHDL parsing, typed arithmetic, construction, scoped patches, hierarchy, clipboard safety, simulation, recovery, scheduling, authenticated WebSocket integration and layout persistence.
- `pnpm lint`, `pnpm build`, `pnpm format:check`: passed.
- `pnpm run licenses`: **211 installed package versions**, no unclassified licenses. Two exact-version, exact-license-hash Microsoft helpers are development-only exceptions, never runtime/VSIX contents; signing scripts are disabled. See [license scope](licenses.md).
- `pnpm audit --json`: **0 advisories**.
- Full `pnpm smoke`: desktop interactions, isolated VSIX installation and both real editor/service passes passed.
- Icarus Verilog 12.0 differential check: **264 input vectors × 11 outputs = 2904 matching bit-for-bit comparisons**. Covers arithmetic overflow/context, nested arithmetic, muxes, concatenation/slice ordering, named-port hierarchy and selected unknown-bit cases. This is regression evidence, not formal equivalence for arbitrary HDL.

## Desktop evidence

The test runs actual 15-second inactivity intervals against three shared documents. It changes operators, constants, slices and mux selectors; drags a node with real Chromium pointer events; reloads and checks persisted coordinates; creates an operation; drags a source into its socket; and exercises pending Undo/Redo.

The workbench portion samples two input vectors and checks the resulting on-node values and waveform columns. It navigates into a reusable child and back, verifies an exact child-only source patch, duplicates an instance, creates concat/split results, Shift-drags a real selection box around two input ports, copies/pastes them, and imports a definition from another explicitly shared file. Pending discard actions leave the acknowledged source unchanged. Wire labels are rendered and a final screenshot includes the hierarchy and simulation panel.

`test-results/desktop-smoke.json` records each path, including `boxSelection`, `copyPasteDuplicate`, `simulationWaveforms`, `moduleImport`, `hierarchy` and `busConstruction`. The image is `test-results/desktop-smoke.png`.

## Workspace regression checks

The construction phase runs at 1000×680, checks that existing nodes remain visible after a draft update, and verifies that overview fitting includes every node even with the inspector open. The desktop smoke also drags both pane dividers with native pointer events, checks keyboard resizing, collapses the inspector, and minimizes/expands simulation while retaining its sample. At requested window sizes of 1280×800, 1000×680 and 900×600 it asserts no document overflow, no nested waveform scroller, a full-width canvas with the inspector closed, more vertical space for the graph than the dock, and a readable zoom with the first node row visible. Measurements use the actual content area after Windows window borders and work-area constraints.

`desktop-smoke.json` records `resizableWorkspace` and `responsiveLayouts`. Cropped application screenshots are saved as `workspace-1280x800.png`, `workspace-1000x680.png` and `workspace-900x600.png`; CI retains these with the smoke artifacts. Browser storage for desktop smoke is isolated from the user's pane preferences.

## VS Code and VSIX evidence

The official packager checks an exact five-source-file allowlist: manifest, README, GPL license, third-party notices and bundled extension runtime. The generated VSIX additionally contains the standard VSIX metadata. It excludes node_modules, signing helpers, test code and source maps.

The smoke runner installs this VSIX into isolated extension/profile directories and verifies its installed ID/version. The first editor pass runs the source-built adapter; the second runs the installed VSIX runtime as the development extension. Neither pass modifies personal editor profiles or extensions.

Both passes edit an unsaved adder buffer, apply a guarded graph patch, verify native Undo and its reverse graph update, then patch literal/slice/selector and new-operation wiring in a second document. A third document applies an operator change, concat creation and copied-result construction inside a child module as one native WorkspaceEdit. Undo restores the complete child batch. Parent source, unrelated documents and all files on disk remain unchanged. The restarted service/editor checks stable identity and manual coordinates. Results include `hierarchyBusesDuplicate`, `installedVsix` and `restartedEditorAndService`.

## Independent simulator check

`pnpm test:languages` requires GHDL and Icarus in PATH (`MIRA_GHDL`, `MIRA_IVERILOG`, `MIRA_VVP` may override executables). It constructs and duplicates circuits through native source actions, then compares 256 deterministic input vectors × 9 outputs × 2 languages: **4,608 matching values**. An independent arithmetic oracle also checks Mira's expected results. Four additional native GHDL assertions check scalar/vector type conversion and resizing, including qualification needed to resolve overloaded concatenation. Local verification used GHDL 5.0.1 and Icarus 12.0 through WSL. The Ubuntu CI job installs both tools and runs this check; artifacts include generated source, benches, simulator logs and results.

For separate compiler environments, run `pnpm test:languages --generate`; compile `test-results/hdl-reference/generated.vhd` plus `bench.vhd` with VHDL-2008/top `bench`, and `generated.sv` plus `bench.sv` with SystemVerilog-2012/top `bench`. Save simulator stdout to `vhd.log` and `sv.log` in that directory, then run `pnpm test:languages --verify`.

Both real VS Code passes additionally exercise `.sv`, `.vhd` and `.vhdl` buffers with an unsaved Unicode comment, native operator/construction patches, unchanged disk files and single-batch native Undo. Desktop checks render VHDL and SystemVerilog graphs, use the inspector's native operator edit and evaluate its pending circuit. Language screenshots are `language-sv.png` and `language-vhd.png`.

`pnpm test:reference` requires Icarus Verilog (`iverilog`, `vvp`) in PATH. `MIRA_IVERILOG` and `MIRA_VVP` can point to compatible executables. It generates deterministic test vectors and a testbench, compiles/runs the reference and compares all output bits against Mira. Outputs remain in ignored `test-results/reference/`.

The local Windows verification used Icarus extracted into that test directory and run through WSL, without a system-wide installation. To reproduce with another compiler setup, generate with `pnpm test:reference --generate`, compile `test-results/reference/reference.v` with top `tb` and Verilog-2005 mode, write simulator output to `test-results/reference/reference.log`, then run `pnpm test:reference --verify`. CI does not require this optional external compiler.

## Bounds and remaining validation

Unsigned zero-delay combinational simulation is covered; sequential timing, signedness, source x/z literals, parameters and SystemVerilog outside the documented subset remain unsupported. Undriven signals use x, without a separate z state. Instance dependency checks are conservative. See [exact syntax and limits](supported-syntax.md).

Monitor geometry/restoration has automated coverage; the app is a separate movable Windows window. Screen-reader behavior, touch/pen interaction, other operating systems, live cross-file elaboration and automatic recovery restore remain unverified or outside this version. Desktop installers/signing are deliberately deferred.

## Running again

Run `pnpm install`, `pnpm run licenses`, `pnpm build`, `pnpm test`, then `pnpm smoke`. Allow roughly ten to twelve minutes for real debounce intervals, isolated VSIX installation and two editor passes, plus first-run downloads. A graphical desktop and loopback sockets are required. Workspaces/profiles/logs remain under ignored `test-results/`; the isolated editor runtime is in `.vscode-test/`.

The bundler reports React Flow's `use client` directive as informational in this entirely client-rendered app. The official VS Code test CLI can report Node's shell-spawn deprecation warning; all arguments are fixed test flags or internally generated workspace/package paths. The checks verify native installation and editing regardless of those warnings.
