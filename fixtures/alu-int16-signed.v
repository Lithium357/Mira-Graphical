// Reported ALU with explicit signed comparisons and an unsigned mux context.
module ALU_FP16 (
    input wire [15:0] OPa,
    input wire [15:0] OPb,
    input wire [3:0] opcode,
    output wire [15:0] result
);
endmodule

module ALU_INT16 (
    input wire [15:0] OPc,
    input wire [15:0] OPd,
    input wire [3:0] opcode,
    output wire [15:0] result
);
    assign result = (opcode == 4'b0000) ? (OPc + OPd) :
                    (opcode == 4'b0001) ? (OPc - OPd) :
                    (opcode == 4'b0010) ? (OPc & OPd) :
                    (opcode == 4'b0011) ? (OPc ^ OPd) :
                    (opcode == 4'b0100) ? (OPc | OPd) :
                    (opcode == 4'b1000) ? (OPc << OPd) :
                    (opcode == 4'b1001) ? (OPc >> OPd) :
                    (opcode == 4'b1010) ? (OPc * OPd) :
                    (opcode == 4'b1100) ? (~OPc) :
                    (opcode == 4'b1011) ? (OPc == OPd) :
                    (opcode == 4'b1101) ? (OPc != OPd) :
                    (opcode == 4'b1110) ? (OPc >= OPd) :
                    (opcode == 4'b1111) ? (OPc <= OPd) :
                    (opcode == 4'b0101) ? ($signed(OPc) >= $signed(OPd)) :
                    (opcode == 4'b0110) ? ($signed(OPc) <= $signed(OPd)) :
                    (opcode == 4'b0111) ? ($signed(OPc) >>> OPd) :
                    16'b0;
endmodule
