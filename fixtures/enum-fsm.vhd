-- SPDX-License-Identifier: GPL-3.0-only
library ieee;
use ieee.std_logic_1164.all;
entity enum_fsm is
  port (clk, reset, start, finish : in std_logic; busy, done : out std_logic);
end entity;
architecture rtl of enum_fsm is
  type state_t is (idle, running, finished);
  signal state, next_state : state_t;
begin
  process(all)
  begin
    next_state <= state;
    busy <= '0';
    done <= '0';
    case state is
      when idle =>
        if start = '1' then next_state <= running; end if;
      when running =>
        busy <= '1';
        if finish = '1' then next_state <= finished; end if;
      when finished =>
        done <= '1';
        if start = '0' then next_state <= idle; end if;
      when others => next_state <= idle;
    end case;
  end process;
  process(clk, reset)
  begin
    if reset = '1' then state <= idle;
    elsif rising_edge(clk) then state <= next_state;
    end if;
  end process;
end architecture;
