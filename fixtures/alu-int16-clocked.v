// SPDX-License-Identifier: GPL-3.0-only
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

output wire [15:0] result,
    output wire carry,
    output wire overflow

);

wire [16:0] sum17;
    wire [16:0] diff17;

wire add_overflow;
    wire sub_overflow;

wire signed [31:0] mul_full;
    wire mul_overflow;

assign sum17 = {1'b0, OPc} + {1'b0, OPd};
    assign diff17 = {1'b0, OPc} - {1'b0, OPd};

assign carry = (opcode == 4'b0000) ? sum17[16] :
                   (opcode == 4'b0001) ? ~diff17[16] :
                   1'b0;

assign add_overflow = (OPc[15] == OPd[15]) && (result[15] != OPc[15]);
    assign sub_overflow = (OPc[15] != OPd[15]) && (result[15] != OPc[15]);

assign mul_full = $signed(OPc) * $signed(OPd);
    assign mul_overflow = (mul_full[31:16] != {16{mul_full[15]}});

assign overflow = (opcode == 4'b0000) ? add_overflow :
                      (opcode == 4'b0001) ? sub_overflow :
                      (opcode == 4'b1010) ? mul_overflow :
                      1'b0;

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

module INT16_MUL (

input wire clk,
    input wire reset,
    input wire start,

input wire signed_mode,

input wire [15:0] OPm,
    input wire [15:0] OPn,

output reg [31:0] result,

output reg busy,
    output reg done,

    output wire overflow

);

    wire [16:0] partial;

    wire [15:0] magM;
    wire [15:0] magN;

    wire [31:0] nextProd;

    assign magM = (signed_mode && OPm[15]) ? (~OPm + 16'd1) : OPm;
    assign magN = (signed_mode && OPn[15]) ? (~OPn + 16'd1) : OPn;

    assign nextProd = {partial, working[15:1]};

    assign overflow = (result[31:16] != {16{result[15]}});

    reg negProd;

reg [15:0] multiplicand;
    reg [31:0] working;
    reg [4:0] steps;

always @(posedge clk or posedge reset) begin

if (reset) begin

busy <= 1'b0;
            done <= 1'b0;
            result <= 32'd0;
            multiplicand <= 16'd0;
            working <= 32'd0;
            steps <= 5'd0;

            negProd <= 1'b0;
        
        end else begin

            done <= 1'b0;

            if (start && !busy) begin

multiplicand <= magM;
                working <= {16'd0, magN}; 

steps <= 5'd16; 

busy <= 1'b1;
                done <= 1'b0;

                negProd <= signed_mode && (OPm[15] ^ OPn[15]);

            end else if (busy) begin

                working <= {partial, working[15:1]};
                steps <= steps - 1'b1;
            
                if (steps == 5'b1) begin

                busy <= 1'b0;
                done <= 1'b1;

                result <= negProd ? (~nextProd + 32'd1) : nextProd;

                end

            end

        end

    end

    assign partial = working[0] ? ({1'b0, working[31:16]} + {1'b0, multiplicand}) : {1'b0, working[31:16]};

endmodule
