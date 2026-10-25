# Changelog

## 0.9.7 — Public beta

- Published the current Windows workbench as a public beta with matching desktop and companion versions, an unsigned installer, corresponding source and SHA-256 checksums.
- Added a native minimize/reopen regression to the standard desktop test run and retained its report in CI artifacts.
- Recorded real NVDA speech-output checks for setup, sharing, component inspection, simulation/table navigation, recovery, clock/reset controls, keyboard wiring, native Undo and source-error announcements. Human screen-reader acceptance remains separate.
- Preserved strict native editor acknowledgments while hardening Windows test coordination with immutable state snapshots. This beta adds validation and distribution updates; HDL feature scope remains the documented bounded three-language subset.

## 0.9.6

- Updated first-run guidance with a connection-dependent next step, command-palette shortcuts, companion reload instructions, current clocked support and automatic reconnect behavior.
- Added human-readable accessible names for circuit components and connections, accurate keyboard editing guidance and a keyboard shortcut past the circuit canvas to the inspector.
- Kept the visual synchronization countdown outside the live announcement region, so each tick does not repeat the status. Added captions and row/column headers to sampled waveform values.
- Expanded native regression coverage for disconnected/connected onboarding, quiet countdowns, named graph elements, table semantics and skip-canvas focus restoration.

## 0.9.5

- Added clocked module/entity hierarchy with isolated per-instance registers, simultaneous updates and bounded delta-cycle settling. Flattened dependency validation rejects combinational feedthrough loops while allowing register feedback. Parent waveforms expose hierarchical signal names.
- Added Verilog/SystemVerilog `case`, comma-separated literal choices, defaults, nested conditionals, `always @*`/`always @(*)`, and ordered blocking assignments with intermediate width/type preservation. Latches and reads before assignment remain errors. Copied ordered expressions retain explicit size casts.
- Added native VHDL named/unnamed rising/falling-edge processes, enables, synchronous/asynchronous scalar resets, nested scalar conditionals and literal-choice cases. VHDL edge functions require known transitions; native type/width checks remain enforced.
- Added register creation and D/clock/reset wiring in both HDL families, with independently replayed source transactions. Register control shared by multiple assignments is protected from destructive per-node edits. Generated case predicates are not editable source operators.
- Added automatic companion reconnect with capped retry, cancellation on manual disconnect, retained explicitly shared URIs and fresh in-memory snapshots. Pending graph patches are never replayed on reconnect. Desktop/companion versions appear in Setup help; diagnostics include module, line and UTF-16 column.
- Added Icarus/GHDL project comparisons, real desktop and installed-companion register/Undo/reconnect checks, packaged hierarchical/native-clocked checks, and a two-minute real-time three-language acceptance runner with source/recovery/memory checks. Human accessibility/usability acceptance remains open.

## 0.9.4

- Added bounded standalone Verilog/SystemVerilog clocked modules: `always`/`always_ff` with one or two scalar input edge controls, nonblocking whole-register assignments, nested `begin`/`end` and `if`/`else`, register holds and asynchronous resets. Register values commit together after evaluating old-state right-hand sides.
- Added register nodes and layout boundaries so feedback through a register is valid while combinational cycles remain errors. Clocked modules support viewing and simulation; structural graph edits/copy are refused to preserve sequential behavior.
- Added persistent simulation state, **Step clock** controls, asynchronous reset sampling and **Restart simulation**. Registers start unknown; source changes restart state. Clear trace preserves state.
- Added signed net declarations, logical `!`/`&&`/`||` and bounded constant replication such as `{16{result[15]}}`, including signed clipboard declarations and unknown-bit handling.
- Added the reported three-module ALU/multiplier fixture, 17,570 Icarus comparisons over clock/reset phases, all 16 ALU opcodes, signed/unsigned products, old-state ordering, logical operators and replication, plus desktop and packaged-runtime tests.
- Clocked instantiations, delays, cases/loops, blocking clocked assignments, assignment to register slices and clocked VHDL remain unsupported. Upgrade desktop and the bundled VS Code companion together.

## 0.9.3

- Added Verilog/SystemVerilog `$signed(...)`, `$unsigned(...)` and arithmetic right shift `>>>`, including two's-complement comparisons, sign extension, context sizing and unknown sign-bit propagation. Signed declarations and signed based literals remain outside this bounded subset.
- Fixed the reported ALU's signed comparison/shift arms failing at `$`. Casts appear as single-input nodes and preserve their syntax through rewiring, copy/paste and guarded operator edits. Upgrade both desktop and the bundled VS Code companion.
- Flagged unsigned `>>>` coercion, including the reported unsigned ternary chain. `$unsigned($signed(OPc) >>> OPd)` isolates a signed shift before it enters that chain; the app follows the source rather than rewriting it.
- Preserved independent signedness and unknown-condition behavior for SystemVerilog procedural `if` arms, including copied muxes. Added `===`/`!==` case comparisons so copied procedural tests retain their known/unknown truth behavior.
- Added the extended ALU fixture and 11,234 Icarus output comparisons across unsigned/signed/isolated ALUs, mixed widths, unknown values and procedural copies. Added actual desktop, packaged runtime and companion/native Undo checks for signed casts and shifts.

## 0.9.2

- Replaced declaration-order columns with deterministic dependency layout: constants stay near consumers, neighbouring layers reduce crossings, and long mux chains fold into rows with each stage's private comparison and operation.
- Added **View → Auto layout** to rearrange the current module and return to readable zoom. Explicit rearrangement resets dragged positions; ordinary synchronization still preserves them. Source edits, construction drafts and simulation samples are retained.
- Fixed overview/readable fitting after inspector resizing by measuring the visible canvas directly.
- Overview can zoom out to 10% for larger circuits. Fit requests also finish in covered/minimized Windows windows, where animation frames may be suspended.
- Added geometry checks for the reported 57-node INT16 ALU, small circuits and hierarchy, plus Windows UI checks for measured card overlap, manual-position reset and circuit fitting.

## 0.9.1

- Detects existing per-user or all-users Windows installations and shows its installed version and location before replacement. Declining cancels before app files change; the same version offers reinstallation.
- Blocks replacing a newer version with an older installer, including silent setup. Keeps the existing application identity and normal upgrade/uninstaller path.
- Adds disposable Windows CI checks using the published, checksum-pinned 0.9.0 installer: replacement confirmation/cancellation, upgrade in a custom directory, obsolete-file removal, single app registration, settings/project/recovery preservation, same-version repair, preserved all-users scope and downgrade refusal in both registry scopes.

## 0.9.0

- Added unsigned Verilog/SystemVerilog shifts (`<<`, `>>`), equality/relational comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`) and bitwise NOT (`~`) across parsing, projection, simulation, construction, wiring and clipboard actions.
- Fixed the reported INT16 ALU refusing to load at its left-shift operator. The two-module example is retained in `fixtures/alu-int16.v`; select `ALU_INT16` to use it.
- Preserved Verilog precedence, scalar comparison results, self-determined shift amounts, assignment-context widths and unknown-bit propagation. Unary NOT has one wiring socket; unary/binary replacement is refused.
- Added independent Icarus comparisons for the ALU, mixed-width expressions and unknown bits, plus real desktop/editor and packaged-runtime checks. VHDL retains its existing typed operator subset.
- Upgrade both the desktop app and bundled VS Code companion for the expanded parser.

## 0.8.0

- Added an unsigned per-user Windows x64 NSIS installer with desktop/Start menu shortcuts and uninstallation.
- Bundled the runtime, UI, VS Code VSIX, dependency/Electron/Chromium notices and corresponding project source. Running the app needs no development tools.
- Added first-launch project-folder selection, remembered workspace, a folder switcher and a bundled-extension reveal action in Setup help.
- Added the Mira Windows icon and explicit unsigned build configuration.
- Added packaged-executable checks for all three languages, renderer and IPC, plus CI installation/launch/uninstall verification and installer checksums.

## 0.7.0

- Added workspace setup help with live connection status, VSIX installation steps, reconnect troubleshooting and keyboard guidance. Connection errors now name the workspace and the next action.
- Added a keyboard component navigator under View, inspector connection summaries, palette focus, simulation focus and modal focus restoration. Native keyboard tests cover setup, navigation, wiring, palette and simulation; accessibility-tree assertions preserve exposed control names.
- Added a process hard-kill recovery test and a reproducible three-language project soak with real authenticated sockets, guarded patches, simulation oracles, repeated reconnects and checkpoint verification.
- Added pinned external-project compatibility reporting and clearer diagnostics for unsupported preprocessing/event controls. These samples are refused; this release does not broaden the published HDL subset.
- Added portable package manifests and SHA-256 inventories for the unsigned VSIX. Installer/signing remains deferred.
- Pinned the packager's development-only MSAL dependency to patched 7.1.0 for GHSA-xcx6-jx8p-x3h5 and added a high-severity CI advisory gate. Azure authentication/publishing is not part of the verified packaging workflow.

## 0.6.0

- Added immediate durable checkpoints of shared live buffers and pending graph drafts, with previous-session preservation and visible storage-failure warnings.
- Added a recovery browser with source/draft preview, offline clipboard copying, separate untitled copies and native VS Code comparisons. Current buffers are never automatically overwritten.
- Added crash-style restart, corrupt/oversized snapshot, path/symlink and failure-handling tests, plus real desktop and installed-editor recovery checks.
- Removed the stale Verilog-only workspace caption.
- Wait for native clipboard writes to finish before confirming success, and report a clear recovery upgrade requirement for older companion extensions.

## 0.5.0

- Added native SystemVerilog support for logic declarations, fill literals and bounded complete `always_comb` blocks.
- Added native VHDL support for entities/architectures, typed unsigned arithmetic, conversions, resize, joins, slices, conditional assignments, complete `process(all)` blocks and named entity instances.
- Added native VHDL construction, wiring, clipboard and definition imports with independent editor proof replay and source-span preservation.
- Added `.sv`, `.vhd` and `.vhdl` editor activation and language-aware graph labels.
- Compared 4,608 generated output values against GHDL and Icarus, including construction and clipboard paths.

- Fixed existing nodes disappearing after construction/status refreshes by retaining canvas measurements.
- Replaced the fixed inspector and oversized toolbar with a canvas-first workspace, collapsible inspector, contextual clipboard actions, and Edit/View menus.
- Added pointer/keyboard pane resizing with locally remembered sizes, and simulation minimize/expand without losing samples.
- Removed page and nested waveform scrollbars; inputs and waveforms share a single dock content area.
- Increased label typography, handle size and automatic node spacing, including tall multi-port components. Default zoom favors readability; overview remains available.
- Bound new windows to the available monitor work area and added small-window screenshot/layout checks.

## 0.4.0

- Added concatenation and equal-width bus splitting, including ascending bus order and individually wired join sockets.
- Added canvas/inspector diagnostics for undriven/unused signals, width conversions and multi-bit selectors.
- Added box selection, copy/paste/duplicate, keyboard shortcuts, searchable palette and optional wire labels.
- Added local unsigned combinational simulation, on-node values, sampled waveform history and CSV clipboard export.
- Added reusable named-port modules, instance construction and navigation, per-module layout retention and explicit cross-file definition import.
- Added module-scoped proof validation and atomic native Undo for child-module, bus and clipboard batches.
- Added an unsigned VSIX build with an explicit file allowlist, isolated installation testing and CI artifact output. Desktop installer/signing remains deferred.
- Added differential checks against Icarus Verilog for 264 vectors and 2904 output comparisons.

## 0.3.0

- Added construction of operations, muxes, constants, slices, wires and ANSI input/output ports.
- Added drag-to-wire and inspector connections, driver disconnection, unused component removal and explicit zero replacement.
- Added immediate draft previews, pending Undo/Redo/discard and full draft recovery snapshots.
- Composed batches retain original source spans. The editor independently replays construction actions before applying one native workspace edit.
- Added visible undriven markers, cycle/name/socket validation, comment-preserving refusals and stable draft identities/manual layout.
- Extended real desktop pointer and VS Code native Undo checks for construction.

Remaining work includes concatenation, simulation, richer HDL support and packaged releases.

## 0.2.0

- Added sized unsigned binary/octal/decimal/hex literals, fixed bit/part selections and ternary mux projection.
- Added exact-span graph edits for literal values, slice ranges and simple scalar mux selectors, with independent editor-side AST validation.
- Fixed acknowledgment timeout cancellation and conflicts being cleared by layout activity; nested operands now use recursive semantic signatures.
- Kept pending graph edits visible after renderer reloads and separated identities for different component kinds.
- Added persistent keyboard movement, automatic selection of newly shared modules, startup visibility and monitor-aware saved window bounds.
- Expanded real-pointer, multi-document, unsaved-buffer, Undo and process-restart verification; added consistent source formatting.
- Fixed the CI license command to use `pnpm run licenses`.

Remaining Milestone 2 work: concatenation, structural expression construction, node insertion/removal and connection editing. This is a pre-1.0 development version, not a packaged/signed desktop release.
