# User guide

Install the [Windows testing build](https://github.com/Lithium357/Mira-Graphical/releases/tag/v0.9.0), then follow [setup and verification](distribution.md). For source builds, see [development](development.md).

## Adder demo

1. Start the app in this repository and open `fixtures/adder.v` in the Extension Development Host.
2. Run Open Current Module. After 15 quiet seconds, the canvas shows inputs `a` and `b`, an ADD operation, and output `sum`, all with eight-bit widths.
3. Select ADD and click **MUL** in the inspector. After another 15 quiet seconds, VS Code changes only `+` to `*`. The comment and spacing remain unchanged; the document may remain unsaved. Press Undo in VS Code to reverse the patch.
4. Type `-` into the live buffer without saving. Wait 15 seconds: the graph shows SUB.
5. Drag the operation to a custom position. No source edit occurs. Quit and restart the graph app, then reopen the module through the extension: the position persists.
6. Leave a half-written expression and wait 15 seconds: a diagnostic appears while the last valid graph stays visible. Finish the expression to resume synchronization.

Later semantic user edits take priority over pending earlier edits. Movement may restart the inactivity interval but never changes that priority. Superseded work is saved under `.hdlgraph/recovery-*.json`; see [recovery and architecture](architecture.md). The conservative graph-last rebase only patches selected operators and retains unrelated source work. Changed operands, ambiguous source or precedence changes are refused visibly.

## Recover unsaved work

Mira checkpoints explicitly shared live buffers and pending graph drafts in the workspace's `.hdlgraph` directory as they change, before the synchronization timer expires. On a new session, a different previous checkpoint is archived before replacement. Checkpoint failures appear in the app while your live editing session stays available. These local snapshots do not save or overwrite your HDL files.

Click **Recovery** in the desktop header, select a snapshot, and choose its original buffer or pending graph preview. **Open recovered copy** opens a separate untitled document in connected VS Code; **Compare in VS Code** opens a native diff against an explicitly shared current buffer. Review and copy the changes you want to keep. **Copy text** works even without an editor connection. Recovery never replays saved actions or replaces current work automatically. Up to 100 recent snapshots are listed; files are not automatically deleted. Include `.hdlgraph/` in your project's ignore rules.

## Build and wire a circuit

Share a supported module (including `module blank(); endmodule`), wait for synchronization, then click **Add component**. Create arithmetic/bitwise operations, muxes, constants, fixed slices, named wires, input ports or output ports. New operations and muxes start with explicit zero inputs.

Drag a named signal or component result handle to an input socket, or select a component and use the inspector's **Source signal** and **Connect** buttons. Rewiring replaces that input. Result names are the declared wires assigned by components; nested expressions need a named result before they can be shared. Mux selectors require a one-bit signal. Combinational cycles are rejected.

Changes preview immediately and synchronize as one native VS Code edit after 15 quiet seconds. **Undo pending**, **Redo pending** and **Discard pending** manage the current batch; after synchronization use VS Code's native Undo. Structural changes wait while newer source text is pending. Superseded/discarded drafts have full preview text in recovery snapshots.

The inspector can disconnect a named driver, remove an unused component, or explicitly replace an expression with zero. Undriven wires and outputs are visibly marked. Removing a result still used elsewhere is refused; disconnect consumers first. Ports stay in the module interface, shared wire declarations must be split in VS Code before deletion, and edits that would delete comments are refused. Verilog/SystemVerilog use assignment extension/truncation; VHDL enforces exact types and widths and emits explicit conversions/resizes when wiring requires them.

## Buses, diagnostics and faster editing

Use **concat** to join a comma-separated list of signals in most-significant-first order. Use **split** with a source bus and chunk width to create named slice results, `_0` starting at the least-significant end. Ascending declarations are respected. A fixed slice such as `[3]` selects one bit. Each concatenation part has its own wiring socket.

The canvas flags undriven and unused signals, width extension, truncation and vector selectors. Expand **circuit warnings** in the inspector to select the relevant component. Verilog/SystemVerilog widths follow unsigned context rules; a wider arithmetic destination can preserve carry/product bits. VHDL follows native numeric_std result widths and requires explicit resize/conversion nodes.

Search the component palette by name or by “bus”/“port”. Drag a selection box on empty canvas, or hold Shift while dragging; Ctrl/Meta-click adds nodes. Use **Copy**, **Paste**, **Duplicate**, or Ctrl/Meta+C/V/D while the canvas is focused. Ctrl/Meta+K opens the palette. The clipboard stays inside Mira. Named subgraphs preserve internal connections, create unique names and retain external references only when those signals exist in the destination. Select a root expression to duplicate its result as a wire; selecting a port explicitly duplicates that interface port, which can be refused if it would invalidate existing instances. **Wire labels** shows signal names and widths.

## Workspace controls

The circuit uses the full workspace until you select a component or open **Inspector**. Close the inspector to reclaim that space. Drag the divider to resize it; focused dividers also accept arrow keys, Home and End. Pane sizes are remembered locally.

**Add component** and **Simulation** stay on the main toolbar. **Edit** contains Undo/Redo, discard and clipboard actions; the selected component also offers Copy/Duplicate in its inspector. **View** contains wire labels and **Readable zoom**. The fit control gives a complete overview; Readable zoom favors legible nodes, with pan/zoom for larger circuits.

Simulation docks below the circuit. Drag its top divider, minimize it to keep samples while reclaiming canvas space, or close it. Inputs sit beside waveforms, with trace choices under **Signals**. The page itself does not scroll; each open pane owns its content scrolling.

## Simulation and waveforms

Open **Simulation**, set top-level inputs using decimal, `0x` hex, `0b` binary or `x`, then click **Sample inputs**. Values appear on nodes and in the waveform panel. Each click records an input vector, not a timed clock cycle. Choose up to 16 traces, inspect the latest 64 samples, or copy the trace as CSV. Samples reset when source/draft semantics change or modules change; layout-only movement preserves them.

The built-in evaluator supports this unsigned combinational subset, including concatenations, ascending/descending slices, muxes and nested module instances. It retains unknown bits: bitwise operations and unknown-selector muxes can resolve known bits; arithmetic involving unknown operands is pessimistic. Undriven nets display `x` (the viewer does not distinguish high impedance). No sequential/event-driven timing, clocks, testbench language or synthesis is implemented. Simulation is local and never edits source. It is bounded to 4096-bit values and 512 expanded signals.

## Reusable modules

Try `fixtures/hierarchy.v`. Select the `add_stage` instance and choose **Open module**, or use the **Module definition** picker. Child edits target the child definition and affect every instance after synchronization. Node identities, manual positions and module viewports survive navigation. Synchronize or discard a pending batch before switching modules.

Choose **module** in the palette to add an empty definition, then select it after synchronization and construct its interface/body. Choose **instance** to place an existing definition: inputs start tied to zero and outputs get named wires. Wire each named input socket; result wires can feed other components. For definitions in another file, explicitly share that file and use **Import from another shared file** in the construction panel. Mira copies the selected definition and its dependencies into the target document; it does not create a live cross-file link. Duplicate module names are refused. All instance definitions must be present in the resulting document, with each named port connected exactly once. Recursive, parameterized, positional and black-box instances are unsupported. Removing an instance leaves its result wires visibly undriven.

## Supported scope and limitations

Supports up to 64 combinational ANSI-style module definitions per file, named-port instances, concatenations; scalar/vector input and output ports; internal wires; continuous assignments; unsigned decimal and sized binary/octal/decimal/hex constants; fixed bit/part selections; parentheses; binary `+`, `-`, `*`, `&`, `|`, `^`; and ternary mux expressions. The inspector can change operators, literal tokens, slice ranges, and simple scalar mux selectors. See the [exact syntax matrix](supported-syntax.md).

Try `fixtures/combinational.v`: select `8'h0F` and queue `8'h2A`, select `a[7:0]` and queue `[3:0]`, or select MUX and choose `select_b`. Each change stays within its exact source span after 15 quiet seconds. Invalid digits, overflowing constants, out-of-bounds slices, cycles and unsafe precedence changes are rejected.

Keyboard arrow keys move selected nodes and save their positions. Newly shared modules open automatically in the module picker. Window bounds are saved on close and restored on a connected monitor; unplugged-monitor bounds are clamped back on screen.

Unsupported constructs reject the projection rather than silently disappearing. Layout and graph identities are independent of source formatting and operator spelling. New nodes receive left-to-right dependency placement; a committed removal discards their old position. Renames and structural expression rewrites may create new identities. Recovery opens reviewable copies; merging recovered changes remains manual. Sequential simulation, synthesis, multi-workspace window management and arbitrary Verilog support remain outside this version.
