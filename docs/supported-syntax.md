# Supported Verilog subset

Editable means source-to-graph projection plus replacement of an existing binary operator. It does **not** mean arbitrary circuit construction.

| Construct | Support |
| --- | --- |
| One Verilog-2005 module per document | Yes |
| ANSI `input` / `output`, optional `wire` | Yes, including inherited declaration widths across comma-separated names |
| Scalar and `[decimal:decimal]` packed widths | Yes, ascending or descending |
| Internal `wire` declarations | Yes |
| Continuous `assign` to a declared output/wire | Yes, one driver per target |
| Identifier references, unsigned decimal integers | Yes (integers limited to 31-bit values) |
| Parentheses; `+ - * & | ^` | Yes, Verilog precedence and left associativity |
| Operation replacement | Yes, one exact token; refuses replacements that regroup the surrounding expression |
| Comments, whitespace, CRLF, Unicode in comments | Preserved; patches use UTF-16 document offsets |
| Multiple shared documents | Yes, independently debounced within one workspace/editor connection |
| Multiple modules in one file | Rejected visibly |
| Undeclared identifiers, multiple drivers, cycles | Rejected visibly |
| Sized/base literals, unary operators, slices, concatenation, muxes | Unsupported |
| `reg`, `always`, instances, macros, parameters, generate, SystemVerilog | Unsupported |
| Creating/deleting/rewiring graph nodes | Unavailable; use source |

Graph widths show declared net widths and operand-derived expression widths for the supported unsigned subset. This is an RTL expression view, not synthesis or a complete Verilog elaborator. It does not check truncation, timing, undriven nets or simulate behavior. The entire module is refused when unsupported constructs are present; the UI must not imply a partial graph is complete.

Harmless formatting and operator changes retain identity. Renamed modules, assignment targets or nets get new identities. Expression-tree paths provide stable identity for simple local operations, not arbitrary algebraic rewrites. Replacements that change precedence grouping require explicit parentheses in the text first.
