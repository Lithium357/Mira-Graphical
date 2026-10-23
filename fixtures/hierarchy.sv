// SystemVerilog combinational hierarchy; no clocked behavior.
module arithmetic(input logic [7:0] a, b, output logic [7:0] result);
    always_comb result = a + b;
endmodule

module workbench(input logic [7:0] a, b, input logic select_b,
                 output logic [7:0] result, output logic [15:0] joined, product);
    logic [7:0] sum;
    arithmetic add_stage (.a(a), .b(b), .result(sum));
    assign joined = {a, b};
    assign product = a * b;
    always_comb begin
        if (select_b) result = sum;
        else result = a;
    end
endmodule
