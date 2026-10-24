# External-project compatibility review

The historical 0.7.0 review tested **15 unmodified public source files at pinned revisions**. None projected successfully at that version. The table records that historical result: 0.9.4 adds bounded standalone clocked modules, so the event-control result is no longer a blanket current limitation. The original external files have not been revalidated for this expansion. No upstream scripts were run, source was not rewritten, and downloaded code stays in ignored `test-results/external-projects/`.

| Sample                                                                                                                                                        | Revision                                   | Result and launch decision                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [nand2tetris-iverilog ALU building blocks](https://github.com/wuhanstudio/nand2tetris-iverilog/tree/06a924223f4fb37194ddb0c644432fc6ca16ea72/1-ALU), 14 files | `06a924223f4fb37194ddb0c644432fc6ca16ea72` | Refused at `default_nettype`. These files also use external module definitions, positional instances and primitive/unary forms outside the subset. Keep these unsupported for the narrow first release; do not silently strip directives or claim the whole ALU imports. |
| [Yosys tutorial counter](https://github.com/YosysHQ/yosys/blob/5053d0e266d9e5f895211e39e6ee3a94cbba408a/docs/source/code_examples/intro/counter.v)            | `5053d0e266d9e5f895211e39e6ee3a94cbba408a` | Refused at event control. Clocked designs remain outside the combinational release scope.                                                                                                                                                                                |

[Machine-readable results](compatibility-samples.json) record exact paths, SHA-256 hashes, source URLs and first diagnostics. The explicit preprocessor/event messages added during this review preserve original UTF-16 offsets and are regression tested.

To repeat using the pinned public files:

```powershell
pnpm test:external --download
```

To retest already downloaded files offline, run `pnpm test:external`. This optional compatibility review requires network only for downloads and is separate from CI's supported-subset assertions. A refusal is reported rather than treated as a passing compatibility test.

The three-language lane-datapath soak is generated project-scale coverage of the supported subset. It does not turn these external-project refusals into successes. Additional independently authored, in-scope projects and user trials remain useful before 1.0; native SystemVerilog/VHDL compiler fixtures are covered separately.
