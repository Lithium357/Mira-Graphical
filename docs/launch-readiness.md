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
- Owner acceptance of everyday usability and extended real-project use, reported on 2026-10-25 after multiple hours and many tweaks across preview usage.

## Recorded owner acceptance

On 2026-10-25, the owner reported that usability is good and the application works well after multiple hours of use and many tweaks. This satisfies the owner usability and extended-use checks. Exact preview versions and individual workflows were not recorded, so this feedback does not certify every supported language or feature. The owner has not evaluated screen-reader behavior.

Remaining work before declaring 1.0:

- Run additional independently authored in-scope projects and user trials. The first [external review](compatibility.md) refused all 15 samples; preprocessing and positional/primitive instances remain outside the bounded scope; the Yosys counter now reaches the non-ANSI port limitation.
- Complete human screen-reader acceptance. The [interactive 0.9.6 NVDA review](qa/nvda-0.9.6.md) now covers real companion sharing, component inspection, simulation/table reading, recovered copies, clock/reset controls, keyboard wiring, native Undo and an announced diagnostic location. Native keyboard/AX regressions and this agent-assisted speech-output check do not certify NVDA/JAWS usability; a fully keyboard-only journey, register construction and trace export through speech remain open.
- Broaden measured stress coverage beyond the accepted owner session. A ten-minute local real-time service session passed 10,028 simulation samples and 45 unsaved edits, with about 111 MiB peak memory, unchanged disk source and successful recovery after restart. The repeatable service soak accelerates debounce intervals; neither test measures days of operation, power-loss durability or large-canvas frame rates.
- Validate first-run wording with an unfamiliar person. The 0.9.6 agent review used disposable profiles and expanded disconnected/connected guidance checks, while isolated-profile installation/editor tests cover the companion. A fresh-person usability trial remains distinct.
- Select the final green-commit artifact and attach the release notes, manifests and checksums according to [distribution instructions](distribution.md). Signing remains deferred.

Windows and Linux have desktop integration CI; Debian 12/13 amd64 additionally have installed-package lifecycle checks. See [Debian validation scope](linux.md); native Wayland and human Orca acceptance remain separate. macOS is unverified. Passing CI provides regression evidence, not full HDL conformance or a declaration that 1.0 is ready to ship.

## Human acceptance checklist

Before 1.0, record tester, app/companion versions, date, result and any issue for each task:

- Fresh Windows user: install/upgrade, match companion version, share a real project, identify an error line, construct/wire a register, reset/step and export a trace without developer help.
- NVDA/JAWS user: navigate setup and modal dialogs, choose a component, read widths/errors, wire a connection, operate clock/reset and inspect a waveform using keyboard and speech. Verify focus return and absence of keyboard traps.
- Owner project session: accepted by the owner on 2026-10-25 for usability and multiple hours of real use. Additional language/workflow-specific trials can extend that evidence.

These checks require people; automated accessibility-tree and compiler checks do not substitute for them.
