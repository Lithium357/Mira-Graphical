// SPDX-License-Identifier: GPL-3.0-only
module register_stage(input logic clk,reset,en,input logic [7:0] d,output logic [7:0] q);
always_ff @(posedge clk or posedge reset) begin
  if (reset) q <= 8'd0;
  else if (en) begin
    case(d[1:0])
      2'b00: q <= d + 8'd1;
      2'b01, 2'b10: q <= d ^ 8'h55;
      default: q <= d;
    endcase
  end
end
endmodule
module pipeline(input clk,reset,en,input [7:0] data,output [7:0] first,second);
register_stage a(.clk(clk),.reset(reset),.en(en),.d(data),.q(first));
register_stage b(.clk(clk),.reset(reset),.en(en),.d(first),.q(second));
endmodule
