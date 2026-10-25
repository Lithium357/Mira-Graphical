# Windows distribution — 0.9.7

Download the [0.9.7 Windows public beta](https://github.com/Lithium357/Mira-Graphical/releases/tag/v0.9.7). The release assets and the **windows-installer** CI artifact contain **Mira-Graphical-Setup-0.9.7-x64.exe**, corresponding project source, a manifest and SHA-256 checksums. Run the installer, then launch Mira Graphical from the Start menu or desktop. Select your project folder on first launch; Setup help can switch folders later. In Setup help, **Show VS Code extension…** locates the bundled VSIX for VS Code's **Extensions: Install from VSIX…** command. Open that same project folder in VS Code and share an HDL file with **RTL Graph: Open Current Module**. Running the installed application needs no Node, pnpm, repository checkout or terminal.

This is an unsigned per-user NSIS installer. Windows may show an unknown-publisher/SmartScreen prompt. It supports a custom install directory, creates shortcuts and an uninstaller, and preserves project files/recovery data on uninstall. The GitHub prerelease distributes the tested unsigned build; code signing and Marketplace publishing remain deferred.

The beta also provides `mira-graphical-0.9.7.vsix` as a direct companion download. `manifest.json` describes the installer/source artifacts; `companion-manifest.json` records the separately tested VSIX from the same commit. The release's `SHA256SUMS` covers both manifests and all three downloadable packages. Update the app and companion together; after updating an active companion, run **Developer: Reload Window** in VS Code once.

## Replacing an existing version

Setup detects existing Mira installations by the stable application identity and keeps their installation scope. New installations default to the current user. The wizard keeps the checked scope fixed; an all-users upgrade checks both copies if a current-user copy would also be removed. Interactive setup shows the installed version and location and asks before replacing it; the default answer is **No**. Installing the same version offers reinstallation. A newer installed version blocks an older installer. Setup keeps the existing location by default and uses the previous uninstaller to remove old application files before writing the new build. Project folders and their recovery snapshots outside the application installation folder, along with app settings, are retained. The VS Code companion must still be updated separately through Setup help.

Silent setup (`/S`) authorizes an upgrade or same-version reinstall without a prompt; downgrade attempts exit with code **1638**. Declining interactive replacement exits with **1602** and leaves the installed app unchanged. Existing per-user and administrator-installed all-users copies are checked; this does not manage copies manually extracted outside the installer.

## Build and verify

Use the exact Git commit from the selected green CI run. On Windows with Node 24 and pnpm 11.25.0:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm test
pnpm test:soak --cycles=30 --lanes=64
pnpm run licenses
pnpm build
pnpm smoke
pnpm package:windows
pnpm test:installer
```

`pnpm smoke` packages the extension, tests the desktop, installs the VSIX into an isolated editor profile, then tests source-built and installed extension runtimes. `pnpm package:windows` builds the bundled app and NSIS installer under `dist/windows`; it requires a clean Git checkout so the included source archive matches the built application. It explicitly disables signing and publishing. Local `pnpm test:installer` launches the unpacked executable in a disposable workspace; on a disposable CI runner it additionally silently installs, runs and uninstalls the app. The Ubuntu CI job separately runs the unit suite and native GHDL/Icarus comparisons.

The Windows installer artifact includes the setup EXE, `Mira-Graphical-Source.zip`, `manifest.json`, `SHA256SUMS` and installer-check JSON. The installed app retains Electron's license, Chromium notices, GPL license, dependency notices, corresponding project source and the companion VSIX. Its runtime bundle excludes the desktop/editor development smoke harness. The source archive includes build scripts and the dependency lockfile; third-party sources are available from their pinned upstream versions. Installer identity is `com.lithium357.miragraphical`.

The Windows CI artifact `smoke-results` includes:

| File                             | Purpose                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `mira-graphical-0.9.7.vsix`      | Unsigned companion, with bundled runtime, README, GPL license and third-party notices                                                           |
| `manifest.json`                  | Package version, Git revision, dirty-checkout flag, relative filename, byte count, SHA-256, allowed source files, signing flag and Node version |
| `SHA256SUMS`                     | SHA-256 of the VSIX and manifest                                                                                                                |
| Smoke JSON, editor logs and PNGs | Validation evidence, including native keyboard/accessibility-tree and service-soak reports                                                      |

Extract the artifact's package files into the same folder. Verify the listed hashes before installing:

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $parts = $_ -split '  ', 2
  $actual = (Get-FileHash -LiteralPath $parts[1] -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $parts[0]) { throw "Checksum mismatch: $($parts[1])" }
}
```

Check that the manifest revision matches the intended CI commit and `dirty` is false. Checksums detect changed/corrupt bytes; they do not authenticate a publisher or replace signing. Packaging steps are repeatable, but ZIP timestamps/toolchain differences mean independently built VSIX files are not claimed to be byte-identical.

The app's Setup help shows the workspace and current connection state. Changing projects restarts the app after checkpointing pending work; reconnect/share the selected project's live buffer in VS Code. The editor remains responsible for saving source files. Developer launches may still use `pnpm exec electron . --workspace="C:\path\to\project"`.

Before 1.0, resolve the open gates in [launch readiness](launch-readiness.md), review [supported syntax](supported-syntax.md), attach release notes and exact-run evidence, and select the tested artifact. The 0.9.7 public beta is available on GitHub; a stable 1.0 release, Marketplace upload and signing remain separate actions.
