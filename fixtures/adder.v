module adder (
    input wire [7:0] a,
    input wire [7:0] b,
    output wire [7:0] sum
);
    // Preserve this comment.
    assign sum = a + b;
endmodule
