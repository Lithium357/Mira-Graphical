# Saved simulation tests

These features are on `main`, after the published 0.9.9 beta. Build from source to use them until the next packaged release.

Open **Simulation**, set every input, then use **Sample inputs** and **Step clock** to record a sequence. For Verilog/SystemVerilog registers, include an initial reset sample. VHDL enum signals start at their leftmost declared member. Each clock step records both its inactive and active clock samples, so replay reproduces the edge.

Expand **Saved tests**, give the sequence a name and choose **Save recorded test**. The test records the current output and watched signal values as expectations. Review those values before treating the test as a correctness check. Saving with the same name and module replaces that saved test. Recording retains the first 128 samples; restart simulation to start another sequence. Clearing the displayed trace preserves both simulation state and the recorded sequence.

Select a saved test and choose **Run test** after an HDL change. Each run starts a separate simulation; it does not disturb the interactive register state or trace. The result reports PASS/FAIL, sample and assertion counts, and expected/actual values for failures (the UI shows the first 128 failures). Changed port lists, missing signals and oversized values are errors rather than silent passes. A source/module/dependency revision clears the displayed result; rerun to check the new design.

Tests compare numeric values across decimal, hexadecimal and binary notation. Unknown bits compare exactly: `x` is not a don't-care wildcard. Every sample must provide every input port, even when it has no assertions. A test must contain at least one expected value.

Tests live in `.hdlgraph/tests-<source-URI-hash>.json`, with up to 32 tests and 1.5 million characters per source. Include these metadata files in project backups if you want to retain the tests. No source files are saved. **Copy test JSON** and **Import test JSON** provide a portable format for sharing tests or moving them between project paths. **Delete test** removes only the selected test metadata.

Run exported JSON, or a saved metadata array, without the desktop:

```sh
pnpm test:simulation --source=fixtures/enum-fsm.sv --tests=fixtures/enum-fsm.test.json
pnpm test:simulation --source=top.sv --source=child.sv --tests=tests.json
```

The command prints JSON and exits nonzero on an assertion failure or invalid test/source. Paths are explicit; it does not discover or execute project scripts. This is the same bounded, sampled, zero-delay simulator as the desktop, not a timed HDL testbench runner.

## State machine view

Choose **View → State machines** to derive a state diagram from clocked enum register drivers. Select a register when a module has several. Named states, encodings, reset paths, holds and transition conditions appear in a diagram and tables. Transition numbers connect the drawing to the condition table; the tables provide the full text and keyboard/screen-reader access. Simulation samples highlight the active named state. A pending source revision labels the diagram stale and suppresses active-state highlighting.

Both SystemVerilog enum FSMs and architecture-local VHDL enum FSMs are supported. Next-state combinational drivers are followed through named signals. The view describes transitions among declared states; it does not enumerate invalid encodings or prove reachability. Conditional expressions may include impossible combinations that have not been algebraically simplified. Dynamic transfers from another register or display-limit overruns produce an explanation instead of an incomplete diagram. The view is bounded to 512 transitions per register. Drawn states/transitions do not generate HDL yet.

## Linked project sources

Explicitly share the parent and dependency files from your editor, then choose **View → Project sources** in the parent and select its dependencies. Up to 16 total files and one million aggregate UTF-16 units participate. Verilog and SystemVerilog may be linked together; VHDL files may be linked together. Cross-language elaboration, macros, packages, parameterized instances and filesystem source discovery remain unsupported.

The linked design uses current editor buffer contents, including unsaved changes. Dependencies remain separate files; no definitions are copied. Their changes restart the parent's 15-second synchronization interval and invalidate simulation state and test results. Duplicate module/entity names, unresolved definitions, recursion and invalid dependencies are rejected. Closing/disconnecting a dependency blocks the parent until it is shared again or removed from Project sources.

Linked projects support hierarchy browsing, simulation, saved tests and state diagrams. **Graph construction and component copying are disabled while linked**: edit the source in your editor, or disconnect the sources to resume the existing single-document graph editing workflow. Definitions must then be self-contained. This avoids sending a source patch whose proof depends on another buffer revision.

Source selections are stored under `.hdlgraph/sources-<source-URI-hash>.json`. Reopening restores the selection but never opens or reads dependency files automatically: share the selected dependencies again. Selections are scoped to the selected document; links are not transitive, so list every required dependency. Imports that copy definitions remain available for self-contained graph editing.
