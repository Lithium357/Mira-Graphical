module combinational (
    input wire [7:0] a, b,
    input wire select_a, select_b,
    output wire [7:0] result
);
    // Branch comments and unrelated source are retained by local patches.
    assign result = select_a ? (a[7:0] + 8'h0F) : (b ^ 8'b0000_0011);
endmodule
