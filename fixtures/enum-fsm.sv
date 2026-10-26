// SPDX-License-Identifier: GPL-3.0-only
module enum_fsm (
    input logic clk, reset, start, finish,
    output logic busy, done,
    output wire [1:0] state_code
);
    typedef enum logic [1:0] { IDLE = 2'b00, RUN, DONE = 2'b11 } state_t;
    state_t state, next_state;

    always_comb begin
        next_state = state;
        busy = 1'b0;
        done = 1'b0;
        case (state)
            IDLE: if (start) next_state = RUN;
            RUN: begin
                busy = 1'b1;
                if (finish) next_state = DONE;
            end
            DONE: begin
                done = 1'b1;
                if (!start) next_state = IDLE;
            end
            default: next_state = IDLE;
        endcase
    end

    always_ff @(posedge clk or posedge reset)
        if (reset) state <= IDLE;
        else state <= next_state;

    assign state_code = state;
endmodule
