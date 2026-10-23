library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity arithmetic is
    port (a, b : in unsigned(7 downto 0); result : out unsigned(7 downto 0));
end entity arithmetic;
architecture rtl of arithmetic is
begin
    -- Preserve this comment when editing the operator.
    result <= a + b;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity workbench is
    port (a, b : in unsigned(7 downto 0); select_b : in std_logic;
          result : out unsigned(7 downto 0); joined, product : out unsigned(15 downto 0));
end entity workbench;
architecture rtl of workbench is
    signal sum : unsigned(7 downto 0);
begin
    add_stage : entity work.arithmetic port map (a => a, b => b, result => sum);
    joined <= a & b;
    product <= a * b;
    process(all)
    begin
        if select_b = '1' then
            result <= sum;
        else
            result <= a;
        end if;
    end process;
end architecture rtl;
