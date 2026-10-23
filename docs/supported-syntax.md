# Supported Verilog subset (0.2.0)

The graph supports targeted local edits, not arbitrary circuit construction.

| Construct                                                                   | Support                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| One Verilog-2005 module per document                                        | Yes                                                                                                    |
| ANSI input/output, optional wire, inherited comma-separated port widths     | Yes                                                                                                    |
| Scalar and constant packed widths, ascending or descending                  | Yes                                                                                                    |
| Internal wires; continuous assignments to output/wire                       | Yes; one driver per target                                                                             |
| Identifiers, decimal literals with underscores                              | Yes; unsized values limited to 31-bit positive integers                                                |
| Sized unsigned binary/octal/decimal/hex literals                            | Yes, e.g. `8'hFF`, `4'b10_10`, `12'd1_234`; 1–4096 bits                                                |
| Literal replacement                                                         | Editable exact token; invalid digits, unknown values and overflow are refused                          |
| Fixed bit and part selections                                               | Yes, e.g. `a[3]`, `a[7:0]`; bounds and direction checked against the declaration                       |
| Slice range replacement                                                     | Editable exact bracket span; source net remains unchanged                                              |
| Parentheses and binary `+ - * &                                             | ^`                                                                                                     | Yes; correct precedence and left associativity |
| Operator replacement                                                        | Editable exact token; changes that regroup neighboring expressions are refused                         |
| Ternary `condition ? true_value : false_value`                              | Visualized as MUX, including nested right-associative ternaries                                        |
| Mux selector replacement                                                    | Editable when the condition is a simple reference; choose a declared scalar signal                     |
| Complex mux condition                                                       | Visualized; supported operators/literals inside it remain editable; change structural wiring in source |
| Comments, spacing, CRLF, Unicode comments                                   | Unrelated text preserved; UTF-16 offsets match live editor buffers                                     |
| Multiple shared files                                                       | Independent sessions in one workspace/adapter connection                                               |
| Multiple modules per file; multiple drivers; undeclared identifiers; cycles | Rejected visibly                                                                                       |
| Signed or unsized based literals, x/z values, unary operators               | Unsupported                                                                                            |
| Indexed/variable part selects, concatenation, parameterized widths          | Unsupported                                                                                            |
| reg/always, instances, macros, parameters, generate, SystemVerilog          | Unsupported                                                                                            |
| Creating/deleting/rewiring components through the graph                     | Unavailable; edit source                                                                               |

Input widths and expression widths are derived for this unsigned subset. This is not full elaboration or simulation: assignment truncation, signedness, timing and undriven-net behavior are not analyzed. Sized constants that would truncate are refused conservatively. A module is limited to 4096 lexical tokens and 128 recursive expression levels. Unsupported syntax refuses the complete projection and retains the last valid graph; no partial graph is silently advertised as complete.

Each editable token, range or selector has independent parser, source-span and bidirectional patch tests. The editor independently parses and validates allowed AST spans before applying a patch. The exact source revision and hash must still match. No change pretty-prints or replaces the whole file.

Formatting/operator changes retain structural IDs and manual positions. Renamed nets/targets/modules or changed expression structure may allocate new IDs. Literal, operation, slice and mux entities use distinct identity keys; replacing a component with another kind and later recreating it does not revive its old position.
