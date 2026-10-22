module sequential(input clk, output reg q);
  always @(posedge clk) q <= 1;
endmodule
