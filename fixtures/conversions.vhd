library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity conversions is
    port (bit_in : in std_logic; vector_in : in std_logic_vector(0 to 7);
          unsigned_in : in unsigned(7 downto 0); scalar_result : out std_logic;
          vector_result : out std_logic_vector(3 downto 0);
          unsigned_result : out unsigned(7 downto 0);
          scalar_vector : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of conversions is
begin
end architecture;
