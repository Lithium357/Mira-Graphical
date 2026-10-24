# License audit

Original project source is GPL-3.0-only; the existing root LICENSE contains GPL version 3. Source files carry SPDX identifiers. Dependencies retain their own licenses.

`pnpm run licenses` traverses the actually installed dependency graph from root dependencies, avoiding stale packages in pnpm's store. The explicit `run` is required because pnpm has a separate built-in `licenses` command. The audit records package name, exact version, declared SPDX license and discovered notice files in `third-party-licenses.json`, and concatenates full notices into `THIRD_PARTY_NOTICES.txt`. Unknown licenses fail for review. Optional packages for other operating systems are not installed/audited on Windows; rerun on each release platform.

Reviewed families: MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, CC0-1.0, Apache-2.0 and Python-2.0 are compatible with GPLv3 aggregation. For dual-license packages, select MIT/Apache/CC0 rather than imposing another GPL license. Lightning CSS's standard MPL-2.0 license is compatible with GPLv3 through its secondary-license provision; its unmodified code remains MPL and its notice is retained. No dependency is being relicensed.

The React Flow attribution remains visible. The extension and Windows builds retain the GPL license and generated notices. The Windows distribution also retains Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`. It includes `Mira-Graphical-Source.zip` for the exact clean Git revision and the build/lock files needed to reproduce the project. Source dependencies and unmodified Electron upstream sources remain available at their versioned upstream repositories. The installer and app are intentionally unsigned.

The installer packager adds development dependencies declared as WTFPL, `WTFPL OR ISC`, and `(WTFPL OR MIT)`. The dual licenses can use ISC/MIT; [GNU lists WTFPL v2 as GPL-compatible](https://www.gnu.org/licenses/license-list.html#WTFPL). The audit retains their declarations and available notices. The unused Squirrel `electron-winstaller` postinstall script is disabled; this build uses NSIS. Development packaging tools are excluded from the runtime bundle.

The security audit (`pnpm audit`) is a separate online check. It is not a license audit or a permanent guarantee. The lockfile fixes the tested versions; review updates and rerun tests before release.

## VSIX development tools

The locked official VSIX packager adds Artistic-2.0 and BlueOak-1.0.0 dependency notices; the [Blue Oak license](https://blueoakcouncil.org/license/1.0.0) permits reuse with its notice. All installed package metadata and full notice texts remain in the audit output, with a runtime/development flag.

The packager also depends on `@vscode/vsce-sign` 2.1.0 and its platform helper 2.0.6, under Microsoft VSCE-SIGN terms. These are development-only tools for VS Code development/testing, not GPL runtime components and not part of the VSIX or app bundle. Their signing/postinstall script is explicitly disabled. The audit accepts only these exact helper versions, only outside the runtime dependency closure, and only with the reviewed LICENSE.txt SHA-256 `80780388a077c74609a5fc7ee1cc3d382740a5e48d87f7aac5a20cbddef3e91c`. Other custom licenses or changed terms still fail review. The package script verifies an exact runtime/document/license file allowlist before producing a VSIX; it never packages node_modules or the signing helpers. No signing certificates, credentials or publishing are used.

The workspace narrowly overrides `@azure/identity>@azure/msal-node` to 7.1.0 to address [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5), while the packager's upstream dependency still requests the affected 6.x range. This affects development packaging dependencies only. Unsigned packaging and installation are verified; Azure authentication and Marketplace publishing are outside this workflow. Remove the override when upstream adopts a patched range. The CI high-severity audit gate and full license inventory cover the resolved graph.
