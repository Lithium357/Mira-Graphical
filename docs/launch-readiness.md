# Launch readiness

The intended first release is the documented unsigned HDL workbench: bounded three-language construction, clocked hierarchy and sampled simulation. Full HDL standards, timed simulation and synthesis are outside the current product scope. The owner authorized an unsigned Windows installer; signing remains deferred.

Completed release foundations:

- Native Verilog, SystemVerilog and VHDL construction, wiring, hierarchy, simulation and live VS Code buffer edits within explicit supported subsets.
- Version/hash guards, independently replayed construction proofs, atomic native Undo and visible conflict/error states.
- Durable live-buffer/draft checkpoints and recovery copies/comparisons that preserve current work.
- Resizable canvas/inspector/simulation workspace, keyboard pane controls, readable labels and monitor-bound restoration.
- Repeatable unsigned VSIX packaging, isolated installation tests, native desktop/editor smoke checks, compiler differential checks and dependency/license auditing in CI.
- Process hard-kill recovery verification and a 600-edit/60-reconnect, three-language service soak with 198-node generated datapaths.
- Native keyboard and accessibility-tree checks for setup, component navigation, wiring, palette and simulation, plus modal Escape/focus restoration.
- First-run workspace/connection guidance and actionable companion connection errors.
- Pinned external-project refusal review, 0.8.0 release notes and unsigned artifact/checksum instructions.

Remaining work before declaring 1.0:

- Run additional independently authored in-scope projects and user trials. The first [external review](compatibility.md) refused all 15 samples; preprocessing and positional/primitive instances remain outside the bounded scope; the Yosys counter now reaches the non-ANSI port limitation.
- Complete human screen-reader acceptance. Native keyboard events and the exposed accessibility tree are automated evidence; they do not certify NVDA/JAWS spoken behavior or usability.
- Conduct multi-hour/day desktop-rendering stress and user editing sessions. The two-minute real-time acceptance session now covers actual debounce, simulation, unsaved edits, memory and recovery restart. The repeatable service soak accelerates 15-second debounce intervals; it does not measure days of operation, power-loss durability or large-canvas frame rates.
- Validate the first-run wording with a person using a fresh profile. Isolated-profile installation and automated setup checks pass, but a human usability trial is distinct.
- Select the final green-commit artifact and attach the release notes, manifests and checksums according to [distribution instructions](distribution.md). Signing remains deferred.

Windows is the verified desktop platform. Portable core tests on Linux do not certify the Linux/macOS Electron application. Passing CI provides regression evidence, not full HDL conformance or a declaration that 1.0 is ready to ship.

## Human acceptance checklist

Before 1.0, record tester, app/companion versions, date, result and any issue for each task:

- Fresh Windows user: install/upgrade, match companion version, share a real project, identify an error line, construct/wire a register, reset/step and export a trace without developer help.
- NVDA/JAWS user: navigate setup and modal dialogs, choose a component, read widths/errors, wire a connection, operate clock/reset and inspect a waveform using keyboard and speech. Verify focus return and absence of keyboard traps.
- Owner project session: run the actual ALU/multiplier, hierarchy and any VHDL designs for several hours; record unsupported syntax and whether a refusal preserves current source/drafts.

These checks require people; automated accessibility-tree and compiler checks do not substitute for them.
