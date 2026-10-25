-- SPDX-License-Identifier: GPL-3.0-only
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity clocked_counter is
  port(clk,reset,en: in std_logic; q: out unsigned(7 downto 0));
end entity;
architecture rtl of clocked_counter is
begin
  counter: process(clk,reset)
  begin
    if reset = '1' then
      q <= to_unsigned(0,8);
    elsif rising_edge(clk) then
      if en = '1' then
        q <= q + to_unsigned(1,8);
      end if;
    end if;
  end process counter;
end architecture;
