# Contributing to Mira

Mira is a Windows HDL workbench in testing preview. Start with the [supported syntax](docs/supported-syntax.md), [user guide](docs/user-guide.md) and [development instructions](docs/development.md).

## Report a problem

Use the [bug report form](https://github.com/Lithium357/Mira-Graphical/issues/new?template=bug_report.yml). Include the app version, Windows and VS Code versions, steps to reproduce, expected behavior, and a small HDL example you can share publicly. Include the visible diagnostic and whether the source buffer had unsaved changes. Remove private project details, paths and credentials from examples and screenshots.

If a construct is outside the documented subset, describe the language feature you need and its intended behavior in a feature request. Compatibility reports are useful even when Mira correctly refuses the source.

## Make a change

Explain the problem and resulting behavior in your pull request. Keep changes focused and update the relevant docs when behavior or supported syntax changes. Source synchronization changes need tests for source preservation, revision guards and native Undo; parser or simulation changes need meaningful HDL examples and reference checks where applicable.

Run `pnpm lint`, `pnpm format:check` and `pnpm test` for code changes. Use `pnpm build` and `pnpm smoke` for desktop/editor behavior. Documentation-only changes need formatting and valid links. The [testing guide](docs/testing.md) describes the larger checks and their prerequisites.

The repository owner pushes completed work directly to `main` until 1.0.0 launches, then uses branches. External contributors should submit pull requests. Never force-push over remote work.

## License

Contributions are distributed under the repository's [GPL-3.0-only license](LICENSE). Preserve third-party notices and document new dependencies in the license audit.
