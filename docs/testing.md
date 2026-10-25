# Verification report

## 0.9.1 installer upgrades

The Windows installer CI job installs the published 0.9.0 setup after checking its pinned SHA-256. It checks the real replacement prompt for both versions and the existing location, declines it and verifies the original app bytes remain unchanged. A silent upgrade then retains a custom location, removes obsolete app files, leaves one app registration, installs the exact new app bundle and verifies the EXE version. Project, recovery and settings sentinels survive upgrade and same-version repair. A simulated newer registry version exercises the compiled downgrade refusal and verifies unchanged app bytes. The test restores the registry version and uninstalls from the disposable runner. It also installs the baseline for all users on the disposable administrator runner, verifies machine-scope downgrade refusal and upgrade without creating a second per-user copy, then uninstalls it. Personal installs are untouched by local smoke runs.

## 0.9.0 ALU regression

The reported two-module INT16 ALU is retained in `fixtures/alu-int16.v`. The expanded suite has 106 tests (105 pass on Windows, with the symlink privilege case skipped). `pnpm test:alu` compares all 16 opcodes over 2,192 ALU vectors and 137 mixed-width/unknown-bit probe vectors with 14 outputs against Icarus Verilog: **4,110 matching output checks**. The differential test runs in the Ubuntu CI job and retains source, expected values, native logs and its JSON report.

Desktop smoke renders the complete ALU, verifies the single NOT socket and simulates shift/NOT results. SystemVerilog editor passes patch a one-character addition token to a two-character shift token and verify atomic native Undo with unchanged disk source. The actual packaged EXE also exercises shifts, comparison and NOT.

## 0.8.0 baseline

Windows verification with Node 24.19.0, pnpm 11.25.0, Electron 45.0.0 and an isolated official VS Code 1.143.1 runtime. Linux/macOS app releases have not been validated.

## Automated checks

- `pnpm test`: **101 tests, 0 failures** (100 passed locally; the file-symlink case skips when Windows denies that privilege). Includes native HDL parsing, typed arithmetic, construction, scoped patches, hierarchy, clipboard safety, simulation, durable recovery, scheduling, authenticated WebSocket integration and layout persistence. The Ubuntu CI job also runs the complete unit suite so symlink refusal is exercised on Linux.
- `pnpm lint`, `pnpm build`, `pnpm format:check`: passed.
- `pnpm run licenses`: **418 installed package versions** on Windows after adding the installer packager, no unclassified licenses. Two exact-version, exact-license-hash Microsoft helpers are development-only exceptions, never runtime/VSIX contents; signing scripts are disabled. See [license scope](licenses.md).
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

The desktop recovery check selects an archived graph preview, copies its exact text, switches back to the saved source, verifies the modal fits the window, and closes it with Escape. Its screenshot is `recovery-smoke.png`. Both editor passes open an inert recovery snapshot as an untitled VHDL buffer and open its draft in a native diff; they assert that the current unsaved source and disk file remain unchanged. The result includes `recoveryReviewCopy`.

The official packager checks an exact five-source-file allowlist: manifest, README, GPL license, third-party notices and bundled extension runtime. The generated VSIX additionally contains the standard VSIX metadata. It excludes node_modules, signing helpers, test code and source maps.

The smoke runner installs this VSIX into isolated extension/profile directories and verifies its installed ID/version. The first editor pass runs the source-built adapter; the second runs the installed VSIX runtime as the development extension. Neither pass modifies personal editor profiles or extensions.

Both passes edit an unsaved adder buffer, apply a guarded graph patch, verify native Undo and its reverse graph update, then patch literal/slice/selector and new-operation wiring in a second document. A third document applies an operator change, concat creation and copied-result construction inside a child module as one native WorkspaceEdit. Undo restores the complete child batch. Parent source, unrelated documents and all files on disk remain unchanged. The restarted service/editor checks stable identity and manual coordinates. Results include `hierarchyBusesDuplicate`, `installedVsix` and `restartedEditorAndService`.

Before issuing native Undo, the harness waits for the exact buffer version to be acknowledged as synchronized and explicitly focuses that document. It then waits for a version change and retains every exact source/atomicity assertion. This avoids testing an unfocused global command or racing the completion of WorkspaceEdit registration.

Harness status JSON is atomically replaced so the editor cannot observe an empty or partially rewritten status file while checking acknowledgment/Undo propagation.

## Independent simulator check

`pnpm test:languages` requires GHDL and Icarus in PATH (`MIRA_GHDL`, `MIRA_IVERILOG`, `MIRA_VVP` may override executables). It constructs and duplicates circuits through native source actions, then compares 256 deterministic input vectors × 9 outputs × 2 languages: **4,608 matching values**. An independent arithmetic oracle also checks Mira's expected results. Four additional native GHDL assertions check scalar/vector type conversion and resizing, including qualification needed to resolve overloaded concatenation. Local verification used GHDL 5.0.1 and Icarus 12.0 through WSL. The Ubuntu CI job installs both tools and runs this check; artifacts include generated source, benches, simulator logs and results.

For separate compiler environments, run `pnpm test:languages --generate`; compile `test-results/hdl-reference/generated.vhd` plus `bench.vhd` with VHDL-2008/top `bench`, and `generated.sv` plus `bench.sv` with SystemVerilog-2012/top `bench`. Save simulator stdout to `vhd.log` and `sv.log` in that directory, then run `pnpm test:languages --verify`.

Both real VS Code passes additionally exercise `.sv`, `.vhd` and `.vhdl` buffers with an unsaved Unicode comment, native operator/construction patches, unchanged disk files and single-batch native Undo. Desktop checks render VHDL and SystemVerilog graphs, use the inspector's native operator edit and evaluate its pending circuit. Language screenshots are `language-sv.png` and `language-vhd.png`.

`pnpm test:reference` requires Icarus Verilog (`iverilog`, `vvp`) in PATH. `MIRA_IVERILOG` and `MIRA_VVP` can point to compatible executables. It generates deterministic test vectors and a testbench, compiles/runs the reference and compares all output bits against Mira. Outputs remain in ignored `test-results/reference/`.

The local Windows verification used Icarus extracted into that test directory and run through WSL, without a system-wide installation. To reproduce with another compiler setup, generate with `pnpm test:reference --generate`, compile `test-results/reference/reference.v` with top `tb` and Verilog-2005 mode, write simulator output to `test-results/reference/reference.log`, then run `pnpm test:reference --verify`. CI does not require this optional external compiler.

## Crash, project-scale and accessibility gates

The hard-kill test spawns a separate Node process with an unsaved source buffer and a pending construction draft, waits for checkpoint completion, then terminates that exact child with SIGKILL. A new store recovers both source and draft after the process exits; the source file remains unchanged. No graceful close/disconnect handler supplies the recovered text. This tests process termination, not power failure or filesystem hardware guarantees.

`pnpm test:soak --cycles=200 --lanes=64` passed 600 guarded source patches and 60 reconnects across Verilog, SystemVerilog and VHDL. Each generated datapath projects 198 nodes. Every cycle checks ACK/source agreement, simulation against an independent lane oracle and bypass behavior; each language also checks its final disk source and recovery checkpoint. Local elapsed time was 38.6 seconds with a peak service-process RSS of 254 MiB. Debounce uses a virtual clock; sockets, parsing, construction proofs, checkpoint I/O and simulation are real. The report is `test-results/project-soak.json`. CI runs a smaller 10-cycle, 32-lane regression. The generator respects the existing 64-part concat limit; exceeding it is not supported. This does not measure renderer frame rates or establish a memory-growth bound over days.

The desktop suite uses native Chromium Tab, Enter, Escape and select-key events to open setup help, verify modal focus trapping/return, select and read a recovery snapshot, select a component through View, focus its inspector, create a wiring transaction, search the palette, sample simulation and return focus after closing it. It also queries Chromium's accessibility tree and asserts exposed region/control/waveform names. `accessibility-smoke.json` records the checks and tree. A focused reproduction is `pnpm exec electron . --smoke --accessibility-only --workspace=<disposable-folder>` after building. Human NVDA/JAWS acceptance remains outstanding.

The initial disconnected workspace asserts visible setup/VSIX guidance before sharing a document. The setup panel reports authenticated editor connectivity separately from shared documents. Existing isolated VSIX/editor passes exercise fresh profiles. See [external compatibility results](compatibility.md) and [artifact/checksum instructions](distribution.md).

## Remaining validation

Combinational simulation and bounded clocked Verilog/SystemVerilog/VHDL hierarchy are covered, including signed nets/casts. `pnpm test:clocked` compares 17,570 outputs against Icarus across 1,255 samples of the reported ALU/multiplier and a falling-edge register probe. Native desktop checks exercise clock stepping, asynchronous reset and restart; packaged-runtime checks retain register state through IPC. Sequential timing/delays, source x/z literals, parameters and syntax outside the documented subset remain unsupported. Undriven signals use x, without a separate z state. Instance feedthrough dependencies are validated after elaboration. See [exact syntax and limits](supported-syntax.md).

Monitor geometry/restoration has automated coverage; the app is a separate movable Windows window. Full human screen-reader acceptance, touch/pen interaction, other operating systems, live cross-file elaboration and automatic recovery restore remain unverified or outside this version. Signing is deliberately deferred; Windows now has an unsigned installer.

## Packaged Windows application

`pnpm test:installer` launches the actual bundled EXE with an isolated workspace/profile. It authenticates to the included local service, shares Verilog/SystemVerilog/VHDL buffers, waits for real projection debounce, simulates each result, and verifies the renderer plus sandboxed preload IPC. It checks the presence of the companion, corresponding source, GPL/dependency notices and Electron/Chromium notices. In the separate Windows installer CI job, it additionally installs silently into a disposable directory, repeats the actual-EXE checks, uninstalls, and checks removal of the executable. CI verifies the setup's Authenticode status is NotSigned. The result is `installer-smoke.json` in the `windows-installer` artifact.

## Running again

Run `pnpm install`, `pnpm run licenses`, `pnpm build`, `pnpm test`, then `pnpm smoke`. Allow roughly twelve to fifteen minutes for real debounce intervals, isolated VSIX installation and two editor passes, plus first-run downloads. A graphical desktop and loopback sockets are required. Workspaces/profiles/logs remain under ignored `test-results/`; the isolated editor runtime is in `.vscode-test/`.

The bundler reports React Flow's `use client` directive as informational in this entirely client-rendered app. The official VS Code test CLI can report Node's shell-spawn deprecation warning; all arguments are fixed test flags or internally generated workspace/package paths. The checks verify native installation and editing regardless of those warnings.

## 0.9.5 project and release acceptance

`pnpm test:projects` adds 3,476 Icarus/GHDL comparisons for clocked hierarchy, case dispatch, ordered temporary widths, copied expressions, native edge functions and resets. `pnpm test:acceptance --seconds=120` uses real sockets and 15-second timers across all three languages, simulates while editing unsaved buffers, checks disk source integrity, bounds memory, and verifies recovery after service restart. This is a two-minute backend acceptance session, not a multi-day rendering or human usability certification.

The desktop suite steps hierarchical and VHDL clocks and creates a register through the palette. Source and installed VSIX passes test one native Undo for register construction/wiring and automatic reconnect/resharing of an unsaved buffer. Retry-generation, cancellation, source-location and version-consistency tests run in the ordinary unit suite.

## Onboarding and accessibility review (0.9.6)

The desktop suite checks fresh-workspace instructions before connection and the next-step prompt after connection but before sharing. During a real synchronization countdown, it verifies that the visible timer changes without mutating the live status text. `onboarding-smoke.json` records this evidence. Native keyboard/AX checks additionally cover readable graph names, scoped sample-table headers, and skipping the canvas to the inspector with focus return. See the [interactive NVDA review](qa/nvda-0.9.6.md) for real companion sharing, simulation/table speech output, recovery and clock/reset observations, with remaining human acceptance clearly identified.

Before the desktop journey, `pnpm smoke` also minimizes its isolated native window and dispatches Electron's second-instance event. `window-activation-smoke.json` records whether reopening restored a visible, non-minimized window. This tests the existing reopen handler, not a second operating-system process or foreground-focus policy. `--editor-only` skips both desktop checks.

The editor test coordinator publishes immutable state snapshots instead of replacing files while Windows readers may hold them. Readers select the latest complete snapshot; an incomplete publication leaves the previous snapshot readable. This changes only test coordination. Exact version/status acknowledgments, buffer contents, native Undo and unchanged-disk assertions remain required. Failures include the observed service state and diagnostics.
