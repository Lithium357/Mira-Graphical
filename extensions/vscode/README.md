# Mira Graphical companion

Share an open Verilog, SystemVerilog or VHDL buffer with the separate Mira desktop workbench. The companion supports unsaved-buffer synchronization and guarded native edits for circuit construction, buses, named hierarchy and clipboard actions. Source edits synchronize after 15 seconds of inactivity; the extension never saves files automatically. Native VS Code Undo reverses a synchronized batch.

## Install from VSIX

Build with `pnpm package:extension` in the repository root, then use **Extensions: Install from VSIX…** and choose `dist/packages/mira-graphical-0.9.3.vsix`. Packaging does not publish to the Marketplace or create a desktop installer.

Start Mira for the same workspace, open a `.v`, `.sv`, `.vhd` or `.vhdl` file and run **RTL Graph: Open Current Module**. Only explicitly shared files participate. Reconnect/reopen after restarting the desktop service. Source development with the repository's F5 configuration remains supported.

Commands: **RTL Graph: Open Current Module**, **RTL Graph: Connect/Disconnect**, **RTL Graph: Show Sync Status**.

Version 0.9.3 supports the desktop **Recovery** browser. Recovered source/drafts open as separate untitled copies or native comparisons with an explicitly shared current buffer. Review never overwrites or saves your source. Older companion versions can still connect for ordinary editing but must be upgraded to open recovery; desktop clipboard recovery remains available offline.

[Setup, supported syntax, simulation limits and verification](https://github.com/Lithium357/Mira-Graphical#readme). This is an unsigned, local pre-1.0 extension for the documented combinational subset with explicit signed expression casts. The desktop window provides the graph and simulator.
