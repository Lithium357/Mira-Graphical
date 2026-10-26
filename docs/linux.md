# Debian desktop

Mira provides an **amd64 `.deb` package for Debian 12 and 13**, with the same HDL workbench and VS Code companion as Windows. The app bundles its Electron runtime, companion VSIX, corresponding source and licenses. Node and pnpm are only needed to build from source.

## Install and connect

Download `Mira-Graphical-0.9.8-amd64.deb` and `SHA256SUMS` from the [0.9.8 beta release](https://github.com/Lithium357/Mira-Graphical/releases/tag/v0.9.8). Check the package hash against the release checksums, then install it from your download directory:

```sh
sha256sum Mira-Graphical-0.9.8-amd64.deb
sudo apt install ./Mira-Graphical-0.9.8-amd64.deb
```

Launch **Mira Graphical** from your desktop's application menu, or run `mira-graphical`. Choose your project folder. In **Setup help → Show VS Code extension…**, locate the bundled companion; install it using VS Code's **Extensions: Install from VSIX…** command. Open the same folder in a local Linux VS Code window and run **RTL Graph: Open Current Module** on your HDL document. The graph updates after 15 seconds of inactivity. After companion upgrades, run **Developer: Reload Window** once.

The companion is also available at `/opt/Mira Graphical/resources/companion/mira-graphical.vsix`. Mira and VS Code need to run in the same Linux environment and refer to the same project path. A Windows VS Code window connected to a different WSL/SSH/container extension host is outside this local desktop setup.

## Upgrade and remove

Close Mira, then install a newer downloaded `.deb` with the same `sudo apt install ./...deb` command. Debian tracks the stable package identity `mira-graphical` and replaces the older version. Update the companion to match the app. This release uses downloaded packages; it does not configure an APT repository or automatic updates.

```sh
sudo apt remove mira-graphical
```

Removal leaves your project files, project `.hdlgraph` recovery/layout data and user settings intact. APT's normal package-manager confirmation and version rules apply; Mira does not add a Windows-style replacement wizard.

## Build and validation

On an x64 Linux machine with Node 24, pnpm 11.25.0, Git and the native `.deb` build tools (`dpkg`, `fakeroot`, `binutils`):

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm package:linux
```

Packaging requires a clean committed checkout and writes the `.deb`, corresponding source ZIP, revision manifest and `SHA256SUMS` under `dist/linux`. It does not publish or sign packages. CI uploads them as **debian-package**; release assets should come from the exact green commit.

CI runs the installed app as an ordinary user on Debian 12 and 13 in disposable containers, using Xvfb for X11. It checks dependency installation, desktop-entry validation, bundled companion/source, HDL projection, simulation, preload IPC, a version-only upgrade fixture, same-version reinstall and removal while preserving project data. The upgrade fixture reuses the current payload with older package metadata; it is not evidence of upgrading from a historical Linux release. A separate Linux desktop job runs the real graph and source-built/installed VS Code companion tests, including native Undo and unsaved-buffer synchronization.

CI containers permit the kernel namespace operations Chromium needs; Mira's launcher does **not** disable its sandbox. Run the installed app as your ordinary desktop user. The X11 tests do not certify native Wayland, every desktop environment, Orca usability, ARM64 or older Debian releases. Those remain additional compatibility checks. WSLg can help with development but does not replace Debian desktop testing.
