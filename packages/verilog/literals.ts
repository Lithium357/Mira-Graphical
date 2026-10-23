// SPDX-License-Identifier: GPL-3.0-only
/** Deliberately excludes signed, unknown (x/z), unsized based and four-state literals. */
export function literalWidth(text: string): number {
  if (/^'[01]$/.test(text)) return 1;
  const sized = /^([0-9][0-9_]*)'([bBoOdDhH])([0-9a-fA-F][0-9a-fA-F_]*)$/.exec(text);
  if (!sized) {
    if (!/^[0-9][0-9_]*$/.test(text) || BigInt(text.replaceAll('_', '')) > 2147483647n)
      throw new Error(
        'Use an unsigned decimal integer or a sized binary/octal/decimal/hex literal.',
      );
    return 32;
  }
  const width = Number(sized[1].replaceAll('_', ''));
  const digits = sized[3].replaceAll('_', '');
  const base = sized[2].toLowerCase();
  if (!Number.isSafeInteger(width) || width < 1 || width > 4096 || digits.length > 4096)
    throw new Error('Literal width must be between 1 and 4096 bits.');
  if (!{ b: /^[01]+$/, o: /^[0-7]+$/, d: /^[0-9]+$/, h: /^[0-9a-f]+$/i }[base]!.test(digits))
    throw new Error('Digit is invalid for the literal base.');
  const value = BigInt(
    (base === 'b' ? '0b' : base === 'o' ? '0o' : base === 'h' ? '0x' : '') + digits,
  );
  if (value >> BigInt(width))
    throw new Error(
      'Literal value exceeds its declared width; explicit truncation is unsupported.',
    );
  return width;
}
