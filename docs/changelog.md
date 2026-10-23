# Changelog

## Workspace refinement (unreleased)

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
