# Mira Graphical

Build, wire and explore HDL circuits on Windows and Debian Linux, with live buffers from VS Code and LSP-capable editors.

> **AI-assisted development:** Mira is built with substantial assistance from OpenAI Codex, including code, tests, and documentation. The maintainer directs development and tests the app on real HDL projects. See [testing and limitations](docs/testing.md).

[![CI](https://github.com/Lithium357/Mira-Graphical/actions/workflows/ci.yml/badge.svg)](https://github.com/Lithium357/Mira-Graphical/actions/workflows/ci.yml)
[![Version: 0.9.9 beta](https://img.shields.io/badge/version-0.9.9_beta-42d6bc)](https://github.com/Lithium357/Mira-Graphical/releases/tag/v0.9.9)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

**[Windows x64](https://github.com/Lithium357/Mira-Graphical/releases/download/v0.9.9/Mira-Graphical-Setup-0.9.9-x64.exe)** · **[Debian amd64](https://github.com/Lithium357/Mira-Graphical/releases/download/v0.9.9/Mira-Graphical-0.9.9-amd64.deb)** · [Release notes and checksums](https://github.com/Lithium357/Mira-Graphical/releases/tag/v0.9.9) · [User guide](docs/user-guide.md)

![Mira workbench showing named module wiring, bus widths, a mux and a docked simulation panel](docs/images/workbench.png)

## Start testing

1. Install the Windows setup EXE or follow the [Debian installation steps](docs/linux.md), then launch **Mira Graphical**.
2. Choose your HDL project folder. Open **Setup help → Show VS Code extension…** to locate the bundled companion.
3. In VS Code, run **Extensions: Install from VSIX…**, select that companion, and open the same project folder.
4. Open a `.v`, `.sv`, `.vhd` or `.vhdl` file and run **RTL Graph: Open Current Module**. The circuit appears after **15 seconds of inactivity**.

Using Vim, Neovim or Notepad++? See [other editor setup](docs/editors.md). Vim/Neovim support two-way edits through LSP; Notepad++'s current LSP client supports live viewing and simulation only.

The app includes its runtime; Node and pnpm are unnecessary for installation. **0.9.9 is an unsigned public beta**. Windows may show an unknown-publisher/SmartScreen prompt. See [Windows installation and checksum verification](docs/distribution.md) or [Debian setup](docs/linux.md).

**On main, after 0.9.9:** [saved simulation tests, derived FSM diagrams, linked project sources and VHDL enums](docs/simulation-tests.md). These additions are not in the downloads above yet.

## What you can do

- Construct and wire arithmetic, bitwise operations, muxes, constants, ports, buses and reusable modules.
- Edit supported Verilog, SystemVerilog and VHDL through the graph or live VS Code buffer. Source patches preserve surrounding text and support native editor Undo.
- Connect Vim/Neovim and other capable LSP clients with guarded live-buffer edits; use Notepad++'s LSP client for live viewing and simulation.
- Inspect named signals and widths, sample inputs, step supported HDL clocks and view local waveforms.
- Resize or collapse the inspector and simulation dock, navigate with the keyboard, and recover unsaved source or graph drafts as reviewable copies.

**Current scope:** bounded Verilog/SystemVerilog/VHDL circuits, including clocked hierarchy, register construction/wiring, sampled simulation, and live editor synchronization within the [supported syntax](docs/supported-syntax.md). Full HDL standards, timed testbenches, synthesis and implicit cross-file elaboration remain outside this version. Unsupported source preserves the last valid graph. Review [real-project compatibility](docs/compatibility.md) before trying larger designs.

## Documentation

| Looking for…                                     | Start here                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Circuit editing, wiring, simulation and recovery | [User guide](docs/user-guide.md)                                          |
| Installation, bundled companion and checksums    | [Windows distribution](docs/distribution.md)                              |
| Debian install, upgrade and Linux test scope     | [Debian desktop](docs/linux.md)                                           |
| Vim, Neovim, Notepad++ and other LSP clients     | [Editor companions](docs/editors.md)                                      |
| Supported language constructs and limits         | [Syntax reference](docs/supported-syntax.md)                              |
| Build from source and run checks                 | [Development](docs/development.md)                                        |
| Design and synchronization behavior              | [Architecture](docs/architecture.md)                                      |
| Test evidence and remaining release work         | [Testing](docs/testing.md) · [Launch readiness](docs/launch-readiness.md) |
| Changes between versions                         | [Changelog](docs/changelog.md)                                            |

Found a problem? [Report a bug](https://github.com/Lithium357/Mira-Graphical/issues/new?template=bug_report.yml) with a small HDL example and the steps to reproduce it. See [contributing](CONTRIBUTING.md) for development and review guidance.

Licensed under [GPL-3.0-only](LICENSE). [Third-party licenses and notices](docs/licenses.md) accompany the packaged app.
