# License audit

Original project source is GPL-3.0-only; the existing root LICENSE contains GPL version 3. Source files carry SPDX identifiers. Dependencies retain their own licenses.

`pnpm run licenses` traverses the actually installed dependency graph from root dependencies, avoiding stale packages in pnpm's store. The explicit `run` is required because pnpm has a separate built-in `licenses` command. The audit records package name, exact version, declared SPDX license and discovered notice files in `third-party-licenses.json`, and concatenates full notices into `THIRD_PARTY_NOTICES.txt`. Unknown licenses fail for review. Optional packages for other operating systems are not installed/audited on Windows; rerun on each release platform.

Reviewed families: MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, CC0-1.0, Apache-2.0 and Python-2.0 are compatible with GPLv3 aggregation. For dual-license packages, select MIT/Apache/CC0 rather than imposing another GPL license. Lightning CSS's standard MPL-2.0 license is compatible with GPLv3 through its secondary-license provision; its unmodified code remains MPL and its notice is retained. No dependency is being relicensed.

The React Flow attribution remains visible. The extension build copies GPL LICENSE and the generated notices beside its bundle. Electron binaries include additional Chromium and other embedded third-party components: a future desktop packager must retain Electron's LICENSE and `LICENSES.chromium.html`, alongside the source and applicable GPL obligations. The current deliverable runs from source and is not a signed or published binary distribution.

The security audit (`pnpm audit`) is a separate online check. It is not a license audit or a permanent guarantee. The lockfile fixes the tested versions; review updates and rerun tests before release.
