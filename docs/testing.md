# Verification report — 0.2.0

Windows verification on 2026-10-22, with Node 24.19.0, pnpm 11.25.0, Electron 45.0.0 and an isolated official VS Code 1.143.1 test runtime. Linux/macOS have not been validated.

## Reproducible checks

- `pnpm test`: **40 passed, 0 failed**. Includes parser/patch, fake-clock scheduling, identity/layout, actual authenticated WebSocket protocol, live-buffer guards and monitor-bound restoration tests.
- `pnpm lint`, `pnpm build`, `pnpm format:check`: passed.
- `pnpm run licenses`: **105 installed package versions**, no unresolved license classifications. Use explicit `run`: `pnpm licenses` invokes a different built-in pnpm command. The CI workflow now uses the correct invocation.
- `pnpm audit --json`: **0 reported advisories**.
- `pnpm smoke`: desktop/extension round trips passed, including constants, slices, mux selectors, multiple documents, native Undo and disk preservation. The final two-pass editor/service restart test is recorded in `test-results/vscode-smoke.json`.

The renderer bundler emits an informational warning about React Flow's `use client` directive. The entire app is client-rendered; no server-component boundary exists, and builds/runtime smoke succeed.

## Desktop and extension evidence

The desktop test uses actual 15-second timers, a four-node adder and an eleven-node combinational fixture. It selects inspector operations, edits literal/range/selector fields and verifies the exact resulting source. Real Chromium pointer-down/move/up events in a focused window move a node; the persisted position survives a canvas reload without any RTL patch. It verifies two simultaneous modules and records a screenshot in `test-results/desktop-smoke.png`.

The VS Code test runs inside the real extension host. It changes the adder operator in memory without saving, shares the live buffer, receives the graph patch, checks exact source/comment preservation, and verifies native Undo and the reverse graph update after another debounce. It then shares the combinational module, applies three limited edits in one native workspace edit, and confirms that Undo reverses them together and that neither source file on disk was changed. The first module remains untouched while editing the second.

The two-pass runner closes and recreates both the synchronization service and extension-host process using the same metadata directory. The second pass checks the original operation ID and custom coordinates before applying further edits. It uses a fresh editor profile and a new connection token; pending patches are never replayed. `restartedEditorAndService` in the final JSON distinguishes this check from a renderer-only reload.

Native Windows automation also exercised the visible desktop app's module picker, operation inspector, keyboard movement and a full graph process quit/restart. The saved position and operator remained, while the other document retained its independent ADD operation. A disposable mock editor supplied the source for this particular native window test; the extension-host test separately verifies the real editor adapter.

## Safety regressions

- Movement cannot cancel a patch acknowledgment timeout or clear a conflict.
- Late acknowledgments cannot overwrite a newer user buffer.
- Nested operand changes cannot match merely because their display labels are identical.
- Replacing an operation with a literal, committing, then recreating it gets a new entity ID.
- Invalid/unsupported source retains the last valid graph and never causes source replacement.
- Malformed metadata cannot supply invalid coordinates or zoom to the canvas.
- Literal overflow/base errors, invalid or reversed slices, unsafe operator regrouping, undeclared names, cycles, stale hashes/revisions, overlapping patches and whole-document rewrites are refused.

## Monitor and accessibility limits

Only one physical display is currently exposed to the test process, so moving the app onto an actual second monitor cannot be verified here. Automated geometry tests cover a connected second monitor and recovery when that monitor is removed. The smoke runner will also test a real second display when one is available and records `secondMonitorTested`.

Keyboard node movement and module selection were exercised. Screen-reader behavior, touch/pen interaction, non-Windows releases, signed installers and arbitrary circuit construction remain unverified or outside this version's scope. Recovery restore is still manual. See `supported-syntax.md` for precise syntax/edit boundaries.

## Running again

Run `pnpm install`, `pnpm run licenses`, `pnpm build`, `pnpm test`, then `pnpm smoke`. Allow roughly four minutes for real debounce intervals and the two editor passes, plus first-run downloads. A graphical desktop and loopback sockets are required. Test workspaces/profiles/logs remain under ignored `test-results/`; the isolated editor runtime lives in `.vscode-test/`. No personal source documents or installed editor settings are modified.

`pnpm qa:native` opens two disposable modules for an interactive desktop check and restarts the graph once after it is closed. Make edits/move nodes in the first run, inspect restoration in the second, then close again. This script requires a person or desktop automation to operate the window; it is not part of unattended CI. CI uses the fully automated smoke runner instead.
