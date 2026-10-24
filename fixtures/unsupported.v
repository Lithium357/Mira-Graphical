module sequential(input clk, output reg q);
  always @(posedge clk) #1 q <= 1;
endmodule
