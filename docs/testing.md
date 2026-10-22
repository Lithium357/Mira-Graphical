# Verification report

Recorded on Windows on 2026-10-22. Node 24.19.0, pnpm 11.25.0, Electron 45.0.0; the official isolated VS Code test runtime is 1.143.1. No Linux or macOS runtime claim is made.

## Commands actually run

- `pnpm test`: **22 passed, 0 failed**. Includes fake-clock tests and a real authenticated loopback WebSocket integration test.
- `pnpm build`: passed TypeScript compilation, extension/preload bundling and desktop renderer build.
- `node node_modules/typescript/bin/tsc --noEmit` (the check used by `pnpm lint`): passed.
- `pnpm licenses`: **104 installed package versions, 0 unresolved license classifications**; full notices generated.
- `pnpm audit --json`: **0 reported advisories**, including the test harness.
- `pnpm smoke`: Electron and isolated VS Code runs passed with actual 15-second debounce intervals, including the reverse graph update after native Undo. JSON reports and the captured canvas are in `test-results/` (not committed).

The renderer bundler reports that React Flow's `use client` directive is ignored. This desktop application is entirely client-rendered; there is no React server-component boundary. The build and runtime smoke succeed with this informational warning.

The installed VS Code initially could not launch because its updater held a mutex. The smoke runner uses the official test harness and a downloaded isolated copy instead; it does not change the installed editor or interfere with its update.

## Acceptance coverage

| Acceptance scenario | Evidence |
| --- | --- |
| Text-to-graph adder | Four nodes, three edges and eight-bit widths tested; real desktop waits 15 seconds before projection |
| Graph-to-text | Desktop inspector click produces exactly one operator-token patch; real VS Code applies it to the live document |
| Unsaved text | Extension host edits the buffer without saving; service receives its snapshot and returns a minimal patch; disk remains unchanged |
| Debounce reset | Fake clock edits at 0, 10 and 20 seconds; no graph until 35 seconds |
| Temporary invalid RTL | Last valid graph retained with diagnostics; graph edit over invalid source refused |
| Persistent layout | Core recreation with persisted metadata, disk serialization/deserialization, and real renderer reload tested; full quit/restart of both UI apps remains a manual check |
| Operator identity | Formatting and operator edits retain IDs and manual coordinates |
| Remove/recreate | Committed removal prunes the ID and position; recreated operation gets a fresh ID |
| Last semantic edit wins | Both orderings tested with recovery; graph-last safely rebases the selected operator and preserves unrelated newer source |
| Layout-only changes | No source patches; authority unchanged; drag-end IPC exercised in desktop smoke |
| Echo prevention | One matched patch acknowledgment commits without scheduling another semantic update; VS Code native Undo works |
| Disconnect | Pending edits are checkpointed; timers stop; status becomes Disconnected; reconnect requires explicit buffer sharing |
| Unsupported Verilog | Whole projection refused, exact token/error panel shown; stale graph retained |
| Multiple documents | Independent Session clocks and state tested; adapter scopes documents by explicit URI |
| Protocol safety | Bad auth, bad versions, unshared/out-of-scope URI, fake sync origin and stale patch token handling covered |

`tests/core.test.ts` checks parser, spans, identity, arbitration, scheduling and recovery. `tests/service.test.ts` uses real sockets and temporary directories. `tests/extension.test.ts` tests live-buffer patch guards without mocking the entire VS Code API. `scripts/desktop-smoke.ts` drives the real renderer and its narrow IPC; `extensions/vscode/smoke.ts` runs inside the actual extension host.

## Manual checks and current boundaries

Physical pointer dragging, keyboard/screen-reader usability, multi-monitor window positioning, a complete quit/restart of both UI applications, and a multi-document UI walkthrough have not been manually verified. The automated desktop test dispatches a real inspector click but exercises dragging through the same IPC invoked by drag end. Automated layout recreation verifies metadata reuse separately from OS window lifecycles.

No requested semantic acceptance scenario is intentionally left unimplemented for the documented subset. Conservative refusal is deliberate when pending text changes the operation's operands or grouping. Arbitrary Verilog, multiple modules per file, graph node construction/rewiring, signed/base literals, automatic recovery restore, release installers and non-Windows platform validation are outside the delivered scope. See `supported-syntax.md` for the complete boundary.

## Reproducing

Run `pnpm install`, `pnpm licenses`, `pnpm build`, `pnpm test`, then `pnpm smoke` from the root. First smoke run downloads Electron and an official VS Code runtime; later runs reuse them. Test workspaces, editor settings and logs stay under `test-results/`, with the runtime under `.vscode-test/`. Permit local sockets and native app launch. The smoke test writes a disposable adder fixture; it never shares or patches user project documents. CI is configured for Windows, but a hosted CI run has not been observed from this workspace.
