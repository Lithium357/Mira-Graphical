module workbench (
    input wire [7:0] a, b,
    input wire select,
    output wire [15:0] joined,
    output wire [7:0] result
);
    wire [7:0] sum;
    // Reusable child module, connected by named ports.
    arithmetic add_stage (.a(a), .b(b), .result(sum));
    assign joined = {a, b};
    assign result = select ? sum : a;
endmodule

module arithmetic (input wire [7:0] a, b, output wire [7:0] result);
    assign result = a + b;
endmodule
