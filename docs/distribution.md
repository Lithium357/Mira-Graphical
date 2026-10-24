# Unsigned distribution — 0.7.0

The distributable currently produced by this repository is the **VS Code companion VSIX**. The desktop app runs from a built checkout; there is no desktop installer or signed desktop bundle. Do not advertise the VSIX as the complete application.

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
```

`pnpm smoke` packages the extension, tests the desktop, installs the VSIX into an isolated editor profile, then tests source-built and installed extension runtimes. To package without running the graphical suite, use `pnpm package:extension`; that alone is not release validation. The Ubuntu CI job separately runs the entire unit suite and native GHDL/Icarus reference comparisons.

The Windows CI artifact `smoke-results` includes:

| File                             | Purpose                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `mira-graphical-0.7.0.vsix`      | Unsigned companion, with bundled runtime, README, GPL license and third-party notices                                                           |
| `manifest.json`                  | Package version, Git revision, dirty-checkout flag, relative filename, byte count, SHA-256, allowed source files, signing flag and Node version |
| `SHA256SUMS`                     | SHA-256 of the VSIX and manifest                                                                                                                |
| Smoke JSON, editor logs and PNGs | Validation evidence, including native keyboard/accessibility-tree and service-soak reports                                                      |

Extract the three package files into the same folder. Verify both hashes before installing:

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $parts = $_ -split '  ', 2
  $actual = (Get-FileHash -LiteralPath $parts[1] -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $parts[0]) { throw "Checksum mismatch: $($parts[1])" }
}
```

Check that the manifest revision matches the intended CI commit and `dirty` is false. Checksums detect changed/corrupt bytes; they do not authenticate a publisher or replace signing. Packaging steps are repeatable, but ZIP timestamps/toolchain differences mean independently built VSIX files are not claimed to be byte-identical.

Install through VS Code's **Extensions: Install from VSIX…**. Start the desktop from the same checkout with `pnpm exec electron . --workspace="C:\path\to\project"`, open that folder in VS Code, then run **RTL Graph: Open Current Module** on a supported file. The app's Setup help repeats these steps and displays the workspace and current connection state. The editor remains responsible for saving files.

Before 1.0, resolve the open gates in [launch readiness](launch-readiness.md), review [supported syntax](supported-syntax.md), attach release notes and exact-run evidence, and select the tested artifact. Publishing a GitHub release, Marketplace upload, installer and signing are separate actions.
