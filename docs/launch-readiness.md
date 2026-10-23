# Launch readiness

The intended first release is the documented unsigned combinational HDL workbench. Full HDL standards, clocked simulation and synthesis are outside the current product scope. Installer creation and signing remain deferred at the project owner's request.

Completed release foundations:

- Native Verilog, SystemVerilog and VHDL construction, wiring, hierarchy, simulation and live VS Code buffer edits within explicit supported subsets.
- Version/hash guards, independently replayed construction proofs, atomic native Undo and visible conflict/error states.
- Durable live-buffer/draft checkpoints and recovery copies/comparisons that preserve current work.
- Resizable canvas/inspector/simulation workspace, keyboard pane controls, readable labels and monitor-bound restoration.
- Repeatable unsigned VSIX packaging, isolated installation tests, native desktop/editor smoke checks, compiler differential checks and dependency/license auditing in CI.

Remaining work before declaring 1.0:

- Test representative real projects against the published subset and decide which common refusals need additional syntax support for launch.
- Conduct a longer editing soak with large graphs, repeated reconnects and recovery after terminating the app during pending edits.
- Complete keyboard/focus and screen-reader acceptance checks across the full palette, wiring inspector, simulation dock and recovery dialog.
- Review first-run workspace/connection guidance and troubleshooting with a fresh user/profile.
- Prepare release notes, reproducible distribution instructions and a release artifact/checksum inventory. Keep installer/signing separate until authorized.

Windows is the verified desktop platform. Portable core tests on Linux do not certify the Linux/macOS Electron application. Passing CI provides regression evidence, not full HDL conformance or a declaration that 1.0 is ready to ship.
