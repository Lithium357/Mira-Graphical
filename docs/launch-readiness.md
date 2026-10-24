# Launch readiness

The intended first release is the documented unsigned combinational HDL workbench. Full HDL standards, clocked simulation and synthesis are outside the current product scope. The owner authorized an unsigned Windows installer; signing remains deferred.

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

- Run additional independently authored in-scope projects and user trials. The first [external review](compatibility.md) refused all 15 samples; preprocessing, positional/primitive instances and clocks remain outside the narrow launch scope.
- Complete human screen-reader acceptance. Native keyboard events and the exposed accessibility tree are automated evidence; they do not certify NVDA/JAWS spoken behavior or usability.
- Conduct longer wall-clock/desktop-rendering stress and user editing sessions. The repeatable service soak accelerates 15-second debounce intervals; it does not measure days of operation, power-loss durability or large-canvas frame rates.
- Validate the first-run wording with a person using a fresh profile. Isolated-profile installation and automated setup checks pass, but a human usability trial is distinct.
- Select the final green-commit artifact and attach the release notes, manifests and checksums according to [distribution instructions](distribution.md). Signing remains deferred.

Windows is the verified desktop platform. Portable core tests on Linux do not certify the Linux/macOS Electron application. Passing CI provides regression evidence, not full HDL conformance or a declaration that 1.0 is ready to ship.
