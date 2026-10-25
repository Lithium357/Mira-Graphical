# Keyboard and screen-reader use

Mira provides keyboard controls and semantic HTML alongside the circuit drawing. These features do not constitute a screen-reader conformance certification.

## First circuit

1. Choose your project folder in Mira and open that same folder in VS Code.
2. In Mira's Setup help, use **Show VS Code extension…** to locate the bundled companion. In VS Code, press **Ctrl+Shift+P**, choose **Extensions: Install from VSIX…**, and select it. After updating an active companion, run **Developer: Reload Window** once.
3. Open an HDL file and run **RTL Graph: Open Current Module**. Setup help distinguishes an editor connection from a shared file and shows the next step. Unsaved buffers can be shared; sharing does not save the file.
4. Wait for **Synced** or review the diagnostic. Edits synchronize after 15 seconds of inactivity. The visual countdown is excluded from live announcements so each tick does not interrupt reading. The companion automatically reconnects after a Mira restart.

## Navigate and edit without a mouse

- Use **Tab** and **Shift+Tab** for controls, and **Enter** or **Space** to activate buttons and disclosures. **Escape** closes dialogs and returns focus to their opener.
- In **View → Component navigator**, choose a named component, then **Inspect component**. The inspector exposes component type, width, connection counts and wiring controls. Components and connections also have readable names in the graph accessibility tree.
- **Skip circuit to inspector** appears when keyboard-focused before the canvas. It avoids tabbing through a large graph. **Escape** from the inspector returns to **Add component**.
- Use the inspector to select named source signals and connect inputs. The palette supports register creation with labelled clock/reset/data controls. Shared procedural blocks may still require HDL editing.
- Open **Simulation**, set labelled inputs and choose **Sample inputs** or a clock-step button. Expand **Sample values** for the **Sampled signal values** table. Row headers identify complete signal names; column headers identify sample numbers. The visual waveform can truncate labels; the table retains their complete text.
- Use **Trace → Copy CSV** for an export, and the named pane dividers' arrow-key controls to resize panels. Recovery exposes reviewable text; it does not overwrite the original file automatically.

## Validation record — 2026-10-25

The 0.9.6 development review used fresh disposable Mira and VS Code profiles with synthetic HDL. Native regressions cover first-run instructions, connected-without-a-file guidance, quiet countdowns, setup/recovery modal focus, component navigation, wiring, palette search, the skip-canvas control, simulation and scoped sample-table headers. The source and installed-companion suites separately cover live unsaved edits and native Undo.

A portable [NVDA 2026.2](https://github.com/nvaccess/nvda/releases/tag/release-2026.2) copy was verified against its publisher SHA-256 and Windows signature. A subsequent interactive review overcame the initial window-targeting obstacle and exercised setup, a real fresh-profile companion share, component inspection, combinational simulation, sample-table navigation, recovered-copy opening and clock/reset controls. A follow-up completed keyboard wiring through the live editor, native Undo and a spoken source-error location. NVDA's speech log confirmed labelled controls, table headers/values, status announcements and the diagnostic alert. See the [versioned results and exact limits](qa/nvda-0.9.6.md).

This agent-assisted interoperability check used audio synthesis disabled, following NVDA's documented developer workflow for [speech output inspection](https://download.nvaccess.org/releases/2026.2/documentation/en/userGuide.html#SpeechViewer). It was not a fully keyboard-only journey or a human acceptance session. No complete NVDA or JAWS user acceptance is claimed.

An experienced screen-reader user should still try installation, first share, diagnostics, component selection/wiring, register stepping, sample-table navigation and recovery using their usual speech settings. Record the app, companion and screen-reader versions, where focus or announcements become confusing, and whether the task can be completed. A fresh-profile agent review also does not replace an unfamiliar person's onboarding trial.
