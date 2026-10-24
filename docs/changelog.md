# Changelog

## 0.9.1

- Detects an existing per-user Windows installation and shows its installed version and location before replacement. Declining cancels before app files change; the same version offers reinstallation.
- Blocks replacing a newer version with an older installer, including silent setup. Keeps the existing application identity and normal upgrade/uninstaller path.
- Adds disposable Windows CI checks using the published, checksum-pinned 0.9.0 installer: replacement confirmation/cancellation, upgrade in a custom directory, obsolete-file removal, single app registration, settings/project/recovery preservation, same-version repair and downgrade refusal.

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
