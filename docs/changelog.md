# Changelog

## 0.2.0

- Added sized unsigned binary/octal/decimal/hex literals, fixed bit/part selections and ternary mux projection.
- Added exact-span graph edits for literal values, slice ranges and simple scalar mux selectors, with independent editor-side AST validation.
- Fixed acknowledgment timeout cancellation and conflicts being cleared by layout activity; nested operands now use recursive semantic signatures.
- Kept pending graph edits visible after renderer reloads and separated identities for different component kinds.
- Added persistent keyboard movement, automatic selection of newly shared modules, startup visibility and monitor-aware saved window bounds.
- Expanded real-pointer, multi-document, unsaved-buffer, Undo and process-restart verification; added consistent source formatting.
- Fixed the CI license command to use `pnpm run licenses`.

Remaining Milestone 2 work: concatenation, structural expression construction, node insertion/removal and connection editing. This is a pre-1.0 development version, not a packaged/signed desktop release.
