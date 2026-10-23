# Changelog

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
